import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import refresh
import xsp_auto as a


def t(s):
    return datetime.fromisoformat(s+"+00:00")


class Provider:
    def __init__(self, clock):
        self.clock=clock
        self.calls=[]
        self.freeze=[(725,.40,.44,-.100),(710,.04,.13,None),(726,.44,.49,-.12)]
        self.reprices=[(725,.29,.33,-.18),(710,.03,.07,None),(728,.25,.31,-.10)]
        self.actual_delay=0
        self.freeze_finish=None

    def book(self, values, expiry, stamp):
        return [{"type":"put","expiry":expiry,"strike":k,"bid":b,"ask":s,"delta":d,
                 "as_of":refresh.iso(stamp-timedelta(seconds=i)), "feed_mode":"real_time",
                 "timestamp_basis":"provider_event"} for i,(k,b,s,d) in enumerate(values)]

    def options(self, expiry):
        self.calls.append(("chain",expiry))
        rows=self.book(self.freeze,expiry,self.clock()-timedelta(seconds=self.actual_delay))
        if self.freeze_finish:
            self.clock=self.freeze_finish
        return rows

    def option_pair(self, expiry, strikes):
        self.calls.append(("pair",expiry,strikes))
        return self.book(self.reprices,expiry,self.clock()-timedelta(seconds=self.actual_delay))

    def market(self):
        return {k:{"spot":value,"as_of":refresh.iso(self.clock()),"feed_mode":"real_time",
                   "timestamp_basis":"provider_event"} for k,value in (("SPX",7300),("XSP",730),("VIX",22))}

    def history(self, symbol, first, last):
        self.calls.append(("history",symbol,first,last))
        current=date.fromisoformat(first)
        rows=[]
        while current <= date.fromisoformat(last):
            if current.weekday()<5 and current not in a.CLOSED:
                rows.append({"date":current.isoformat(),"close":7000 + (current-date.fromisoformat(first)).days if symbol=="SPX" else 20,"complete":True})
            current+=timedelta(days=1)
        return rows


class TestAuto(unittest.TestCase):
    def setUp(self):
        self.store=tempfile.TemporaryDirectory()
        self.addCleanup(self.store.cleanup)
        self.path=Path(self.store.name)/"book.sqlite"
        self.now=t("2026-11-20T14:45:12")  # Friday ET 09:45, Monday expiry
        self.vendor=Provider(lambda: self.now)
        self.collector=a.Collector(self.vendor,self.path,clock=lambda: self.now,history_enabled=True)

    def test_auto_freezes_requotes_and_publishes_same_strikes(self):
        first=self.collector.lanes()
        self.assertEqual(self.vendor.calls,[("chain","2026-11-23")])
        self.assertEqual(first["options"]["reason"],"selection_saved")
        self.assertEqual(first["options"]["feed"]["entries"],{})
        self.now=t("2026-11-20T15:45:12")
        # Simulate process restart and a later delta that would select another strike.
        self.collector=a.Collector(self.vendor,self.path,clock=lambda: self.now,history_enabled=True)
        second=self.collector.lanes()
        self.assertIn(("pair","2026-11-23",(725.0,710.0)),self.vendor.calls)
        item=second["options"]["feed"]["entries"]["XSP"]
        self.assertEqual((item["short_strike"],item["long_strike"],item["delta"]),(725,710,-.10))
        self.assertEqual(item["selection_as_of"],"2026-11-20T14:45:12Z")
        self.assertEqual(item["short_quote_as_of"],"2026-11-20T15:45:12Z")
        desk=refresh.snapshot(self.now,{"status":"available","items":[]},lanes=second,history_approved=True)["desk"]
        self.assertEqual(desk["setup"]["status"],"ready")
        self.assertEqual(desk["setup"]["candidate"]["credit"],.22)
        self.assertTrue(desk["vix_history"]["series"])

    def test_missed_freeze_cannot_fill_in_with_later_chain(self):
        self.now=t("2026-11-20T14:46:02")
        self.collector.lanes()
        self.now=t("2026-11-20T15:45:12")
        second=self.collector.lanes()
        self.assertFalse(any(c[0] in ("chain","pair") for c in self.vendor.calls))
        self.assertEqual(second["options"]["reason"],"no_0945_selection")

    def test_response_after_capture_deadline_rejected(self):
        def slow(expiry):
            rows=self.vendor.book(self.vendor.freeze,expiry,self.now)
            self.now=t("2026-11-20T14:46:00")
            return rows
        self.vendor.options=slow
        self.assertEqual(self.collector.lanes()["options"]["reason"],"selection_not_available")
        self.now=t("2026-11-20T15:45:12")
        self.assertEqual(self.collector.lanes()["options"]["reason"],"no_0945_selection")

    def test_repeat_capture_never_replaces_earlier_selection(self):
        self.collector.lanes()
        self.vendor.freeze=[(730,.40,.45,-.100),(715,.04,.13,None)]
        self.now=t("2026-11-20T14:45:35")
        self.collector.lanes()
        self.assertEqual(self.vendor.calls,[("chain","2026-11-23")])
        self.now=t("2026-11-20T16:00:12")
        self.assertEqual(self.collector.lanes()["options"]["feed"]["entries"]["XSP"]["short_strike"],725)

    def test_stale_quote_delayed_quote_and_holidays_fail_closed(self):
        self.collector.lanes()
        self.now=t("2026-11-20T16:00:12")
        self.vendor.actual_delay=91
        self.assertEqual(self.collector.lanes()["options"]["feed"]["entries"],{})
        self.vendor.actual_delay=0
        def delayed(expiry,strikes):
            return [dict(r,feed_mode="delayed") for r in self.vendor.book(self.vendor.reprices,expiry,self.now)]
        self.vendor.option_pair=delayed
        self.assertEqual(self.collector.lanes()["options"]["feed"]["entries"],{})
        self.assertEqual(a.nearby_session(date(2026,11,25),1),date(2026,11,27))
        self.now=t("2026-11-27T18:00:12")  # Friday Early close 13:00 ET
        self.assertEqual(self.collector.lanes()["options"]["reason"],"outside_capture_or_pricing_window")
        self.now=t("2026-11-26T14:45:12")
        self.assertEqual(self.collector.lanes()["options"]["reason"],"no_regular_session")

    def test_approval_checks_do_not_instantiate_the_provider(self):
        with patch.dict(os.environ,{"SPS_MASSIVE_PUBLIC_APPROVED":"false",
                                    "SPS_MASSIVE_API_KEY":"unused",
                                    "SPS_XSP_STATE_PATH":str(self.path)},clear=True):
            self.assertEqual(a.lanes()["options"]["status"],"unconfigured")
        self.assertFalse(self.path.exists())


if __name__=="__main__":
    unittest.main()
