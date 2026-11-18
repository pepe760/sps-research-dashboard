import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import massive_xsp as m

EXPIRY = "2026-11-19"
CLOCK = datetime.fromisoformat("2026-11-18T14:45:15+00:00")
START = 1_794_998_700_012_345_678   # provider timestamp, nanoseconds


def row(strike=725, *, bid=.40, ask=.43, delta=-.101, timeframe="REAL-TIME"):
    return {
        "details": {"contract_type": "put", "expiration_date": EXPIRY, "strike_price": strike,
                    "ticker": m._option_ticker(EXPIRY, strike), "exercise_style": "european",
                    "shares_per_contract": 100},
        "last_quote": {"bid": bid, "ask": ask, "timeframe": timeframe, "last_updated": START},
        "greeks": {"delta": delta}, "fmv": 999, "last_trade": {"price": 998},
    }


def index(symbol, value, timeframe, status="open"):
    return {"ticker": f"I:{symbol}", "value": value, "timeframe": timeframe, "last_updated": START,
            "market_status": status, "type": "indices"}


class FakeClient(m.MassiveClient):
    def __init__(self, *payloads):
        super().__init__("unit-test-key", clock=lambda: CLOCK)
        self.payloads = iter(payloads)
        self.requests = []

    def _get(self, path, params=None):
        self.requests.append((path, params))
        return next(self.payloads)


class MassiveXspTest(unittest.TestCase):
    def test_option_source_not_proxy_delayed_or_fmv(self):
        absent_nbbo = row(700)
        absent_nbbo.pop("last_quote")
        wrong_contract = row(710)
        wrong_contract["details"]["ticker"] = "O:SPX260111P00710000"
        stale_unit = row(712)
        stale_unit["last_quote"]["last_updated"] = START // 1_000_000
        wrong_expiry = row(707)
        wrong_expiry["details"]["expiration_date"] = "2026-11-20"
        fake = FakeClient({"results": [
            row(), row(710, delta=None), absent_nbbo, wrong_contract, wrong_expiry, stale_unit,
            row(717, timeframe="DELAYED"), row(711, bid=.5, ask=.3)]})
        rows = fake.options(EXPIRY)
        self.assertEqual([r["strike"] for r in rows], [725, 710])
        self.assertEqual((rows[0]["bid"], rows[0]["ask"], rows[0]["delta"]), (.40, .43, -.101))
        self.assertEqual(rows[0]["feed_mode"], "real_time")
        self.assertTrue(rows[0]["as_of"].endswith(".012345Z"))
        self.assertIsNone(rows[1]["delta"])
        self.assertEqual(fake.requests[0][1]["expiration_date"], EXPIRY)

    def test_bound_pagination_and_duplicate_native_contract(self):
        next_url = "https://api.massive.com/v3/snapshot/options/I%3AXSP?cursor=page123&apiKey=ignore"
        fake = FakeClient({"results": [row()], "next_url": next_url}, {"results": [row(710)]})
        self.assertEqual(len(fake.options(EXPIRY)), 2)
        self.assertEqual(fake.requests[1], (m.OPTIONS_PATH, {"cursor": "page123"}))
        repeated = FakeClient({"results": [row()], "next_url": next_url}, {"results": [row()]})
        with self.assertRaisesRegex(m.MassiveUnavailable, "duplicate"):
            repeated.options(EXPIRY)
        wrong_host = FakeClient({"results": [row()], "next_url": next_url.replace("api.massive.com", "example.org")})
        with self.assertRaisesRegex(m.MassiveUnavailable, "pagination"):
            wrong_host.options(EXPIRY)

    def test_market_exact_native_symbols_and_provider_market_mode(self):
        fake = FakeClient({"results": [
            index("SPX", 7350, "REAL-TIME"), index("VIX", 18, "DELAYED"),
            index("SPY", 735, "REAL-TIME"), {"ticker": "I:XSP", "error": "NOT_ENTITLED"}]})
        market = fake.market()
        self.assertEqual(set(market), {"SPX", "VIX"})
        self.assertEqual(market["VIX"]["feed_mode"], "delayed")
        self.assertEqual(market["SPX"]["spot"], 7350)
        self.assertEqual(FakeClient({"results": [index("XSP", 735, "REAL-TIME", "closed")]}).market()["XSP"]["feed_mode"], "frozen")

    def test_history_et_cutoff_and_duplicate_daily_rows(self):
        def bar(s, c):
            return {"t": int(datetime.fromisoformat(s).timestamp()) * 1000, "c": c}
        old = bar("2026-11-16T05:00:00+00:00", 20)
        prev = bar("2026-11-17T05:00:00+00:00", 20.5)
        today = bar("2026-11-18T05:00:00+00:00", 25)
        fake = FakeClient({"ticker": "I:VIX", "results": [today, prev, old]})
        self.assertEqual(fake.history("VIX", "2026-09-01", "2026-11-20"), [
            {"date": "2026-11-16", "close": 20., "complete": True},
            {"date": "2026-11-17", "close": 20.5, "complete": True}])
        self.assertTrue(fake.requests[0][0].endswith("/2026-11-17"))
        with self.assertRaisesRegex(m.MassiveUnavailable, "duplicate"):
            FakeClient({"ticker": "I:VIX", "results": [prev, prev]}).history("VIX", "2026-09-01", "2026-11-17")

    def test_bearer_never_on_url(self):
        with patch("massive_xsp.build_opener") as builder:
            response = builder.return_value.open.return_value.__enter__.return_value
            response.read.return_value = json.dumps({"status": "OK", "results": []}).encode()
            self.assertEqual(m.MassiveClient("unit-test-token").market(), {})
            request = builder.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header("Authorization"), "Bearer unit-test-token")
            self.assertNotIn("unit-test-token", request.full_url)
            self.assertTrue(request.full_url.startswith(m.API + "/"))
            self.assertIsInstance(builder.call_args.args[0], m.NoRedirect)

    def test_pair_only_queries_the_stored_contracts(self):
        class PairFake(m.MassiveClient):
            def _get(self, path, params=None):
                return {"results": {m._option_ticker(EXPIRY, 725): row(725),
                                    m._option_ticker(EXPIRY, 710): row(710)}[path.rsplit("/", 1)[1]]}
        rows = PairFake("test-token").option_pair(EXPIRY, (725, 710))
        self.assertEqual([r["strike"] for r in rows], [725, 710])


if __name__ == "__main__":
    unittest.main()
