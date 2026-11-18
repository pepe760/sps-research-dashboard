# Optional licensed feed adapter

The public site works without this adapter. An optional TradingView embed stays on the provider's display layer; its values are not read into the project. The refresh job writes official economic event data and a data status even if no quote license is configured. A market-data vendor's public webpage is not a feed adapter.

Only enable a numerical feed after the vendor has authorized both the public web display and the public-download use of the saved derived fields. Use an HTTPS endpoint controlled by the operator, with optional bearer auth in GitHub Secrets. Do not pass a brokerage account, use an undocumented portal endpoint, or publish the secret. The public output exposes only the allowlisted fields in `data/status.json`; it never copies the input chain.

## Independent source setup

| Public lane | GitHub Actions Variables | GitHub Actions Secrets | Payload |
| --- | --- | --- | --- |
| Market and daily charts | `SPS_PUBLIC_MARKET_APPROVED=true`, optional `SPS_PUBLIC_MARKET_LABEL`, `SPS_PUBLIC_HISTORY_APPROVED=true` only if daily distribution is also authorized | `SPS_PUBLIC_MARKET_URL`, optional `SPS_PUBLIC_MARKET_TOKEN` | `distribution: "public"`, `instruments` and/or `history` |
| SPY/XSP option candidates | `SPS_PUBLIC_OPTIONS_APPROVED=true`, optional `SPS_PUBLIC_OPTIONS_LABEL` | `SPS_PUBLIC_OPTIONS_URL`, optional `SPS_PUBLIC_OPTIONS_TOKEN` | `distribution: "public"`, `entries` and/or `chains` |

Set only the approved lane; the other lane can remain disconnected or use its own authorized vendor. Each lane reads only its listed fields, even when an adapter returns extra data. Configure `SPS_PUBLIC_FEED_APPROVED`, `SPS_PUBLIC_FEED_LABEL`, `SPS_PUBLIC_FEED_URL`, and optional `SPS_PUBLIC_FEED_TOKEN` for the legacy combined adapter. A dedicated setting takes precedence for that lane; an unapproved or failing dedicated feed does not silently fall back to the combined feed. Both source states are reported in `sources` (`connected`, `unavailable`, or `unconfigured`). A connected endpoint is not proof of fresh or complete data; the market, chart and candidate sections report their own status and timestamps. A broker/private-marked input is rejected, and the deployed artifacts are explicitly allowlisted. The distribution field is an adapter assertion, not a substitute for checking the vendor agreement.

## Server response

- `instruments` object with keys SPY, SPX, XSP, VIX (any subset). Each object has positive `spot`, timezone-qualified ISO `as_of`, and optionally `prior_close`, `sma200`, and `high252_close`. Prior statistics must be available before the session and use the previous completed regular session. To calculate the live gate, provide both SPY and SPX cash checks; the XSP entry uses SPX.
- `entries` object with any of SPY and XSP. Each value has `entry_date`, `expiry` (ISO dates), `verified_next_session: true`, `selection_as_of`, `as_of` (both timezone-qualified), `short_strike`, `long_strike`, `delta` (short signed put delta from selection), and current `short_bid`, `short_ask`, `long_bid`, `long_ask`. The adapter must freeze the research candidate at the defined selection time, with next regular-session expiry independently verified against its exchange calendar; Wednesday-before-holiday isn't calendar +1. Opening candidates should be chosen once from a contemporaneous chain (nearest −0.10Δ, valid quotes, same-expiry wing), with no different contract substituted after observing outcomes. The site only validates and displays the supplied candidate, rather than asserting a historical or executable fill.
- SPY is a distinct selector at 10:30 ET, nominal W15 with permitted historical 13–17 width. XSP is a distinct selector at 09:45 ET, exact W15; production adapter must reproduce the same-expiry parity inputs, not infer an XSP chain from SPY. Filtered candidate quotes must come from 10:45–16:00 ET on entry session. Dashboard polling is not execution at the original 10:45 timestamp.
- Data is stale once the individual observation is more than 90 minutes old. Missing/crossed quotes, wrong wing/delta, nonpositive credit, wrong clock/day, or no verified expiry produce no valid candidate. A known event blocks when FOMC falls on entry or when FOMC/CPI/NFP falls on expiry. Incomplete event inputs or missing prior statistics cannot generate a pass. Candidate terms are indicative and use two-leg natural quotes; risk estimate includes $2.80 per spread in model fees. A candidate published as a research observation is not a trade instruction.

Pages serves public artifacts and cannot protect vendor data at the browser layer. Check the vendor's rules for derived data even if no raw chain is retained. For example, the [Cboe delayed quote webpage](https://www.cboe.com/delayed_quotes/api/) prohibits automated extraction; the optional [licensed Cboe DataShop API](https://datashop.cboe.com/cboe-all-access-api) has separate redistribution terms.

