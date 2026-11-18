# SPS Research Dashboard

Public research notes, market context and an illustrative strike calculator for SPY and XSP short put spreads.

- Website: [SPS Research Dashboard](https://pepe760.github.io/sps-research-dashboard/)
- Public JSON: [latest status](https://pepe760.github.io/sps-research-dashboard/data/status.json)
- Changes in the official event calendar are checked hourly at minute 17 UTC, with a manual refresh available in GitHub Actions. Run times can be delayed by GitHub. Source times and stale states are separate from refresh times.
- No account data, user names, private research archives, paid quotes or signed credentials belong in the public repository. An optional, attributed TradingView widget is only a visual reference; it is not queried by the app.

## Run locally

```sh
python -m unittest discover -s scripts/tests
python scripts/refresh.py
python -m http.server 8000 --directory site
```

If the official agencies cannot be reached, the page reports unavailable or stale. If no redistribution-authorized feed is configured, the quote-derived market/regime/strike fields remain unavailable. The browser calculator can still use a manually entered price and volatility estimate; its output is a model illustration and does not say that the strikes are listed or executable.

## Hourly publishing

In **Settings → Pages → Build and deployment**, choose **GitHub Actions**. The workflow `Hourly public dashboard` runs on pushes to `main`, manual dispatch, and hourly via cron. No brokerage is connected. The public database is a small versioned JSON document served by Pages under `data/status.json`. A last-known event calendar is retained as stale when the new fetch is incomplete.

Configure permitted public index and option adapters independently. In **Settings → Secrets and variables → Actions**, use `SPS_PUBLIC_MARKET_APPROVED=true` and `SPS_PUBLIC_MARKET_URL` for the market endpoint; also set `SPS_PUBLIC_HISTORY_APPROVED=true` to publish daily bars/SMA. Use `SPS_PUBLIC_OPTIONS_APPROVED=true` and `SPS_PUBLIC_OPTIONS_URL` for the options endpoint. Keep URLs and optional bearer tokens in Secrets; `…_APPROVED` and a non-sensitive `…_LABEL` go in Variables. The original `SPS_PUBLIC_FEED_*` combined mode still works for lanes without dedicated settings. The public JSON tracks both source connections separately. Review [the feed schema and guardrails](FEED_SCHEMA.md) before enabling a feed. The build only deploys an allowlist of static assets and `data/status.json`; do not place or reference brokerage, Yahoo collector, or private SQLite files in the repo.

## Study scope

Historical numbers are aggregate quote replays. One spread per opportunity, approximate −0.10 short put delta, nominal 15-point width, next regular session, $2.80 assumed round-trip fees. SPY and XSP have distinct selectors and results. The transition Z rule is a research hypothesis, not a trading instruction. Do not treat a displayed candidate as a fill or a trade order.

## Charts and paper tracking

The homepage has SPX and VIX charts with one- and three-month views. Numeric daily bars, SMA20/50/200, and automatic option-pair figures require a permitted feed; TradingView embeds do not populate the JSON. The paper desk accepts user-entered bid/ask quotes and keeps any saved records in that browser only. Yahoo Finance is a direct-view link, not a pipeline; the linked data providers do not grant redistribution by default. See [real-time options and required permissions](FEED_SCHEMA.md#real-time-vendor-options).
