"""Build the public, allowlisted dashboard snapshot. No brokerage access."""
from datetime import date, datetime, timedelta, timezone
from math import fsum, isfinite
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener, urlopen
from zoneinfo import ZoneInfo
import argparse
import json
import os
import re
import tempfile

from events import fetch_events
from watchlist import snapshot as watchlist_snapshot

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ("SPY", "XSP", "SPX", "VIX")
CHART_SYMBOLS = ("SPX", "VIX")


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


def chart_series(item, now):
    """Compute session-based averages before trimming the public viewing range."""
    try:
        stamp = timestamp(item.get("as_of"))
    except (TypeError, ValueError):
        return None
    if stamp > now+timedelta(minutes=3):
        return None
    et=now.astimezone(ET)
    bars = item.get("bars")
    if not isinstance(bars,list) or not 2<=len(bars)<=420:
        return None
    prices={}
    for r in bars:
        if not isinstance(r,dict) or not number(r.get("close")):
            return None
        try:
            d=date.fromisoformat(r["date"])
        except (KeyError,TypeError,ValueError):
            return None
        if d>et.date() or d in prices or d.weekday()>4:
            return None
        # Never use an unfinished US regular-session bar as a historical close.
        if d==et.date() and (et.strftime("%H:%M")<"16:15" or r.get("complete") is not True):
            continue
        prices[d]=r["close"]
    days=sorted(prices)
    if len(days)<2 or days[-1]>stamp.astimezone(ET).date():
        return None
    values=[prices[d] for d in days]
    out=[]
    for i,d in enumerate(days):
        if (days[-1]-d).days>100:
            continue
        point={"date":d.isoformat(),"close":values[i]}
        for n in (20,50,200):
            point[f"sma{n}"]=round(fsum(values[i+1-n:i+1])/n,6) if i+1>=n else None
        out.append(point)
    return {"series":out,"as_of":iso(stamp),"last_close_date":days[-1].isoformat(),
            "stale":(et.date()-days[-1]).days>4 or now-stamp>timedelta(days=4)}


def chart_snapshot(feed, now, approved, source):
    raw=object_or_empty(object_or_empty(feed).get("history"))
    rows={s:v for s in CHART_SYMBOLS if approved and (v:=chart_series(object_or_empty(raw.get(s)),now))}
    current=bool(rows) and all(not v["stale"] for v in rows.values())
    return {"status":"available" if current else "stale" if rows else "unavailable" if approved else "unconfigured",
            "source":str(source)[:80] if source and rows else None,
            "as_of":min((v["as_of"] for v in rows.values()),default=None),
            "series":{s:v["series"] for s,v in rows.items()},
            "last_close_dates":{s:v["last_close_date"] for s,v in rows.items()}}


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
    ref=market.get(symbol,{}).get("spot")
    return {"symbol":symbol,"entry_date":d.isoformat(),"expiry":e.isoformat(),"short_strike":short,"long_strike":long,
            "delta":delta,"short_bid":sb,"short_ask":sa,"long_bid":lb,"long_ask":la,
            "credit":round(credit,4),"natural_close_debit":round(sa-lb,4),"max_loss_usd":round(100*(width-credit)+2.8,2),
            "max_profit_usd":round(100*credit-2.8,2),"break_even":round(short-credit+.028,4),
            "width":round(width,4),"distance_pct":round((1-short/ref)*100,3) if number(ref) else None,
            "as_of":iso(quoted),"selection_as_of":iso(selection),"gate":gate}


def valid_chain_puts(rows, expiry):
    """Normalize a same-expiry put book and reject ambiguous duplicate strikes."""
    if not isinstance(rows,list) or not 1<=len(rows)<=1500:
        return {}
    out={}
    for r in rows:
        if not isinstance(r,dict) or r.get("type")!="put" or r.get("expiry")!=expiry:
            continue
        k,b,a=r.get("strike"),r.get("bid"),r.get("ask")
        if not(number(k) and number(b,zero=True) and number(a) and b<=a):
            continue
        if k in out:
            return {}
        out[k]=(b,a,r.get("delta"))
    return out


