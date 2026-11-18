"""Serve only the validated public XSP desk through a local HTTPS proxy."""
from __future__ import annotations

import argparse
from contextlib import suppress
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import BoundedSemaphore, Event, Lock, Thread
from time import monotonic

from events import fetch_events
from refresh import enabled, environment_lanes, snapshot


BIND = "127.0.0.1"
SITE_ORIGIN = "https://pepe760.github.io"
PATH = "/desk.json"
LANE_MAX_AGE_SECONDS = 60
EVENT_POLL_SECONDS = 1800
EVENT_MAX_AGE_SECONDS = 3600
MAX_RESPONSE_BYTES = 250_000


def unavailable_lanes():
    return {name: {"status": "unavailable", "feed": None, "source": None}
            for name in ("market", "options")}


def utcnow():
    return datetime.now(timezone.utc)


class DeskState:
    """Two bounded background workers; HTTP requests never poll a vendor."""

    def __init__(self, poll_seconds=12, *, lane_loader=environment_lanes,
                 event_loader=fetch_events, clock=utcnow, timer=monotonic,
                 snapshot_builder=snapshot):
        if not isinstance(poll_seconds, int) or not 5 <= poll_seconds <= 30:
            raise ValueError("poll seconds must be in 5..30")
        self.poll_seconds = poll_seconds
        self.lane_loader = lane_loader
        self.event_loader = event_loader
        self.clock = clock
        self.timer = timer
        self.snapshot_builder = snapshot_builder
        self._lock = Lock()
        self._stop = Event()
        self._lanes = (None, unavailable_lanes())
        self._events = (None, None)
        self._workers = []

    def refresh_lanes(self):
        try:
            lanes = self.lane_loader()
        except Exception:
            # Never pass upstream exception bodies or request credentials to clients.
            lanes = unavailable_lanes()
        with self._lock:
            self._lanes = (self.timer(), lanes)

    def refresh_events(self):
        try:
            events = self.event_loader(as_of=self.clock(), timeout=8)
        except Exception:
            events = None
        with self._lock:
            self._events = (self.timer(), events)

    def _refresh_loop(self, refresh, seconds):
        while not self._stop.is_set():
            refresh()
            # Sleep after completion, so a slow upstream does not create a backlog.
            self._stop.wait(seconds)

    def start(self):
        if self._workers:
            return
        for method, seconds in ((self.refresh_lanes, self.poll_seconds),
                                (self.refresh_events, EVENT_POLL_SECONDS)):
            worker = Thread(target=self._refresh_loop, args=(method, seconds), daemon=True)
            worker.start()
            self._workers.append(worker)

    def stop(self):
        self._stop.set()
        for worker in self._workers:
            worker.join(timeout=0.25)

    def payload(self):
        with self._lock:
            (lane_at, lanes), (event_at, events) = self._lanes, self._events
        now_tick = self.timer()
        if lane_at is None or now_tick - lane_at > LANE_MAX_AGE_SECONDS:
            lanes = unavailable_lanes()
        if event_at is None or now_tick - event_at > EVENT_MAX_AGE_SECONDS or not isinstance(events, dict):
            events = {"status": "unavailable", "items": []}
        # Freshness is recalculated from actual source timestamps on each request.
        # The request timestamp never upgrades a cached quote to a live quote.
        public = self.snapshot_builder(
            self.clock(), events, lanes=lanes,
            history_approved=enabled("SPS_PUBLIC_HISTORY_APPROVED"),
        )
        return {key: public[key] for key in ("checked_at", "desk", "events")}


class DeskServer(ThreadingHTTPServer):
    """Bound the local HTTP process; a TLS reverse proxy is the public entry."""

    allow_reuse_address = True
    request_queue_size = 16
    daemon_threads = True

    def __init__(self, address, state):
        if address[0] != BIND:
            raise ValueError("serve_desk only binds to IPv4 loopback")
        self.state = state
        self._slots = BoundedSemaphore(16)
        super().__init__(address, DeskHandler)

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(4)
        return sock, address

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        # A caller disconnecting/errors must not print provider/request details.
        pass


class DeskHandler(BaseHTTPRequestHandler):
    server_version = "SPSDesk"
    sys_version = ""

    def log_message(self, format, *args):
        pass

    def _write(self, status, body=b"", extra_headers=None):
        self.send_response(status)
        if self.headers.get("Origin") == SITE_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", SITE_ORIGIN)
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD":
            with suppress(OSError):
                self.wfile.write(body)

    def _allowed(self):
        if self.path.split("?", 1)[0] != PATH:
            self._write(404)
            return False
        origin = self.headers.get("Origin")
        if origin not in (None, SITE_ORIGIN):
            self._write(403)
            return False
        return True

    def do_GET(self):
        if not self._allowed():
            return
        try:
            body = json.dumps(self.server.state.payload(), ensure_ascii=False,
                              allow_nan=False, separators=(",", ":")).encode("utf-8")
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("response limit")
        except Exception:
            self._write(503, b'{"error":"desk_unavailable"}')
            return
        self._write(200, body)

    do_HEAD = do_GET

    def do_OPTIONS(self):
        if not self._allowed():
            return
        requested = self.headers.get("Access-Control-Request-Method")
        if requested not in (None, "GET", "HEAD") or self.headers.get("Access-Control-Request-Headers"):
            self._write(403)
            return
        self._write(204, extra_headers={"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--poll-seconds", type=int, choices=range(5, 31), default=12)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be in 1..65535")
    state = DeskState(args.poll_seconds)
    with DeskServer((BIND, args.port), state) as server:
        state.start()
        print(f"SPS desk listening on http://{BIND}:{args.port}{PATH}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            state.stop()


if __name__ == "__main__":
    main()
