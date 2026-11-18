import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import refresh as r

NOW=datetime.fromisoformat("2026-11-20T16:17:00+00:00")
FOMC={"date":"2026-11-20","time_et":None,"type":"FOMC",
      "title":"FOMC final day","source_url":"https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"}
CPI={"date":"2026-11-23","time_et":"08:30","type":"CPI",
     "title":"Consumer Price Index","source_url":"https://www.bls.gov/schedule/news_release/bls.ics"}
FEED={"instruments":{"SPX":{"spot":7350,"as_of":"2026-11-20T16:16:00Z","prior_close":7320,
                             "sma200":7150,"high252_close":7600,"private":999},"OTHER":{"spot":1}},
      "entries":{"XSP":{"as_of":"2026-11-20T16:16:00Z","selection_as_of":"2026-11-20T14:45:00Z",
                       "entry_date":"2026-11-20","expiry":"2026-11-23","verified_next_session":True,
                       "short_strike":725,"long_strike":710,"delta":-.104,
                       "short_bid":.30,"short_ask":.32,"long_bid":.04,"long_ask":.09,
                       "provider_secret":"NOT FOR OUTPUT"}}}


def events(*items,status="available"):
    return {"status":status,"checked_at":"2026-11-20T16:17:00Z","items":list(items)}