def select_chain(symbol,i):
    """Freeze strikes at the selection snapshot; use later quotes only to price them."""
    expiry=i.get("expiry")
    frozen=valid_chain_puts(i.get("selection_puts"),expiry)
    quoted=valid_chain_puts(i.get("quote_puts"),expiry)
    targets=[k for k,(b,a,x) in frozen.items() if b>0 and isinstance(x,(int,float)) and not isinstance(x,bool) and isfinite(x) and -.15<=x<=-.05]
    if not targets:
        return {}
    short=min(targets,key=lambda k:(round(abs(frozen[k][2]+.10),10),-frozen[k][0],k))
    longs=[k for k in frozen if (short-k==15 if symbol=="XSP" else 13<=short-k<=17)]
    if not longs:
        return {}
    long=min(longs,key=lambda k:(abs(short-k-15),k))
    if short not in quoted or long not in quoted:
        return {}
    return {**i,"short_strike":short,"long_strike":long,"delta":frozen[short][2],
            "short_bid":quoted[short][0],"short_ask":quoted[short][1],"long_bid":quoted[long][0],"long_ask":quoted[long][1]}


def enabled(name):
    return os.getenv(name, "").strip().lower() == "true"


def private_marker(value):
    return bool(re.search(r"\b(?:ibkr|interactive\s*brokers|private|personal)\b", str(value), re.I))


def fetch_public_feed(prefix, *, require_distribution=False):
    """Read only a source deliberately configured for public redistribution."""
    url=os.getenv(prefix+"_URL", "").strip()
    p=urlsplit(url)
    if p.scheme!="https" or not p.hostname or p.username or p.password or p.fragment:
        raise ValueError("feed URL must be HTTPS without embedded credentials")
    if private_marker(os.getenv(prefix+"_LABEL", "")):
        raise ValueError("private brokerage feed not eligible for public output")
    headers={"Accept":"application/json","User-Agent":"SPS-Public-Research/1.0"}
    token=os.getenv(prefix+"_TOKEN")
    if token:
        headers["Authorization"]="Bearer "+token
    with build_opener(NoRedirect()).open(Request(url,headers=headers),timeout=18) as f:
        b=f.read(1_000_001)
    if len(b)>1_000_000:
        raise ValueError("feed too large")
    payload=json.loads(b)
    if not isinstance(payload,dict):
        raise ValueError("feed must be a JSON object")
    if payload.get("private") is True or any(private_marker(payload.get(k, "")) for k in ("source", "provider", "distribution", "visibility", "scope")):
        raise ValueError("explicit private or brokerage payload rejected")
    if require_distribution and payload.get("distribution") != "public":
        raise ValueError("dedicated public feeds must declare distribution public")
    return payload


def environment_feed():
    """Original combined feed entry point."""
    return fetch_public_feed("SPS_PUBLIC_FEED") if enabled("SPS_PUBLIC_FEED_APPROVED") else None


def environment_lanes():
    """Fetch independently approved lanes, at most one request per endpoint configuration."""
    specs={"market":("instruments","history"),"options":("entries","chains")}
    result={}
    cache={}
    for lane, keys in specs.items():
        explicit="SPS_PUBLIC_"+lane.upper()
        dedicated=any(os.getenv(explicit+"_"+k, "").strip() for k in ("APPROVED","URL","LABEL","TOKEN"))
        prefix=explicit if dedicated else "SPS_PUBLIC_FEED"
        approved=enabled(prefix+"_APPROVED")
        if not approved:
            result[lane]={"status":"unconfigured","feed":None,"source":None}
            continue
        if prefix not in cache:
            try:
                cache[prefix]=fetch_public_feed(prefix,require_distribution=dedicated)
            except Exception:
                # Never emit an upstream URL, private response body, credential, or traceback.
                cache[prefix]=None
        data=cache[prefix]
        result[lane]={"status":"connected" if data is not None else "unavailable",
                      "feed":{k:data[k] for k in keys if k in data} if data is not None else None,
                      "source":os.getenv(prefix+"_LABEL") if data is not None else None}
    return result


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


