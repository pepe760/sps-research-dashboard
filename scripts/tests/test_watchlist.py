import sys
import unittest
from datetime import datetime,timedelta
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import watchlist as w

NOW=datetime.fromisoformat("2026-11-17T22:00:00+00:00")
ID="6493341e6b5636b2080f"
INTRA=f"data/intraday/{ID}.json"
HIST=f"data/series/{ID}.json"
BASE={"symbol":"SPY","instrument_kind":"ETF","currency":"USD","provider":"Yahoo Finance",
      "price":731.165,"price_asof":"2026-11-17T19:27:20Z","fresh":False,
      "analytics_partial":True,"analytics_asof":"2026-11-17","analytics_basis":"Yahoo vendor adjusted daily close",
      "series_path":HIST,"intraday":{"series_path":INTRA,"asof":"2026-11-17T21:00:00Z",
      "quality":"OBSERVED_COMPLETE_BARS","fresh":False},"account_data":"never publish"}

def spy_data():
    day=NOW.date()
    history=[]
    while len(history)<275:
        if day.weekday()<5:
            history.append({"date":day.isoformat(),"close":500-len(history)})
        day-=timedelta(days=1)
    return {"data/latest.json":{"schema_version":1,"markets":[BASE|{}, BASE|{"symbol":"VIX","price":15}]},
            HIST:{"symbol":"SPY","analytics_asof":"2026-11-17","series":history[::-1]},
            INTRA:{"schema_version":1,"symbol":"SPY","asof":"2026-11-17T21:00:00Z","bars":[
                {"start":"2026-11-17T20:45:00Z","end":"2026-11-17T21:00:00Z","close":732.40}]}}

class WatchlistTest(unittest.TestCase):
    def test_observed_bar_wins_and_adjusted_chart_excludes_partial(self):
        data=spy_data()
        snapshot=w.snapshot(NOW,fetch=lambda p,n:data[p])
        s=snapshot["items"][0]
        self.assertEqual((s["value"],s["observed_at"],s["kind"],s["status"]),(732.4,"2026-11-17T21:00:00Z","bar","stale"))
        self.assertIsNone(snapshot["items"][2]["value"])
        rows=snapshot["spy_history"]["series"]
        self.assertEqual((rows[-1]["date"],rows[-1]["close"],rows[-1]["sma200"]),("2026-11-16",499,399.5))
        self.assertIsNotNone(rows[0]["sma200"])
        self.assertNotIn("account_data",str(snapshot))

    def test_reject_off_host_and_wrong_symbol(self):
        data=spy_data()
        data["data/latest.json"]["markets"][0]["series_path"]="https://example.com/other.json"
        data[INTRA]["symbol"]="SPX"
        result=w.snapshot(NOW,fetch=lambda p,n:data[p])
        self.assertIsNone(result["spy_history"])
        self.assertEqual((result["items"][0]["value"],result["items"][0]["kind"]),(731.165,"quote"))

    def test_keeps_verified_previous_price_and_series_stale_when_unavailable(self):
        data=spy_data()
        before=w.snapshot(NOW,fetch=lambda p,n:data[p])
        def offline(*args): raise TimeoutError()
        snap=w.snapshot(NOW+timedelta(hours=1),previous={"watchlist":before},fetch=offline)
        self.assertEqual((snap["items"][0]["value"],snap["items"][0]["observed_at"],snap["items"][0]["fresh"]),(732.4,"2026-11-17T21:00:00Z",False))
        self.assertEqual(snap["spy_history"]["status"],"stale")
        self.assertIsNone(w.snapshot(NOW+timedelta(days=15),previous={"watchlist":before},fetch=offline)["items"][0]["value"])

    def test_price_freshness_is_never_set_by_builder_clock(self):
        data=spy_data()
        data["data/latest.json"]["markets"][0]["intraday"]=dict(data["data/latest.json"]["markets"][0]["intraday"],fresh=True)
        fresh=w.snapshot(NOW,fetch=lambda p,n:data[p])
        stale=w.snapshot(NOW+timedelta(hours=2),fetch=lambda p,n:data[p])
        self.assertEqual(fresh["status"],"available")
        self.assertEqual(stale["status"],"stale")
        self.assertEqual(fresh["items"][0]["observed_at"],stale["items"][0]["observed_at"])
