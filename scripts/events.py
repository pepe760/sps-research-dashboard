"""Official CPI/NFP/FOMC calendar refresh (stdlib; no brokerage access).

Current published schedule only, not a historical as-of calendar. Missing coverage
is unknown, never evidence that a day is free of events.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics"
FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
ET = ZoneInfo("America/New_York")
MONTHS = {name.lower(): i for i, names in enumerate(
    ((), ("jan", "january"), ("feb", "february"), ("mar", "march"),
     ("apr", "april"), ("may",), ("jun", "june"), ("jul", "july"),
     ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"),
     ("nov", "november"), ("dec", "december"))) for name in names}


def _deduplicate(items):
    result = {(r["date"], r["type"], r.get("time_et")): r for r in items}
    return sorted(result.values(), key=lambda r: (r["date"], r.get("time_et") or "", r["type"]))


def _property(line):
    head, sep, value = line.partition(":")
    if not sep:
        return "", {}, ""
    parts = head.split(";")
    params = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
    return parts[0].upper(), {k.upper(): v.strip('"') for k, v in params.items()}, value


def parse_bls_ics(text, source_url=BLS_URL):
    """Return (items, warnings), handling folding, timezone and canceled revisions."""
    lines = re.sub(r"\n[ \t]", "", text.replace("\r\n", "\n")).splitlines()
    if not any(s.strip().upper() == "BEGIN:VCALENDAR" for s in lines):
        raise ValueError("BLS response is not iCalendar")
    blocks, block, calendar_tz = [], None, None
    for line in lines:
        name, params, value = _property(line)
        if name == "X-WR-TIMEZONE":
            calendar_tz = value
        if name == "BEGIN" and value.upper() == "VEVENT":
            block = {}
        elif name == "END" and value.upper() == "VEVENT":
            if block is not None:
                blocks.append(block)
            block = None
        elif block is not None:
            block[name] = params, value
    latest = {}
    for i, block in enumerate(blocks):
        uid = block.get("UID", ({}, f"anonymous-{i}"))[1]
        try:
            sequence = int(block.get("SEQUENCE", ({}, "0"))[1])
        except ValueError:
            sequence = 0
        score = sequence, block.get("LAST-MODIFIED", ({}, ""))[1], i
        if uid not in latest or score > latest[uid][0]:
            latest[uid] = score, block
    items, warnings = [], []
    for _, block in latest.values():
        title = block.get("SUMMARY", ({}, ""))[1]
        title = re.sub(r"\\([nN,;\\])", lambda m: " " if m[1].lower() == "n" else m[1], title)
        kind = "CPI" if re.match(r"^Consumer Price Index(?:$|\s+for\b|:)", title, re.I) else "NFP" if re.match(r"^Employment Situation(?:$|\s+for\b|:)", title, re.I) else None
        if kind is None or block.get("STATUS", ({}, ""))[1].upper() == "CANCELLED":
            continue
        if "RRULE" in block or "RDATE" in block:
            warnings.append(f"BLS {kind}: recurring definition not expanded")
            continue
        if "DTSTART" not in block:
            warnings.append(f"BLS {kind}: missing DTSTART")
            continue
        params, raw = block["DTSTART"]
        try:
            if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", raw):
                event_day, clock = datetime.strptime(raw, "%Y%m%d").date(), None
            else:
                utc, stamp = raw.endswith("Z"), raw.removesuffix("Z")
                fmt = "%Y%m%dT%H%M%S" if len(stamp) == 15 else "%Y%m%dT%H%M"
                dt = datetime.strptime(stamp, fmt)
                tzid = params.get("TZID") or calendar_tz
                if utc:
                    dt = dt.replace(tzinfo=timezone.utc).astimezone(ET)
                elif tzid:
                    # BLS publishes its own US-Eastern VTIMEZONE identifier.
                    zone = ET if tzid in {"US-Eastern", "US/Eastern"} else ZoneInfo(tzid)
                    dt = dt.replace(tzinfo=zone).astimezone(ET)
                else:
                    warnings.append(f"BLS {kind} {raw}: timezone unknown; clock omitted")
                event_day, clock = dt.date(), dt.strftime("%H:%M") if dt.tzinfo else None
        except (ValueError, KeyError) as exc:
            warnings.append(f"BLS {kind}: invalid DTSTART {raw!r}: {exc}")
            continue
        items.append(dict(date=event_day.isoformat(), time_et=clock, type=kind,
                          title=title, source_url=source_url))
    if not {"CPI", "NFP"}.issubset({r["type"] for r in items}):
        raise ValueError("BLS calendar did not contain both CPI and Employment Situation")
    return _deduplicate(items), warnings


class _Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        return " ".join(c.text() if isinstance(c, _Node) else c for c in self.children).strip()

    def walk(self):
        yield self
        for c in self.children:
            if isinstance(c, _Node):
                yield from c.walk()

    def has_class(self, name):
        return name in self.attrs.get("class", "").split()


class _Tree(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Node(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def parse_fomc_html(text, source_url=FED_URL):
    """Final meeting day only; never infer a 14:00 time or a minutes-release date."""
    tree = _Tree()
    tree.feed(text)
    year, items, warnings = None, [], []
    for node in tree.root.walk():
        if re.fullmatch(r"h[1-6]", node.tag):
            match = re.search(r"\b(20\d{2})\s+FOMC\s+Meetings\b", node.text(), re.I)
            if match:
                year = int(match[1])
        if not node.has_class("fomc-meeting"):
            continue
        children = list(node.walk())
        month = next((n.text() for n in children if n.has_class("fomc-meeting__month")), "")
        day = next((n.text() for n in children if n.has_class("fomc-meeting__date")), "")
        body = node.text()
        if re.search(r"\bMonetary Policy Strategy Meeting\b", body, re.I):
            warnings.append(f"Fed {year} {month} {day}: strategy-only meeting excluded from policy-decision dates")
            continue
        months = re.findall(r"[A-Za-z]+", month)
        numbers = re.findall(r"\b\d{1,2}\b", day)
        try:
            end_month = MONTHS[months[-1].lower()]
            final_year = year + int(len(months) > 1 and MONTHS[months[0].lower()] > end_month)
            event_day = date(final_year, end_month, int(numbers[-1]))
        except (ValueError, TypeError, KeyError, IndexError):
            warnings.append(f"Fed: could not parse final meeting date {year} {month!r} {day!r}")
            continue
        unscheduled = bool(re.search(r"unscheduled|notation vote|conference call", body, re.I))
        title = f"FOMC final meeting day ({month} {day})"
        if unscheduled:
            title = f"FOMC unscheduled/notation event ({month} {day}); advance notice unverified"
        items.append(dict(date=event_day.isoformat(), time_et=None, type="FOMC",
                          title=title, source_url=source_url, unscheduled=unscheduled))
    if not items:
        raise ValueError("Fed calendar yielded no FOMC dates; markup may have changed")
    return _deduplicate(items), warnings


def _download(url, timeout):
    request = Request(url, headers={
        "User-Agent": "SPS-Research-Calendar/1.0 (+official-public-calendar-refresh)",
        "Accept": "text/calendar,text/html;q=0.9,*/*;q=0.1"})
    with urlopen(request, timeout=timeout) as response:
        host = response.url.split("/", 3)[2].lower()
        if host not in {"www.bls.gov", "bls.gov", "www.federalreserve.gov", "federalreserve.gov"}:
            raise ValueError("Calendar redirected outside the official publishers")
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Calendar response exceeds 2 MB")
        return raw.decode(response.headers.get_content_charset() or "utf-8", errors="strict")


def fetch_events(as_of=None, days=45, timeout=20, downloader=None):
    """Refresh official schedules, returning status/items/coverage/source hashes.

    ``as_of`` is the first included ET date, NOT past knowledge reconstruction.
    A caller may inject ``downloader(url, timeout) -> text`` for deterministic tests.
    This function never writes files; the caller decides how to persist results.
    """
    as_of = date.fromisoformat(as_of) if isinstance(as_of, str) else as_of or datetime.now(ET).date()
    if isinstance(as_of, datetime):
        as_of = as_of.astimezone(ET).date() if as_of.tzinfo is not None else as_of.date()
    if not isinstance(as_of, date) or not isinstance(days, int) or not 0 <= days <= 366:
        raise ValueError("Supply an ISO/date as_of and integer days between 0 and 366")
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ValueError("timeout must be positive")
    end = as_of + timedelta(days=days)
    fetcher = downloader or _download
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sources, items, warnings = [], [], []
    for url, parser, kinds in ((BLS_URL, parse_bls_ics, ("CPI", "NFP")),
                               (FED_URL, parse_fomc_html, ("FOMC",))):
        record = {"source_url": url, "types": list(kinds), "status": "unavailable"}
        try:
            text = fetcher(url, timeout)
            parsed, notices = parser(text, url)
            warnings.extend(notices)
            items.extend(r for r in parsed if as_of.isoformat() <= r["date"] <= end.isoformat())
            record.update(status="ok", sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                          parsed_items=len(parsed), first_event=min(r["date"] for r in parsed),
                          last_event=max(r["date"] for r in parsed))
            if any("could not parse" in s or "invalid DTSTART" in s or "not expanded" in s or "missing DTSTART" in s for s in notices):
                record["status"] = "limited"
            record["coverage_by_type"] = {}
            for kind in kinds:
                first = min(r["date"] for r in parsed if r["type"] == kind)
                last = max(r["date"] for r in parsed if r["type"] == kind)
                record["coverage_by_type"][kind] = {"first_event": first, "last_event": last}
                # No events after the final listing does NOT mean a clear gate.
                if end.isoformat() > last or as_of.isoformat() < first:
                    warnings.append(f"{kind}: requested dates exceed published event bounds {first} to {last}; missing coverage is unknown")
                    record["status"] = "limited"
        except Exception as exc:  # One source must not erase another's observations.
            record["error"] = f"{type(exc).__name__}: {str(exc)[:240]}"
            warnings.append(f"Official calendar unavailable: {url}")
        sources.append(record)
    ok = sum(s["status"] == "ok" for s in sources)
    status = "available" if ok == len(sources) else "unavailable" if all(s["status"] == "unavailable" for s in sources) else "partial"
    return {"schema_version": 1, "status": status, "checked_at": now,
            "items": _deduplicate(items), "sources": sources,
            "coverage": {"from": as_of.isoformat(), "through": end.isoformat(),
                         "timezone": "America/New_York", "historical_asof_verified": False,
                         "scheduled_calendar_complete": status == "available",
                         "unscheduled_events_predictable": False},
            "warnings": list(dict.fromkeys(warnings))}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--as-of", help="First ET date, YYYY-MM-DD; not historical-as-of reconstruction")
    cli.add_argument("--days", type=int, default=45)
    cli.add_argument("--timeout", type=float, default=20)
    args = cli.parse_args()
    print(json.dumps(fetch_events(args.as_of, args.days, args.timeout), indent=2, ensure_ascii=False))
