# Connect the public XSP desk to a live feed

GitHub Pages serves the desk. A separate, operator-hosted read-only service serves the data at `/desk.json`. The Pages build can also publish a fallback status snapshot. A Pages rebuild is not the live data path.

## 1. Prepare the data feeds

Use provider adapters whose contracts allow this site to publicly display the selected quotes and VIX history. See [vendor and verification notes](RELEASE_PUB_LIVE.md) and [adapter format](FEED_SCHEMA.md).

The server reads the same market/options lanes as `scripts/refresh.py`. Set these variables in the service's protected environment:

| Variable | Purpose |
| --- | --- |
| `SPS_PUBLIC_MARKET_APPROVED=true` | Enable the public-display-licensed market adapter. |
| `SPS_PUBLIC_MARKET_URL`, `SPS_PUBLIC_MARKET_LABEL` | Approved HTTPS adapter and public display label. Market data should contain timestamped XSP, SPX and VIX. |
| `SPS_PUBLIC_MARKET_TOKEN` | Optional adapter token, held on the server. |
| `SPS_PUBLIC_OPTIONS_APPROVED=true` | Enable the public-display-licensed options adapter. |
| `SPS_PUBLIC_OPTIONS_URL`, `SPS_PUBLIC_OPTIONS_LABEL` | Approved HTTPS adapter offering the native XSP chain/legs and source timestamps. |
| `SPS_PUBLIC_OPTIONS_TOKEN` | Optional adapter token, held on the server. |
| `SPS_PUBLIC_HISTORY_APPROVED=true` | Publish up to three months of provider VIX closes, only when historical display is licensed too. |

Use the label for publication attribution, never a token or an internal URL. Keep all provider credentials out of the repository, browser, logs, and Pages variables. Do not supply a personal brokerage connection to the public service.

## 2. Run the local service behind HTTPS

On your operator host (Python 3.11+ and time-zone data), start the process from the repository root. Run it under the host's service manager for restart and credential injection.

```sh
python3 scripts/serve_desk.py --port 8788 --poll-seconds 12
```

It binds to `127.0.0.1`, not a public interface. Expose only `/desk.json` through an HTTPS reverse proxy on that host. Here is the mapping for an existing Caddy installation; replace the example hostname with yours:

```caddyfile
desk.example.net {
    handle /desk.json {
        reverse_proxy 127.0.0.1:8788
    }
    handle {
        respond "Not found" 404
    }
}
```

Preserve the service's `Cache-Control: no-store`; do not add CDN caching or wildcard CORS. The browser origin is fixed at `https://pepe760.github.io`, with no cross-origin credentials. The route is public and read-only; the CORS policy does not make data confidential.

The service polls the providers independently of browser traffic, with one refresh in progress and 12 seconds between completed refreshes by default. A cache older than one minute is not used for the quote lanes. Actual quote freshness uses provider/exchange timestamps, never the server's refresh time. Official event calendars refresh every 30 minutes and become unavailable if their cache expires. A current calendar fetch still does not establish coverage for every trade date.

## 3. Connect GitHub Pages

Confirm the endpoint responds successfully, uses its public hostname, and returns only the approved desk snapshot:

```sh
curl -i -H 'Origin: https://pepe760.github.io' https://desk.example.net/desk.json
```

Expect `Access-Control-Allow-Origin: https://pepe760.github.io` and JSON containing only `checked_at`, `desk` and `events`. Check the timestamps, availability, and missing-data behavior before publishing.

In repository Actions variables, set `SPS_PUBLIC_LIVE_DESK_URL` to that public HTTPS endpoint and `SPS_PUBLIC_LIVE_DESK_APPROVED=true` after confirming publication rights. Rebuild Pages. The frontend uses this URL without credentials; it continues to label delayed, stale and unavailable data instead of treating the connection itself as proof of real-time data.
