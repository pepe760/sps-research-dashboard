# XSP SPS · 開倉核對台

[Open the public desk](https://pepe760.github.io/sps-research-dashboard/#watchlist). It is a no-sign-in, read-only setup checker for a next-session XSP put credit spread. The homepage shows XSP/SPX/VIX source times, one two-leg candidate if verified, a beginner's checklist, and only the last three calendar months of completed VIX closes.

No trade is placed. The public site does not use a personal brokerage feed or infer an XSP option from SPY. If market or options data is missing, stale or delayed, live verification is unavailable. The homepage links to Yahoo Finance for ^VIX latest/3M, ^XSP and ^GSPC. Users can enter a displayed spot with its original time or load their own ^VIX daily Date/Close CSV locally; neither supplies or verifies a live option. The manual two-leg calculator and paper records remain browser-only.

## Screen a copied XSP option chain

The [paste scanner](https://pepe760.github.io/sps-research-dashboard/#xsp-scan) shows the planned entry session and next regular-session expiry using Cboe's published 2026–27 U.S. options holiday calendar. Copy one expiry of native XSP put rows, or import UTF-8 CSV/TSV with `expiry,strike,delta,bid,ask` (optional symbol, put/call, and offset-qualified per-leg quote time). A manually copied Cboe delayed quote table with its recognizable headers is also supported. No market data is downloaded by the scanner or uploaded by the browser.

It finds complete positive-credit spreads with verified matching expiry, the exact 15-point listed wing, and a valid short put delta in −0.15 to −0.05. It ranks by distance to −0.10, then higher short bid then lower strike. Output is a user-supplied reference snapshot, not an execution quote or validation of the separate timed 09:45 research logic. Confirm the listed PM contract in the broker, including on shortened or unscheduled sessions.

## Live setup

Use the [step-by-step live deployment guide](LIVE_DASHBOARD.md), [provider requirements](RELEASE_PUB_LIVE.md), and [adapter feed schema](FEED_SCHEMA.md). A licensed and configured external data route is needed for actual live quotes. The desk polls that service every 15 seconds while visible, and rejects an old build or leg quote. The hourly GitHub Pages build only supplies a fallback snapshot and economic calendar; it isn't the live route. The live output retains the provider observation time, not the website check time.

The option setup is research-rule-specific: native XSP, next actual regular session PM expiration (verified by the adapter), signed put delta nearest −0.10, exact W15, frozen 09:45 ET selection, quote check starting 10:45 ET, and validated market timestamps. The $2.80 round-trip reserve is a model input; check actual broker fees and quoted combo credit.

## Local check

```sh
python -m unittest discover -s scripts/tests
python scripts/refresh.py
python -m http.server 8000 --directory site
```

GitHub Pages deploys a static file allowlist; account data, brokerage snapshots, licensed archives and keys do not belong in it. Put licensed adapter secrets on the operator host, and set the public live URL in Pages only with public web display and JSON redistribution authorized.
