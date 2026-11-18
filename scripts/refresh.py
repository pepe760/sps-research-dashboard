"""Build the public, allowlisted dashboard snapshot. No brokerage access."""
from datetime import date, datetime, timedelta, timezone
from math import isfinite
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener, urlopen
from zoneinfo import ZoneInfo
import argparse
import json
import os
import tempfile

from events import fetch_events

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ("SPY", "XSP", "SPX", "VIX")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *unused, **kwargs):
        return None


def timestamp(s):
    if not isinstance(s, str) or len(s) > 40:
        raise ValueError("invalid timestamp")
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("timestamp requires timezone")
    return d


def iso(d):
    return d.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def fresh(s, now, minutes=90):
    try:
        age = now-timestamp(s)
        return -timedelta(minutes=3) <= age <= timedelta(minutes=minutes)
    except (TypeError, ValueError):
        return False


def number(x, *, zero=False):
    return isinstance(x,(int,float)) and not isinstance(x,bool) and isfinite(x) and (0<=x if zero else 0<x)


def object_or_empty(x):
    return x if isinstance(x,dict) else {}


def label_regime(prior, average, peak):
    if not (number(prior) and number(average) and number(peak) and prior<=peak):
        return None
    dd=1-prior/peak
    return "deep_bear" if dd>=.20 else "bull" if dd<.10 and prior>average else "transition"


def instrument(item, now):
    if not number(item.get("spot")) or not fresh(item.get("as_of"),now):
        return None
    out={"spot":item["spot"],"as_of":iso(timestamp(item["as_of"]))}
    for key in ("prior_close","sma200","high252_close"):
        val=item.get(key)
        out[key]=val if number(val) else None
    out["regime"]=label_regime(out["prior_close"],out["sma200"],out["high252_close"])
    return out


def entry_gate(inst, events, entry, expiry):
    if not inst or not inst["prior_close"] or not inst["sma200"]:
        return "unknown"
    if inst["prior_close"]<=inst["sma200"]:
        return "blocked_sma200"
    for e in events.get("items",[]):
        if (e["date"]==entry and e["type"]=="FOMC") or (e["date"]==expiry and e["type"] in ("FOMC","CPI","NFP")):
            return "blocked_event"
    if events.get("status")!="available" and not (events.get("status")=="partial" and (events.get("covered_through") or "")>=expiry):
        return "unknown"
    return "passes"


def candidate(symbol, i, market, events, now):
    if i.get("verified_next_session") is not True or not fresh(i.get("as_of"),now):
        return None
    try:
        d=date.fromisoformat(i["entry_date"]);e=date.fromisoformat(i["expiry"])
        selection=timestamp(i["selection_as_of"]).astimezone(ET)
        quoted=timestamp(i["as_of"]).astimezone(ET)
    except (KeyError,TypeError,ValueError):
        return None
    dt=now.astimezone(ET).date()
    hhmm=selection.strftime("%H:%M")
    if not (d==selection.date()==dt==quoted.date() and 1<=(e-d).days<=5 and d.weekday()<5 and e.weekday()<5):
        return None
    if hhmm!=("09:45" if symbol=="XSP" else "10:30") or not "10:45"<=quoted.strftime("%H:%M")<="16:00":
        return None
    short,long=i.get("short_strike"),i.get("long_strike")
    if not (number(short) and number(long) and short>long):
        return None
    width=short-long
    if (symbol=="XSP" and width!=15) or (symbol=="SPY" and not 13<=width<=17):
        return None
    delta=i.get("delta")
    if not isinstance(delta,(int,float)) or not isfinite(delta) or not -.15<=delta<=-.05:
        return None
    sb,sa,lb,la=(i.get(k) for k in ("short_bid","short_ask","long_bid","long_ask"))
    if not (number(sb) and number(sa) and number(lb,zero=True) and number(la) and sa>=sb and la>=lb):
        return None
    credit=sb-la
    if not 0<credit<width:
        return None
    gate=entry_gate(market.get("SPX" if symbol=="XSP" else "SPY"),events,d.isoformat(),e.isoformat())
    return {"symbol":symbol,"expiry":e.isoformat(),"short_strike":short,"long_strike":long,
            "delta":delta,"credit":round(credit,4),"max_loss_usd":round(100*(width-credit)+2.8,2),
            "as_of":iso(quoted),"gate":gate}


def environment_feed():
    if os.getenv("SPS_PUBLIC_FEED_APPROVED","").strip().lower()!="true":
        return None
    url=os.getenv("SPS_PUBLIC_FEED_URL","")
    p=urlsplit(url)
    if p.scheme!="https" or not p.hostname or p.username or p.password or p.fragment:
        raise ValueError("feed URL must be HTTPS without embedded credentials")
    headers={"Accept":"application/json","User-Agent":"SPS-Public-Research/1.0"}
    token=os.getenv("SPS_PUBLIC_FEED_TOKEN")
    if token:
        headers["Authorization"]="Bearer "+token
    with build_opener(NoRedirect()).open(Request(url,headers=headers),timeout=18) as f:
        b=f.read(1_000_001)
    if len(b)>1_000_000:
        raise ValueError("feed too large")
    payload=json.loads(b)
    if not isinstance(payload,dict):
        raise ValueError("feed must be a JSON object")
    return payload


