"""Read the owner's published Watchlist, never its private ingestion database."""
import json
import re
from datetime import date, datetime, timedelta, timezone
from math import fsum, isfinite
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

BASE = "https://pepe760.github.io/market-data-pipeline/"
SOURCE_LINK = BASE + "#watchlist"
LABEL = "Market Data Watchlist · Yahoo Finance"
MAX_LATEST = 10_000_000
MAX_SERIES = 500_000
ET = ZoneInfo("America/New_York")
SYMBOLS = ("SPY", "SPX", "VIX", "XSP")
PARTS = {"quote": "公開 Watchlist 報價快照（唔係即時盤口）",
         "bar": "公開 Watchlist 最近完成嘅 15 分鐘 K 線收市（唔係即時盤口）"}

class DirectOnly(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def public_json(path, limit):
    # No authentication, no cookies, no forwarding headers and no network fallback.
    if path != "data/latest.json" and not re.fullmatch(r"data/(?:series|intraday)/[a-f0-9]{20}\.json", path):
        raise ValueError("Path is outside the public watchlist files.")
    with build_opener(DirectOnly()).open(Request(BASE + path, headers={"Accept":"application/json","User-Agent":"SPS-Public/1.0"}),timeout=9) as r:
        body = r.read(limit + 1)
    if len(body) > limit:
        raise ValueError("Source snapshot exceeds size limit.")
    doc = json.loads(body)
    if not isinstance(doc, dict):
        raise ValueError("Expected a public JSON object.")
    return doc

def stamp(value):
    if not isinstance(value,str) or len(value) > 45:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z","+00:00"))
        return t.astimezone(timezone.utc) if t.tzinfo else None
    except (ValueError,OverflowError):
        return None

def iso(t):
    return t.isoformat(timespec="seconds").replace("+00:00","Z") if t else None

def date_key(value):
    try:
        d=date.fromisoformat(value)
        return d if d.isoformat()==value else None
    except (TypeError,ValueError):
        return None

def price(x):
    return isinstance(x,(int,float)) and not isinstance(x,bool) and isfinite(x) and 0<x<1_000_000

def nested(v):
    return v if isinstance(v,dict) else {}

def eligible_row(doc):
    doc=nested(doc)
    if doc.get("schema_version") != 1 or not isinstance(doc.get("markets"),list):
        return None
    found = [r for r in doc["markets"] if isinstance(r,dict) and r.get("symbol")=="SPY"]
    if len(found) != 1:
        return None
    r=found[0]
    if (r.get("instrument_kind")!="ETF" or r.get("currency")!="USD" or r.get("provider")!="Yahoo Finance"):
        return None
    return r

def shard(fetch,row,key):
    path=nested(row.get("intraday")).get("series_path") if key=="intraday" else row.get("series_path")
    if not isinstance(path,str) or not re.fullmatch(r"data/"+key+r"/[a-f0-9]{20}\.json",path):
        return {}
    try:
        raw=fetch(path,MAX_SERIES)
    except (OSError,ValueError,TypeError):
        return {}
    raw=nested(raw)
    return raw if raw.get("symbol")=="SPY" else {}

def quote_or_bar(r,bar_doc,now):
    q=stamp(r.get("price_asof"))
    facts=[]
    if q and q <= now+timedelta(minutes=2) and price(r.get("price")):
        facts.append((q,r["price"],"quote",r.get("fresh") is True and now-q<=timedelta(minutes=90)))
    intra=nested(r.get("intraday"))
    header=stamp(intra.get("asof"))
    b_asof=stamp(bar_doc.get("asof"))
    if (intra.get("quality")=="OBSERVED_COMPLETE_BARS" and header and b_asof==header and header<=now and
          bar_doc.get("schema_version")==1 and isinstance(bar_doc.get("bars"),list)):
        last=[]
        for bar in bar_doc["bars"][-400:]:
            bar=nested(bar)
            start,end=stamp(bar.get("start")),stamp(bar.get("end"))
            if end==header and start and end-start==timedelta(minutes=15) and price(bar.get("close")):
                last.append(bar["close"])
        if len(last)==1:
            facts.append((header,last[0],"bar",intra.get("fresh") is True and now-header<=timedelta(minutes=90)))
    if not facts:
        return None
    dt,value,kind,fresh=max(facts,key=lambda x:x[0])
    return {"symbol":"SPY","value":value,"unit":"USD","observed_at":iso(dt),"observed_date":dt.astimezone(ET).date().isoformat(),
            "source_label":LABEL,"fresh":fresh,"status":"available" if fresh else "stale","kind":kind,"note":PARTS[kind]}

def daily(r,series_doc,now):
    # The published Watchlist may include an unfinished session in its analytics.
    asof=date_key(r.get("analytics_asof"))
    if (r.get("analytics_basis")!="Yahoo vendor adjusted daily close" or type(r.get("analytics_partial")) is not bool or
        not asof or asof!=date_key(series_doc.get("analytics_asof")) or
        asof>now.astimezone(ET).date() or not isinstance(series_doc.get("series"),list)):
        return None
    closes={}
    for p in series_doc["series"][-500:]:
        p=nested(p)
        d=date_key(p.get("date"))
        et=now.astimezone(ET)
        if (not d or d.weekday()>4 or d>asof or (d==asof and r["analytics_partial"]) or
            (d==et.date() and et.strftime("%H:%M")<"16:15") or not price(p.get("close"))):
            continue
        if d in closes:
            return None
        closes[d]=p["close"]
    ds=sorted(closes)
    if len(ds)<2:
        return None
    out=[]
    values=[closes[d] for d in ds]
    for i,d in enumerate(ds):
        if (ds[-1]-d).days>100:
            continue
        point={"date":d.isoformat(),"close":closes[d]}
        for n in (20,50,200):
            point["sma"+str(n)]=round(fsum(values[i+1-n:i+1])/n,6) if i+1>=n else None
        out.append(point)
    return {"source":LABEL,"as_of":ds[-1].isoformat(),"status":"stale" if (now.astimezone(ET).date()-ds[-1]).days>4 else "available","series":out}

def placeholder(symbol):
    return {"symbol":symbol,"value":None,"unit":"USD" if symbol=="SPY" else "points","observed_date":None,
            "observed_at":None,"source_label":None,"fresh":False,"status":"unavailable",
            "note":"同一公開 Watchlist 未提供此標的" if symbol!="SPY" else "未讀到已發布嘅 SPY 報價"}

def stale_public_spy(previous,now):
    rows=nested(nested(previous).get("watchlist")).get("items")
    if not isinstance(rows,list):
        return None
    for row in rows[:8]:
        r=nested(row)
        t=stamp(r.get("observed_at"))
        k=r.get("kind")
        if (r.get("symbol")=="SPY" and r.get("source_label")==LABEL and k in PARTS and price(r.get("value"))
            and t and t<=now and now-t<timedelta(days=14)):
            return {"symbol":"SPY","value":r["value"],"unit":"USD","observed_at":iso(t),
                    "observed_date":t.astimezone(ET).date().isoformat(),"source_label":LABEL,"fresh":False,
                    "status":"stale","kind":k,"note":PARTS[k]+"；本次更新未讀到來源。"}
    return None

def stale_history(previous,now):
    raw=nested(nested(nested(previous).get("watchlist")).get("spy_history"))
    cutoff=date_key(raw.get("as_of"))
    days=raw.get("series")
    today=now.astimezone(ET).date()
    if (raw.get("source")!=LABEL or not cutoff or not 0<=(today-cutoff).days<14 or
        not isinstance(days,list) or not 2<=len(days)<=80):
        return None
    out=[]
    for r in days:
        r=nested(r)
        d=date_key(r.get("date"))
        if not d or d>cutoff or not price(r.get("close")) or (out and d.isoformat()<=out[-1]["date"]):
            return None
        point={"date":d.isoformat(),"close":r["close"]}
        for k in ("sma20","sma50","sma200"):
            point[k]=r.get(k) if price(r.get(k)) else None
        out.append(point)
    if out[-1]["date"]!=cutoff.isoformat():
        return None
    return {"source":LABEL,"as_of":cutoff.isoformat(),"status":"stale","series":out}

def snapshot(now,*,previous=None,fetch=public_json):
    try:
        latest=fetch("data/latest.json",MAX_LATEST)
    except (OSError,ValueError,TypeError):
        latest={}
    r=eligible_row(latest)
    q,h=None,None
    if r:
        q=quote_or_bar(r,shard(fetch,r,"intraday"),now)
        h=daily(r,shard(fetch,r,"series"),now)
    prior=stale_public_spy(previous,now)
    if prior and (not q or (stamp(prior["observed_at"])>stamp(q["observed_at"]) and not q["fresh"])):
        q=prior
    return {"checked_at":iso(now),"status":"available" if q and q["fresh"] else "stale" if q else "unavailable",
            "source_url":SOURCE_LINK,"items":[(q or placeholder(s)) if s=="SPY" else placeholder(s) for s in SYMBOLS],
            "spy_history":h or stale_history(previous,now)}