## Daily charts

To allow public SPX/VIX daily charts, separately set `SPS_PUBLIC_HISTORY_APPROVED=true` after obtaining permission to publish both the daily close series and moving averages. The market lane can operate without an options feed. Supply `history.SPX` and `history.VIX` objects, each with an ISO `as_of` and `bars: [{date, close, complete?}]`. All bars must be completed regular US daily closes. For a same-day bar, set `complete:true`; nothing can enter a same-day daily bar before 16:15 ET. Use approximately 280–300 trading sessions so SMA200 has a full lookback for the entire visible 3-month window. Only the recent 100 calendar days and their computed 20/50/200-session averages are published. A fresh check is not a fresh market closing bar. If index data is unavailable, the page presents separately attributed native reference embeds and links to the index charts on their source websites. Embeds are display-only and do not populate the DB. Neither cash index is substituted with an ETF, futures contract or CFD.

## Optional automatic pairing

Alternatively supply `chains.SPY` and/or `chains.XSP` with the same entry/expiry/clock metadata as `entries`, plus two arrays:

- `selection_puts`: the frozen selection book (10:30 ET for SPY, 09:45 ET for XSP); each row is `{type:"put", expiry, strike, delta, bid, ask}`.
- `quote_puts`: fresh quotes from the same verified expiry (`{type:"put", expiry, strike, bid, ask}`) at the provided `as_of` time. Use one coherent snapshot. It must be 10:45–16:00 ET to qualify under this tracker. A proper adapter is responsible for official session calendars and XSP’s contemporaneous chain/delta input. An hourly job cannot reconstruct a missed exact-time snapshot from a later quote; a provider must retain the original observation.

The tracker chooses the short put closest to −0.10 from the frozen book (signed delta range −0.15 to −0.05; ties use higher bid then lower strike). It requires XSP’s exact 15-point wing and prefers an exact 15-point SPY wing (allowed fallback width 13–17). Update quotes are used only for the selected legs, not for chasing a different strike later. Missing or crossed quotes, ambiguous duplicate strikes and missing selected legs leave the candidate unavailable. The output includes the selected two legs' bid/ask only, estimated natural opening credit (short bid minus long ask), natural closing debit (short ask minus long bid), the as-of timestamp, and an indicative entry-gate result. No full chain is published.

## Real-time vendor options

- [ThetaData Commercial](https://www.thetadata.net/commercial-use): first option for continuity with the research source. Ask for real-time OPRA SPY and native XSP bid/ask, strike Greeks and timestamped snapshots, plus the separate SPX/VIX Cboe index service and daily history.
- [Massive Options for Business](https://massive.com/business-options): ask for real-time OPRA bid/ask plus SPX/VIX index entitlements and confirmation that native XSP weeklies and Greeks are supported as requested. Quote timestamps and current SPY/XSP next-session expiries are required for the adapter.
- [Cboe All Access API](https://datashop.cboe.com/cboe-all-access-api): ask for real-time Cboe index and OPRA options entitlements, daily SPX/VIX history, and permission for an anonymous public site with downloadable JSON.
- [Yahoo Finance’s data-provider policy](https://help.yahoo.com/kb/SLN2310.html) does not grant public redistribution. The project has no Yahoo scrapers or unofficial Yahoo APIs. Yahoo links are for direct human viewing only.

No vendor is activated by default. Request written confirmation for the intended delay/latency, every index and option class, public anonymous users, derived signals and downloadable history/JSON. Do not place a credential in site JavaScript, a git commit, or the public JSON.

## Published watchlist

`watchlist` in `site/data/status.json` is a display lane separate from the licensed market/options feeds. It reads the owner's already-published [Market Data Watchlist](https://pepe760.github.io/market-data-pipeline/#watchlist) using its public JSON and matching SPY shards. It accepts only the exact USD SPY ETF from the Watchlist; no raw provider APIs, private ingestion or account data are used. The displayed ETF observation is the newer eligible upstream price or last completed 15-minute bar. Original observation time, data kind and freshness travel with it. When the upstream is unreachable, a recent prior observation is retained only as stale.

`watchlist.spy_history` uses the published SPY vendor-adjusted daily closes. An upstream bar marked partial is excluded, then SMA20/50/200 are calculated from the preceding completed sessions. A completed 15-minute bar does not become an adjusted daily close. Neither this display lane nor the SPY chart populates strategy gates, SPX/VIX/XSP prices, option chains, or strike selection. Native symbols only come from their own correctly identified authorized market source.
