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

For an authorized numerical feed, set `SPS_PUBLIC_FEED_APPROVED=true`, Secrets `SPS_PUBLIC_FEED_URL` and optionally `SPS_PUBLIC_FEED_TOKEN`, and a non-sensitive Variables `SPS_PUBLIC_FEED_LABEL`. Only enable after obtaining permission for a publicly downloadable derived market/strike JSON and anonymous display. The workflow never stores or serves raw chains or tokens. See [the feed schema and guardrails](FEED_SCHEMA.md).

## Study scope

Historical numbers are aggregate quote replays. One spread per opportunity, approximate −0.10 short put delta, nominal 15-point width, next regular session, $2.80 assumed round-trip fees. SPY and XSP have distinct selectors and results. The transition Z rule is a research hypothesis, not a trading instruction. Do not treat a displayed candidate as a fill or a trade order.
