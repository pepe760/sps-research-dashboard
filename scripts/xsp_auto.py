"""Unattended XSP daily capture and quote-only repricing from a licensed feed.

The existing desk decides whether a frozen spread passes the research gates.
This module captures only a point-in-time 09:45 ET selection; it never backfills
an outage with a newer chain and never submits a trade.
"""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from math import fsum
import os
from pathlib import Path
import sqlite3
from threading import Lock
from typing import Callable
from zoneinfo import ZoneInfo

from refresh import enabled, iso, number, timestamp

ET = ZoneInfo("America/New_York")
LABEL = "Massive Business"
REVIEW_WINDOW = time(9, 45)
REVIEW_END = time(9, 46)
QUOTE_START = time(10, 45)
NORMAL_STOP = time(16, 0)
EARLY_STOP = time(13, 0)
MAX_QUOTE_AGE = 90
MAX_QUOTE_SKEW = 15
HISTORY_POLL = timedelta(minutes=30)
HISTORY_RETRY = timedelta(minutes=2)
FIRST_DAY = date(2026, 1, 1)
LAST_DAY = date(2027, 12, 31)
# Cboe C1 US Options RTH only. A native XSP chain is also required.
# https://www.cboe.com/about/hours/us-options/
CLOSED = frozenset(map(date.fromisoformat, (
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
)))
EARLY = frozenset(map(date.fromisoformat, ("2026-11-27", "2026-12-24", "2027-11-26")))
FIELDS = ("entry_date", "expiry", "selection_as_of", "short_strike", "long_strike", "delta")


def is_session(day: date) -> bool:
    return FIRST_DAY <= day <= LAST_DAY and day.weekday() < 5 and day not in CLOSED


def nearby_session(day: date, direction: int) -> date | None:
    if not is_session(day) or direction not in (-1, 1):
        return None
    for offset in range(1, 8):
        value = day + timedelta(days=offset * direction)
        if not FIRST_DAY <= value <= LAST_DAY:
            return None
        if is_session(value):
            return value
    return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _state_db(path: Path):
    # State contains option selections. Never stage it under public Pages.
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)
    if os.name == "posix" and path.stat().st_mode & 0o077:
        raise PermissionError("automatic selection state must be private (0600)")
    db = sqlite3.connect(path, timeout=1)
    try:
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE IF NOT EXISTS selections ("
                   "entry_date TEXT PRIMARY KEY, expiry TEXT NOT NULL, selection_as_of TEXT NOT NULL, "
                   "short_strike REAL NOT NULL, long_strike REAL NOT NULL, delta REAL NOT NULL)")
        return db
    except BaseException:
        db.close()
        raise


def _stored(path: Path, entry: date, expiry: date) -> dict | None:
    with closing(_state_db(path)) as db:
        row = db.execute("SELECT * FROM selections WHERE entry_date = ?", (entry.isoformat(),)).fetchone()
    if row is None or row["expiry"] != expiry.isoformat():
        return None
    # A corrupted or incompatible state file must not generate candidates.
    try:
        at = timestamp(row["selection_as_of"]).astimezone(ET)
        valid = (at.date() == entry and REVIEW_WINDOW <= at.time() < REVIEW_END and
                 number(row["short_strike"]) and number(row["long_strike"]) and
                 _strike(row["short_strike"]) - _strike(row["long_strike"]) == 15 and
                 _valid_delta(row["delta"]))
    except (TypeError, ValueError, ArithmeticError):
        return None
    return dict(row) if valid else None


def _store(path: Path, item: dict):
    with closing(_state_db(path)) as db, db:
        db.execute("INSERT OR IGNORE INTO selections VALUES (?,?,?,?,?,?)", tuple(item[f] for f in FIELDS))


