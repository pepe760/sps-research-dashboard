# Deploy the automatic XSP collector

GitHub Pages remains the frontend. This setup runs the collector independently of web visitors, keeps the daily selection in persistent state, and exposes only the public desk at `/desk.json`. It has no order execution or manual chain input.

On an always-on Linux host, use Python 3.11 or 3.12, systemd 247+, CA certificates, time-zone data, and Caddy 2. Point a DNS name (e.g. `desk.example.net`) at the host and allow inbound HTTPS; Caddy also needs port 80 for the default HTTP validation and redirects. Install the chosen repository revision at `/opt/sps-research-dashboard`, with code owned by the administrator and readable by the service. Runtime dependencies are Python's standard library only.

## 1. Configure the provider once

A Massive business entitlement must cover the actual XSP options quotes/Greeks and index data used by the desk, and the proposed public website/JSON delivery. Check the exact scope with Massive before setting public approval. Keep the key in the service host; do not add it to GitHub Pages.

```sh
sudo install -d -m 0700 /etc/sps-desk
sudo install -m 0600 deploy/provider.env.example /etc/sps-desk/provider.env
sudoedit /etc/sps-desk/provider.env
sudo touch /etc/sps-desk/massive-api-key
sudo chmod 0600 /etc/sps-desk/massive-api-key
sudoedit /etc/sps-desk/massive-api-key
```

Place only the API key in the credential file. Set `SPS_MASSIVE_PUBLIC_APPROVED=true` after authorization; enable historical display only if also covered. systemd creates `/var/lib/sps-desk` for state, writable only by the service. Keep this directory across restarts and upgrades, run a single collector instance per state path, and keep the host clock synchronized.

## 2. Start the collector and HTTPS proxy

```sh
sudo install -m 0644 deploy/sps-desk.service /etc/systemd/system/sps-desk.service
sudo systemctl daemon-reload
sudo systemctl enable --now sps-desk
systemctl is-active sps-desk
```

Add the site block from [Caddyfile.example](Caddyfile.example) to your Caddy configuration using your hostname. Validate and reload the configuration:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl -fsSi -H 'Origin: https://pepe760.github.io' https://desk.example.net/desk.json
```

Check the expected desk JSON and response headers `Access-Control-Allow-Origin: https://pepe760.github.io` and `Cache-Control: no-store`. A successful HTTP response alone does not prove licensed live quotes; check provider freshness, the real session window, and the candidate status. The collector listens only on `127.0.0.1:8788`; do not expose it directly or add a CDN cache. Reboot protection is provided by systemd's enabled service and restart policy.

## 3. Turn on the public page

In the GitHub repository's Actions **Variables**, set `SPS_PUBLIC_LIVE_DESK_URL` to the public HTTPS `/desk.json` URL and `SPS_PUBLIC_LIVE_DESK_APPROVED=true`. Run the Pages workflow once to publish the configuration; its periodic build is not the intraday scheduler. The browser polls the live backend automatically. Never put a provider key in the URL.

For public and vendor details, see [LIVE_DASHBOARD.md](../LIVE_DASHBOARD.md) and [RELEASE_PUB_LIVE.md](../RELEASE_PUB_LIVE.md).