def snapshot(now, events, feed=None, *, configured=False, previous=None, source=None, history_approved=False, lanes=None):
    ev=sanitized_events(events)
    old=sanitized_events(object_or_empty(previous).get("events"))
    if ev["status"]!="available" and not ev.get("covered_through") and old["status"] in ("available","partial","stale") and old["items"]:
        ev={"status":"stale","checked_at":ev.get("checked_at"),"data_as_of":old.get("data_as_of") or old.get("checked_at"),"items":old["items"]}
    if lanes is None:
        # Preserve the combined-feed call convention for existing integrations.
        status="unconfigured" if not configured else "unavailable" if feed is None else "connected"
        lanes={name:{"status":status,"feed":feed if configured else None,"source":source} for name in ("market","options")}
    market_lane,options_lane=(lanes[name] for name in ("market","options"))
    market_feed,options_feed=(lane["feed"] for lane in (market_lane,options_lane))
    market,candidates={},[]
    if market_feed is not None:
        items=object_or_empty(market_feed.get("instruments"))
        for s in SYMBOLS:
            if x:=instrument(object_or_empty(items.get(s)),now):
                market[s]=x
    if options_feed is not None:
        each=object_or_empty(options_feed.get("entries"))
        chains=object_or_empty(options_feed.get("chains"))
        for s in ("SPY","XSP"):
            proposal=select_chain(s,object_or_empty(chains[s])) if s in chains else object_or_empty(each.get(s))
            if c:=candidate(s,proposal,market,ev,now):
                candidates.append(c)
    if market:
        m_status="available"
    elif market_lane["status"]=="unconfigured":
        m_status="unconfigured"
    elif object_or_empty(object_or_empty(market_feed).get("instruments")):
        m_status="stale"
    else:
        m_status="unavailable"
    c_status="available" if candidates else "unconfigured" if options_lane["status"]=="unconfigured" else "unavailable"
    def stated_source(lane):
        return str(lane["source"])[:80] if lane["source"] and lane["status"]=="connected" else None
    return {"schema_version":1,"checked_at":iso(now),
            "sources":{name:{"status":lane["status"],"label":stated_source(lane)} for name,lane in lanes.items()},
            "market":{"status":m_status,"as_of":max((r["as_of"] for r in market.values()),default=None),
                      "source":stated_source(market_lane) if market else None,"instruments":market},
            "charts":chart_snapshot(market_feed,now,market_lane["status"]!="unconfigured" and history_approved,stated_source(market_lane)),
            "events":ev,"candidates":{"status":c_status,"as_of":max((r["as_of"] for r in candidates),default=None),
                                     "source":stated_source(options_lane) if candidates else None,"items":candidates}}


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--output",type=Path,default=ROOT/"site/data/status.json")
    v=cli.parse_args()
    now=datetime.now(timezone.utc)
    try:
        events=fetch_events(as_of=now)
    except Exception:
        events={"status":"unavailable","checked_at":iso(now),"items":[]}
    lanes=environment_lanes()
    previous=prior()  # previous official calendar and verified public Watchlist observations only
    public=snapshot(now,events,previous=previous,history_approved=enabled("SPS_PUBLIC_HISTORY_APPROVED"),lanes=lanes)
    public["watchlist"]=watchlist_snapshot(now,previous=previous)
    v.output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=v.output.parent,delete=False) as f:
        json.dump(public,f,ensure_ascii=False,indent=2,allow_nan=False)
        f.write("\n")
    Path(f.name).replace(v.output)
    print(f'Calendar: {public["events"]["status"]}; market: {public["market"]["status"]}; charts: {public["charts"]["status"]}; options source: {public["sources"]["options"]["status"]}; candidates: {len(public["candidates"]["items"])}')


if __name__=="__main__":
    main()