def _valid_delta(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and -.15 <= x <= -.05


def _strike(x) -> Decimal:
    return Decimal(str(x)).quantize(Decimal(".0001"))


def _book(rows, expiry: date, receipt: datetime, *, min_clock: time) -> dict:
    by_strike, duplicates = {}, set()
    if not isinstance(rows, list) or len(rows) > 1500:
        return {}
    et = receipt.astimezone(ET)
    for row in rows:
        if not isinstance(row, dict) or row.get("expiry") != expiry.isoformat() or row.get("type") != "put":
            continue
        if row.get("feed_mode") != "real_time" or row.get("timestamp_basis") not in ("exchange", "provider_event"):
            continue
        k, bid, ask = (row.get(f) for f in ("strike", "bid", "ask"))
        if not number(k) or k > 100_000 or not number(bid, zero=True) or not number(ask) or bid > ask:
            continue
        try:
            stamp = timestamp(row.get("as_of"))
            source_et = stamp.astimezone(ET)
        except (ValueError, TypeError, OverflowError):
            continue
        if (source_et.date() != et.date() or source_et.time() < min_clock or
                not 0 <= (receipt-stamp).total_seconds() <= MAX_QUOTE_AGE):
            continue
        key = _strike(k)
        if key in by_strike:
            duplicates.add(key)
        else:
            by_strike[key] = {"strike":float(key), "bid":bid, "ask":ask, "delta":row.get("delta"), "at":stamp}
    for key in duplicates:
        del by_strike[key]
    return by_strike


def _paired(book: dict, short: Decimal, long: Decimal) -> tuple | None:
    a, b = book.get(short), book.get(long)
    if not a or not b or abs((a["at"]-b["at"]).total_seconds()) > MAX_QUOTE_SKEW:
        return None
    credit = a["bid"] - b["ask"]
    if not 0 < credit < 15:
        return None
    return a, b


def _freeze(rows, entry: date, expiry: date, receipt: datetime) -> dict | None:
    """Choose the nearest valid short then require its specific listed wing."""
    et = receipt.astimezone(ET)
    if et.date() != entry or not REVIEW_WINDOW <= et.time() < REVIEW_END:
        return None
    book = _book(rows, expiry, receipt, min_clock=time(9, 30))
    candidates = [k for k, r in book.items() if r["bid"] >= .05 and _valid_delta(r["delta"])]
    if not candidates:
        return None
    short = min(candidates, key=lambda k: (round(abs(book[k]["delta"]+.10),10), -book[k]["bid"], k))
    long = short - 15
    if not _paired(book, short, long):
        return None
    return {"entry_date":entry.isoformat(), "expiry":expiry.isoformat(), "selection_as_of":iso(receipt),
            "short_strike":float(short), "long_strike":float(long), "delta":book[short]["delta"]}


def _quote(rows, selection: dict, expiry: date, receipt: datetime, close: time) -> dict | None:
    et = receipt.astimezone(ET)
    if et.date().isoformat() != selection["entry_date"] or not QUOTE_START <= et.time() < close:
        return None
    book = _book(rows, expiry, receipt, min_clock=QUOTE_START)
    pair = _paired(book, _strike(selection["short_strike"]), _strike(selection["long_strike"]))
    if not pair:
        return None
    a, b = pair
    return {**selection, "as_of":iso(max(a["at"],b["at"])), "short_quote_as_of":iso(a["at"]),
            "long_quote_as_of":iso(b["at"]), "short_bid":a["bid"], "short_ask":a["ask"],
            "long_bid":b["bid"], "long_ask":b["ask"], "verified_next_session":True,
            "feed_mode":"real_time", "timestamp_basis":"provider_event"}


def _lane(status, feed=None, *, reason=None):
    return {"status":status, "feed":feed, "source":LABEL if status=="connected" else None, "reason":reason}


def _bars(raw, before: date) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > 1000:
        return []
    found={}
    for item in raw:
        if not isinstance(item, dict) or item.get("complete") is not True or not number(item.get("close")):
            continue
        try:
            d=date.fromisoformat(item["date"])
        except (KeyError, TypeError, ValueError):
            continue
        if d>=before or d.weekday()>=5 or d in CLOSED:
            continue
        if d in found:
            return []
        found[d]={"date":d.isoformat(), "close":item["close"], "complete":True}
    return [found[k] for k in sorted(found)[-400:]]


def _history_object(bars: list[dict]) -> dict:
    d=date.fromisoformat(bars[-1]["date"])
    at=datetime.combine(d,time(13,15) if d in EARLY else time(16,15),ET)
    return {"bars":bars, "as_of":iso(at)}


class Collector:
    def __init__(self, provider, path, *, clock: Callable[[], datetime] = _now, history_enabled=False):
        self.provider = provider
        self.path = Path(path)
        if not self.path.is_absolute():
            raise ValueError("SPS_XSP_STATE_PATH must be absolute")
        self.clock=clock
        self.history_enabled=history_enabled
        self._history={}
        self._history_expiry={}
        self._lock=Lock()

    def _options(self, now: datetime) -> dict:
        et=now.astimezone(ET)
        day=et.date()
        expiry=nearby_session(day,1)
        if expiry is None:
            return _lane("connected", {"entries":{}}, reason="no_regular_session")
        close=EARLY_STOP if day in EARLY else NORMAL_STOP
        hm=et.time()
        # Never let index/history requests precede the already-due tight capture.
        if not (REVIEW_WINDOW <= hm < REVIEW_END or QUOTE_START <= hm < close):
            return _lane("connected", {"entries":{}}, reason="outside_capture_or_pricing_window")
        try:
            saved=_stored(self.path,day,expiry)
            if REVIEW_WINDOW <= hm < REVIEW_END:
                if not saved:
                    rows=self.provider.options(expiry.isoformat())
                    selected=_freeze(rows,day,expiry,self.clock())
                    if selected:
                        _store(self.path,selected)
                        saved=_stored(self.path,day,expiry)
                return _lane("connected", {"entries":{}}, reason="selection_saved" if saved else "selection_not_available")
            if not saved:
                return _lane("connected", {"entries":{}}, reason="no_0945_selection")
            get_pair=getattr(self.provider,"option_pair",None)
            rows=(get_pair(expiry.isoformat(),(saved["short_strike"],saved["long_strike"])) if callable(get_pair)
                  else self.provider.options(expiry.isoformat()))
            paired=_quote(rows,saved,expiry,self.clock(),close)
            return _lane("connected", {"entries":{"XSP":paired} if paired else {}},
                         reason=None if paired else "missing_fresh_matching_legs")
        except Exception:
            return _lane("unavailable", reason="options_request_or_state_unavailable")

    def _market(self, now: datetime) -> dict:
        day=now.astimezone(ET).date()
        market_ok=False
        try:
            raw=self.provider.market()
            market_ok=isinstance(raw,dict)
            inst={k:dict(raw[k]) for k in ("XSP","SPX","VIX") if market_ok and isinstance(raw.get(k),dict)}
        except Exception:
            inst={}
        hist={}
        hm=self.clock().astimezone(ET).time()
        if self.history_enabled:
            # Do not start slow history requests immediately before or during the 09:45 sample.
            if not time(9,42) <= hm < time(9,47):
                for symbol, lookback in (("SPX",440), ("VIX",110)):
                    if self._history_expiry.get(symbol,now)<=now:
                        result=[]
                        try:
                            result=_bars(self.provider.history(symbol,(day-timedelta(days=lookback)).isoformat(),
                                                               (day-timedelta(days=1)).isoformat()),day)
                        except Exception:
                            pass
                        self._history_expiry[symbol]=now+(HISTORY_POLL if result else HISTORY_RETRY)
                        if result:
                            self._history[symbol]=result
            hist={k:_history_object(v) for k,v in self._history.items() if len(v)>=2}
            spx=self._history.get("SPX",[])
            previous=nearby_session(day,-1)
            if "SPX" in inst and previous and len(spx)>=252 and spx[-1]["date"]==previous.isoformat():
                c=[r["close"] for r in spx]
                inst["SPX"].update(prior_close=c[-1],sma200=fsum(c[-200:])/200,high252_close=max(c[-252:]))
        return _lane("connected", {"instruments":inst,"history":hist}) if market_ok or hist else _lane("unavailable", reason="indices_request_unavailable")

    def lanes(self, now: datetime | None = None) -> dict:
        with self._lock:
            now=now if now is not None else self.clock()
            if now.tzinfo is None:
                raise ValueError("automatic input clock must be timezone-aware")
            options=self._options(now)
            return {"market":self._market(now),"options":options}


_DEFAULT=None
_LOCK=Lock()


def lanes(now: datetime | None = None) -> dict:
    """Serve-desk loader. No source requests until public permission is configured."""
    global _DEFAULT
    if not enabled("SPS_MASSIVE_PUBLIC_APPROVED"):
        return {k:_lane("unconfigured", reason="massive_public_permission_not_configured") for k in ("market","options")}
    key=os.environ.get("SPS_MASSIVE_API_KEY","").strip()
    path=os.environ.get("SPS_XSP_STATE_PATH","").strip()
    if not key or not Path(path).is_absolute():
        return {k:_lane("unconfigured", reason="provider_key_or_state_path_missing") for k in ("market","options")}
    try:
        with _LOCK:
            if _DEFAULT is None:
                from massive_xsp import MassiveClient
                _DEFAULT=Collector(MassiveClient(key),path,history_enabled=enabled("SPS_PUBLIC_HISTORY_APPROVED"))
            c=_DEFAULT
        return c.lanes(now)
    except Exception:
        return {k:_lane("unavailable", reason="collector_unavailable") for k in ("market","options")}