class TestSnapshot(unittest.TestCase):
    def test_no_license_no_fetch_and_no_candidates(self):
        with patch.dict("os.environ",{"SPS_PUBLIC_FEED_APPROVED":"false","SPS_PUBLIC_FEED_URL":"https://example.com"}):
            with patch.object(r,"build_opener") as mock:
                self.assertIsNone(r.environment_feed())
                mock.assert_not_called()
        got=r.snapshot(NOW,events(CPI))
        self.assertEqual(got["market"]["status"],"unconfigured")
        self.assertEqual(got["candidates"]["items"],[])

    def test_only_approved_fields_and_candidate_credit(self):
        got=r.snapshot(NOW,events(),FEED,configured=True)
        item,=got["candidates"]["items"]
        self.assertEqual((item["short_strike"],item["long_strike"],item["credit"],item["max_loss_usd"]),
                         (725,710,.21,1481.8))
        self.assertEqual(item["gate"],"passes")
        self.assertEqual(got["market"]["instruments"]["SPX"]["regime"],"bull")
        self.assertEqual((item["short_bid"],item["short_ask"],item["long_bid"],item["long_ask"],item["natural_close_debit"]),(.30,.32,.04,.09,.28))
        for s in ("private","NOT FOR OUTPUT","OTHER","quote_puts"):
            self.assertNotIn(s,str(got))

    def test_rule_c_and_missing_or_stale_events(self):
        for event in (FOMC,CPI):
            self.assertEqual(r.snapshot(NOW,events(event),FEED,configured=True)["candidates"]["items"][0]["gate"],"blocked_event")
        result=r.snapshot(NOW,events(status="partial"),FEED,configured=True,previous={"events":events() | {"items":[FOMC | {"date":"2026-11-24"}]} })
        self.assertEqual(result["events"]["status"],"stale")
        self.assertEqual(result["candidates"]["items"][0]["gate"],"unknown")

    def test_wrong_wing_no_candidate(self):
        core={**FEED["entries"]["XSP"],"long_strike":711}
        self.assertEqual(r.snapshot(NOW,events(),{**FEED,"entries":{"XSP":core}},configured=True)["candidates"]["items"],[])

    def test_stale_quote_no_candidate(self):
        core={**FEED["entries"]["XSP"],"as_of":"2026-11-20T13:17:00Z"}
        got=r.snapshot(NOW,events(),{**FEED,"entries":{"XSP":core}},configured=True)
        self.assertEqual(got["candidates"]["status"],"unavailable")
        self.assertEqual(got["candidates"]["items"],[])

    def test_select_by_frozen_delta_and_price_same_legs(self):
        def put(strike, bid, ask, delta=None, expiry="2026-11-23"):
            return dict(type="put",expiry=expiry,strike=strike,bid=bid,ask=ask,delta=delta)
        chain={**FEED["entries"]["XSP"],"selection_puts":[put(725,.4,.45,-.102),put(727,.6,.64,-.13),put(710,.01,.09),put(711,.01,.06)],
               "quote_puts":[put(725,.30,.33,-.30),put(710,.03,.08),put(727,.60,.65,-.10),put(712,.20,.21)]}
        out=r.snapshot(NOW,events(),{**FEED,"chains":{"XSP":chain}},configured=True)
        candidate,=out["candidates"]["items"]
        self.assertEqual((candidate["short_strike"],candidate["long_strike"],candidate["delta"],candidate["credit"]),(725,710,-.102,.22))
        # A quote for the same strike on another expiration cannot be used.
        chain["quote_puts"][1]["expiry"]="2026-11-24"
        self.assertEqual(r.snapshot(NOW,events(),{**FEED,"chains":{"XSP":chain}},configured=True)["candidates"]["items"],[])

    def test_chart_smas_use_prewindow_sessions_no_unfinished_close(self):
        days=[]
        day=NOW.date()-timedelta(days=1)
        while len(days)<280:
            if day.weekday()<5:
                days.append(day)
            day-=timedelta(days=1)
        bars=[dict(date=d.isoformat(),close=i+100.) for i,d in enumerate(reversed(days))]
        bars.append(dict(date=NOW.date().isoformat(),close=9999.))
        feed={**FEED,"history":{"SPX":{"as_of":"2026-11-20T16:16:00Z","bars":bars}}}
        empty=r.snapshot(NOW,events(),feed,configured=True)["charts"]
        self.assertEqual(empty["series"],{})
        out=r.snapshot(NOW,events(),feed,configured=True,history_approved=True)["charts"]
        self.assertEqual(out["status"],"available")
        last=out["series"]["SPX"][-1]
        self.assertEqual((last["close"],last["sma20"],last["sma50"],last["sma200"]),(379.,369.5,354.5,279.5))
        self.assertIsNotNone(out["series"]["SPX"][0]["sma200"])
        self.assertLess(len(out["series"]["SPX"]),80)

    def test_split_market_approval_does_not_publish_options(self):
        env={"SPS_PUBLIC_MARKET_APPROVED":"true","SPS_PUBLIC_MARKET_URL":"https://market.example.com/quotes",
             "SPS_PUBLIC_MARKET_LABEL":"Index Vendor"}
        with patch.dict("os.environ",env,clear=True), patch.object(r,"fetch_public_feed",return_value=FEED) as pull:
            lanes=r.environment_lanes()
        pull.assert_called_once_with("SPS_PUBLIC_MARKET",require_distribution=True)
        self.assertNotIn("entries",lanes["market"]["feed"])
        got=r.snapshot(NOW,events(),lanes=lanes,history_approved=True)
        self.assertEqual(got["sources"]["market"],{"status":"connected","label":"Index Vendor"})
        self.assertEqual(got["market"]["instruments"]["SPX"]["spot"],7350)
        self.assertEqual(got["candidates"]["status"],"unconfigured")

    def test_market_outage_does_not_discard_approved_options(self):
        def pull(prefix, **unused):
            if prefix=="SPS_PUBLIC_MARKET":
                raise OSError("fake URL or token must be omitted")
            return FEED
        with patch.dict("os.environ",{"SPS_PUBLIC_MARKET_APPROVED":"true","SPS_PUBLIC_OPTIONS_APPROVED":"true",
            "SPS_PUBLIC_OPTIONS_LABEL":"Option Vendor"},clear=True), patch.object(r,"fetch_public_feed",side_effect=pull):
            lanes=r.environment_lanes()
        self.assertNotIn("instruments",lanes["options"]["feed"])
        got=r.snapshot(NOW,events(),lanes=lanes,history_approved=True)
        self.assertEqual((got["market"]["status"],got["charts"]["status"]),("unavailable","unavailable"))
        self.assertEqual(got["candidates"]["source"],"Option Vendor")
        item,=got["candidates"]["items"]
        self.assertEqual((item["credit"],item["gate"]),(.21,"unknown"))
        self.assertNotIn("fake URL",str(got))

    def test_legacy_one_request_and_explicit_disable_blocks_fallback(self):
        with patch.dict("os.environ",{"SPS_PUBLIC_FEED_APPROVED":"true"},clear=True), patch.object(r,"fetch_public_feed",return_value=FEED) as pull:
            lanes=r.environment_lanes()
            pull.assert_called_once_with("SPS_PUBLIC_FEED",require_distribution=False)
            self.assertEqual(set(lanes["market"]["feed"]),{"instruments"})
            self.assertEqual(set(lanes["options"]["feed"]),{"entries"})
        disabled={"SPS_PUBLIC_FEED_APPROVED":"true","SPS_PUBLIC_OPTIONS_APPROVED":"false"}
        with patch.dict("os.environ",disabled,clear=True), patch.object(r,"fetch_public_feed",return_value=FEED):
            self.assertEqual(r.environment_lanes()["options"]["status"],"unconfigured")

    def test_public_ingress_rejects_unmarked_dedicated_and_private_broker_payload(self):
        opener=MagicMock()
        reply=opener.open.return_value.__enter__.return_value
        env={"SPS_PUBLIC_MARKET_APPROVED":"true","SPS_PUBLIC_MARKET_URL":"https://market.example.com/data"}
        with patch.dict("os.environ",env,clear=True), patch.object(r,"build_opener",return_value=opener):
            for marks in ({},{"distribution":"public","source":"IBKR TWS"},
                          {"distribution":"private"},{"distribution":"public","private":True}):
                reply.read.return_value=json.dumps({**FEED,**marks}).encode()
                result=r.environment_lanes()["market"]
                self.assertEqual(result,{"status":"unavailable","feed":None,"source":None})
            reply.read.return_value=json.dumps({**FEED,"distribution":"public"}).encode()
            self.assertEqual(r.environment_lanes()["market"]["status"],"connected")


if __name__=="__main__":
    unittest.main()