def prior():
    # Published site is a store for a previous public calendar only. No auth headers.
    url=os.getenv("SPS_PREVIOUS_SNAPSHOT","")
    p=urlsplit(url)
    if p.scheme!="https" or not (p.hostname or "").endswith(".github.io") or p.username or p.password:
        return None
    try:
        with urlopen(Request(url,headers={"Accept":"application/json"}),timeout=10) as f:
            b=f.read(250001)
        if len(b)>250000:
            return None
        return json.loads(b)
    except Exception:
        return None


def sanitized_events(x):
    x=object_or_empty(x)
    items=[]
    for r in x.get("items",[]):
        if not isinstance(r,dict) or r.get("type") not in ("FOMC","CPI","NFP"):
            continue
        try:
            d=date.fromisoformat(r["date"]).isoformat()
            src=urlsplit(r["source_url"])
            if src.scheme!="https" or src.hostname not in ("www.bls.gov","www.federalreserve.gov"):
                continue
            tm=r.get("time_et")
            if tm is not None:
                tm=datetime.strptime(tm,"%H:%M").strftime("%H:%M")
            items.append({"date":d,"time_et":tm,"type":r["type"],"title":str(r["title"])[:110],"source_url":r["source_url"]})
        except (ValueError,TypeError,KeyError):
            continue
    out={k:x[k] for k in ("status","checked_at","data_as_of") if k in x}
    out["status"]=out.get("status","unavailable")
    # A valid next-session check can be available even when the 45-day display
    # runs beyond the agency's last known publication. Parsing errors fail closed.
    warnings=x.get("warnings",[])
    parsed=x.get("sources",[])
    problematic=("could not parse","invalid DTSTART","not expanded","missing DTSTART","timezone unknown")
    all_kinds={}
    if len(parsed)==2 and not any(any(k in s for k in problematic) for s in warnings):
        for src in parsed:
            for kind,r in src.get("coverage_by_type",{}).items():
                day=r.get("last_event")
                if isinstance(day,str):
                    all_kinds[kind]=date.fromisoformat(day).isoformat()
    if set(all_kinds)=={"CPI","NFP","FOMC"}:
        out["covered_through"]=min(all_kinds.values())
        public_sources=[]
        for src in parsed:
            if src.get("source_url") in ("https://www.bls.gov/schedule/news_release/bls.ics","https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"):
                public_sources.append({k:src[k] for k in ("source_url","sha256","status") if k in src})
        out["sources"]=public_sources
    out["items"]=sorted(items,key=lambda r:(r["date"],r["time_et"] or "",r["type"]))[:100]
    return out


def snapshot(now, events, feed=None, *, configured=False, previous=None, source=None):
    ev=sanitized_events(events)
    old=sanitized_events(object_or_empty(previous).get("events"))
    if ev["status"]!="available" and not ev.get("covered_through") and old["status"] in ("available","partial","stale") and old["items"]:
        ev={"status":"stale","checked_at":ev.get("checked_at"),"data_as_of":old.get("data_as_of") or old.get("checked_at"),"items":old["items"]}
    market,candidates={},[]
    if feed is not None:
        items=object_or_empty(feed.get("instruments"))
        for s in SYMBOLS:
            if x:=instrument(object_or_empty(items.get(s)),now):
                market[s]=x
        each=object_or_empty(feed.get("entries"))
        for s in ("SPY","XSP"):
            if c:=candidate(s,object_or_empty(each.get(s)),market,ev,now):
                candidates.append(c)
    m_status="available" if market else "stale" if configured else "unconfigured"
    c_status="available" if candidates else "unavailable" if configured else "unconfigured"
    return {"schema_version":1,"checked_at":iso(now),
            "market":{"status":m_status,"as_of":max((r["as_of"] for r in market.values()),default=None),
                      "source":str(source)[:80] if market and source else None,"instruments":market},
            "events":ev,"candidates":{"status":c_status,"as_of":max((r["as_of"] for r in candidates),default=None),"items":candidates}}


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--output",type=Path,default=ROOT/"site/data/status.json")
    v=cli.parse_args()
    now=datetime.now(timezone.utc)
    try:
        events=fetch_events(as_of=now)
    except Exception:
        events={"status":"unavailable","checked_at":iso(now),"items":[]}
    configured=os.getenv("SPS_PUBLIC_FEED_APPROVED","").strip().lower()=="true"
    try:
        data=environment_feed()
    except Exception:
        # No credentials, body, URL, or traceback published on lookup failure.
        print("Numerical feed unavailable; publishing without live candidates.")
        data=None
    previous=prior() if events.get("status")!="available" else None
    public=snapshot(now,events,data,configured=configured,previous=previous,source=os.getenv("SPS_PUBLIC_FEED_LABEL"))
    v.output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=v.output.parent,delete=False) as f:
        json.dump(public,f,ensure_ascii=False,indent=2,allow_nan=False)
        f.write("\n")
    Path(f.name).replace(v.output)
    print(f'Calendar: {public["events"]["status"]}; market: {public["market"]["status"]}; candidates: {len(public["candidates"]["items"])}')


if __name__=="__main__":
    main()
