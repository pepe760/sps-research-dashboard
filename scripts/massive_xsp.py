"""Minimal read-only Massive REST adapter for the authorized XSP collector.

This module never receives a broker account and never serves browser requests.
A caller must enable it only for an operator with the required market-data
entitlements and explicit public display/derived-data rights. Do not infer
rights from a successful API-key response.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from math import isfinite
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

API = "https://api.massive.com"
ET = ZoneInfo("America/New_York")
UTC = timezone.utc
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MIN_NS = 946684800000000000  # 2000-01-01
OPTIONS_PATH = "/v3/snapshot/options/I:XSP"
INDICES = ("I:XSP", "I:SPX", "I:VIX")
MAX_BYTES = 2_000_000
PAGE_LIMIT = 250
MAX_CHAIN_PAGES = 12


class MassiveUnavailable(RuntimeError):
    """An upstream result cannot be used. Messages never include data or tokens."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *unused, **ignored):
        return None


def as_dict(x):
    return x if isinstance(x, dict) else {}


def valid_number(x, *, zero=False):
    # Catch enormous crafted JSON integers as invalid rather than casting blindly.
    return (isinstance(x, (int, float)) and not isinstance(x, bool)
            and (0 <= x if zero else 0 < x) and x < 10_000_000 and isfinite(x))


def iso_day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("expected YYYY-MM-DD")
    return date.fromisoformat(value)


def _ns_time(value):
    if type(value) is not int or not MIN_NS <= value < MIN_NS * 5:
        return None
    return (EPOCH + timedelta(microseconds=value // 1000)).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _option_ticker(expiry, strike):
    if not valid_number(strike):
        raise ValueError("invalid option strike")
    units = Decimal(str(strike)) * 1000
    if units != units.to_integral_value() or not 1 <= units <= 99_999_999:
        raise ValueError("strike outside OSI precision or range")
    yymmdd = iso_day(expiry).strftime("%y%m%d")
    return f"O:XSP{yymmdd}P{int(units):08d}"


def _normalize_option(raw, expiry):
    if not isinstance(raw, dict):
        return None
    info = as_dict(raw.get("details"))
    quote = as_dict(raw.get("last_quote"))
    strike, bid, ask = info.get("strike_price"), quote.get("bid"), quote.get("ask")
    if (info.get("contract_type") != "put" or info.get("expiration_date") != expiry
            or info.get("exercise_style") != "european" or info.get("shares_per_contract") != 100):
        return None
    try:
        ticker = _option_ticker(expiry, strike)
    except ValueError:
        return None
    if info.get("ticker") != ticker or quote.get("timeframe") != "REAL-TIME":
        return None
    stamp = _ns_time(quote.get("last_updated"))
    if not stamp or not (valid_number(bid, zero=True) and valid_number(ask) and ask >= bid):
        return None
    delta = as_dict(raw.get("greeks")).get("delta")
    if (not isinstance(delta, (int, float)) or isinstance(delta, bool)
            or not -1 <= delta <= 0 or not isfinite(delta)):
        delta = None    # Some real hedges don't have a calculated Greek; never fabricate one.
    return {"strike": float(strike), "bid": float(bid), "ask": float(ask), "delta": delta,
            "as_of": stamp, "type": "put", "expiry": expiry, "ticker": ticker,
            "feed_mode": "real_time", "timestamp_basis": "provider_event"}


def _market_row(row):
    if not isinstance(row, dict):
        return None
    tick = row.get("ticker")
    stamp, spot, mode = _ns_time(row.get("last_updated")), row.get("value"), row.get("timeframe")
    if (tick not in INDICES or row.get("type") != "indices" or row.get("error")
            or not stamp or not valid_number(spot) or mode not in ("DELAYED", "REAL-TIME")):
        return None
    # A closed snapshot can still be marked REAL-TIME as an entitlement.
    # Preserve the source event timestamp and never advertise a closed index as live.
    live = mode == "REAL-TIME" and row.get("market_status") in ("open", "early", "late")
    return tick[2:], {"spot": float(spot), "as_of": stamp, "timestamp_basis": "provider_event",
                      "feed_mode": ("real_time" if live else "frozen" if mode == "REAL-TIME" else "delayed")}


class MassiveClient:
    def __init__(self, api_key: str, *, timeout: float = 5, clock=None):
        if (not isinstance(api_key, str) or not api_key
                or not re.fullmatch(r"[A-Za-z0-9._~+/=\-]{1,512}", api_key)):
            raise ValueError("missing or malformed Massive API key")
        if not 0 < timeout <= 20:
            raise ValueError("timeout out of bounds")
        self._key = api_key
        self._timeout = timeout
        self._clock = clock or (lambda: datetime.now(UTC))

    def _get(self, path, params=None):
        # Only internally built paths (no caller-host or response-provided URL).
        if not re.fullmatch(r"/[A-Za-z0-9:/_.\-]+", path):
            raise ValueError("invalid API path")
        request = Request(API + path + ("?" + urlencode(params) if params else ""),
                          headers={"Authorization": "Bearer " + self._key, "Accept": "application/json",
                                   "User-Agent": "SPS-XSP-Desk/1.0"})
        try:
            # A vendor redirect would risk forwarding an Authorization header.
            with build_opener(NoRedirect()).open(request, timeout=self._timeout) as response:
                body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise MassiveUnavailable("massive_response_too_large")
            obj = json.loads(body)
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise MassiveUnavailable(f"massive_http_{code}") from None
        except (URLError, TimeoutError, UnicodeError, ValueError, OSError) as exc:
            raise MassiveUnavailable("massive_request_unavailable") from None
        if not isinstance(obj, dict) or obj.get("status") != "OK":
            raise MassiveUnavailable("massive_response_unavailable")
        return obj

    @staticmethod
    def _cursor(next_url):
        if not isinstance(next_url, str) or len(next_url) > 8000:
            raise MassiveUnavailable("massive_pagination_invalid")
        try:
            p = urlsplit(next_url)
            if (p.scheme != "https" or p.netloc not in ("api.massive.com", "api.polygon.io")
                    or unquote(p.path) != OPTIONS_PATH or p.fragment):
                raise ValueError
            cursors = parse_qs(p.query, keep_blank_values=True, max_num_fields=20).get("cursor", [])
            if len(cursors) != 1 or not re.fullmatch(r"[A-Za-z0-9_\-+/=]{1,6000}", cursors[0]):
                raise ValueError
            # Rebuild the request against the fixed API host; never forward an
            # apiKey in the vendor's response or trust any different path/host.
            return cursors[0]
        except (TypeError, ValueError):
            raise MassiveUnavailable("massive_pagination_invalid") from None

    def options(self, expiry):
        """Return the full exact-expiry native XSP put book with real-time quotes."""
        iso_day(expiry)
        params = {"expiration_date": expiry, "contract_type": "put", "limit": PAGE_LIMIT,
                  "sort": "strike_price", "order": "asc"}
        out, cursors, seen = [], set(), set()
        for _ in range(MAX_CHAIN_PAGES):
            payload = self._get(OPTIONS_PATH, params)
            items = payload.get("results", [])
            if not isinstance(items, list):
                raise MassiveUnavailable("massive_option_shape")
            for item in items:
                row = _normalize_option(item, expiry)
                if row is None:
                    continue
                if row["ticker"] in seen:
                    raise MassiveUnavailable("massive_duplicate_option")
                seen.add(row["ticker"])
                out.append(row)
            if not payload.get("next_url"):
                return out
            cursor = self._cursor(payload["next_url"])
            if cursor in cursors:
                raise MassiveUnavailable("massive_pagination_loop")
            cursors.add(cursor)
            params = {"cursor": cursor}
        raise MassiveUnavailable("massive_incomplete_chain")

    def option_pair(self, expiry, strikes):
        """Refresh exactly the same two stored contracts without reselecting."""
        iso_day(expiry)
        strikes = tuple(strikes)
        if len(strikes) != 2 or strikes[0] == strikes[1]:
            raise ValueError("expected two distinct option strikes")
        tickers = tuple(_option_ticker(expiry, strike) for strike in strikes)

        def fetch(ticker):
            data = self._get(OPTIONS_PATH + "/" + ticker)
            row = _normalize_option(data.get("results"), expiry)
            return row if row is not None and row["ticker"] == ticker else None

        with ThreadPoolExecutor(max_workers=2) as pool:
            return [r for r in pool.map(fetch, tickers) if r is not None]

    def market(self):
        """Only exact native I:XSP, I:SPX and I:VIX values; no SPX/10 proxy."""
        payload = self._get("/v3/snapshot/indices", {"ticker.any_of": ",".join(INDICES), "limit": 10})
        rows = payload.get("results", [])
        if not isinstance(rows, list) or payload.get("next_url"):
            raise MassiveUnavailable("massive_index_shape")
        values = {}
        for raw in rows:
            pair = _market_row(raw)
            if pair is not None:
                symbol, record = pair
                if symbol in values:
                    raise MassiveUnavailable("massive_duplicate_index")
                values[symbol] = record
        return values

    def history(self, symbol, from_date, to_date):
        """Completed daily ET aggregate bars only; exclude today's partial bar."""
        ticker = "I:" + symbol if isinstance(symbol, str) and not symbol.startswith("I:") else symbol
        if ticker not in INDICES:
            raise ValueError("unknown native index")
        start, end = iso_day(from_date), iso_day(to_date)
        today = self._clock().astimezone(ET).date()
        end = min(end, today - timedelta(days=1))
        if start > end:
            return []
        if (end - start).days > 570:
            raise ValueError("requested daily history range too wide")
        path = f"/v2/aggs/ticker/{ticker}/range/1/day/{start.isoformat()}/{end.isoformat()}"
        result = self._get(path, {"sort": "asc", "limit": 1000})
        rows = result.get("results", [])
        if (result.get("ticker") != ticker or not isinstance(rows, list) or result.get("next_url")):
            raise MassiveUnavailable("massive_history_shape")
        output = {}
        for r in rows:
            stamp, close = as_dict(r).get("t"), as_dict(r).get("c")
            if type(stamp) is not int or not MIN_NS // 1_000_000 <= stamp < MIN_NS * 5 // 1_000_000 or not valid_number(close):
                continue
            # Massive defines date ranges and aggregate windows in Eastern.
            day = (EPOCH + timedelta(milliseconds=stamp)).astimezone(ET).date()
            if not start <= day <= end or day.weekday() > 4:
                continue
            if day in output:
                raise MassiveUnavailable("massive_duplicate_daily_bar")
            output[day] = {"date": day.isoformat(), "close": float(close), "complete": True}
        return [output[d] for d in sorted(output)]
