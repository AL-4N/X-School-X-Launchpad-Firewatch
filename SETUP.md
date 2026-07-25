# Firewatch Backend — Setup & Deploy

A Cloudflare Worker that serves the Firewatch frontend and proxies all
third-party APIs (NASA FIRMS, NASA EONET, Open-Meteo, optionally
OpenWeatherMap) so no API key ever reaches the browser.

## What's included

```
firewatch-backend/
├── src/
│   ├── index.js       — Worker entrypoint, routes /api/* + serves static assets
│   ├── fwi.js          — Canadian FWI System (Van Wagner 1987), real equations
│   ├── fwiCache.js     — KV-backed day-to-day carry-forward for FFMC/DMC/DC
│   ├── weather.js      — Open-Meteo weather fetch
│   ├── airquality.js   — Open-Meteo + OpenWeatherMap AQI proxies
│   ├── fires.js        — NASA FIRMS local + global fire detections
│   ├── incidents.js    — NASA EONET global wildfire incident feed
│   └── geocode.js      — forward search + reverse geocoding
├── public/
│   ├── index.html, app.js, styles.css   — the frontend (served as static assets)
├── wrangler.toml
└── package.json
```

## 1. Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ (you already have this)
- A free NASA FIRMS `MAP_KEY` — you mentioned you already have one. If you
  ever need a new one: https://firms.modaps.eosdis.nasa.gov/api/ → "Get
  MAP_KEY" → confirm via email. It arrives instantly.
- (Optional) A free OpenWeatherMap API key from https://openweathermap.org/api
  — only needed if you want the "OpenWeatherMap" AQI source toggle in the
  UI to work. The default "Open-Meteo" AQI source needs no key at all.

## 2. Install dependencies

```bash
cd firewatch-backend
npm install
```

This installs `wrangler`, Cloudflare's CLI, as a dev dependency.

## 3. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser window to authorize the CLI against your account.

## 4. Create the KV namespace (for FWI day-to-day carry-forward)

```bash
npx wrangler kv namespace create FWI_CACHE
```

This prints something like:
```
[[kv_namespaces]]
binding = "FWI_CACHE"
id = "a1b2c3d4e5f6..."
```

Copy the `id` value into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

> If you skip this step, the app still works — `fwiCache.js` degrades
> gracefully to "cold start" mode (FWI resets to standard values every
> request instead of accumulating drought history day-to-day). The FWI
> numbers will be somewhat less accurate in sustained dry/wet spells, but
> nothing breaks.

## 5. Set your API key secrets

```bash
npx wrangler secret put FIRMS_MAP_KEY
# paste your FIRMS MAP_KEY when prompted

# Optional — only if you want the OpenWeatherMap AQI source to work:
npx wrangler secret put OWM_API_KEY
```

Secrets are encrypted and never appear in `wrangler.toml` or your repo.

## 6. Run it locally

```bash
npm run dev
```

This starts a local dev server (usually `http://localhost:8787`) with the
full Worker + static assets. Open it and allow location access — you
should see live weather, FWI, fire, and AQI data for your actual location.

**Local KV note:** `wrangler dev` uses a local simulated KV store by
default, so day-to-day carry-forward won't persist between separate `dev`
sessions unless you pass `--persist-to` — that's expected and fine for
testing; it'll persist correctly once deployed.

## 7. Deploy

```bash
npm run deploy
```

Wrangler prints your live URL, something like:
```
https://firewatch.<your-subdomain>.workers.dev
```

That's it — frontend and backend are live on the same origin, so there's
no CORS configuration needed anywhere.

## 8. (Optional) Custom domain

In the Cloudflare dashboard → Workers & Pages → your `firewatch` worker →
Settings → Domains & Routes → Add a custom domain you own on Cloudflare.

## Verifying it's working

Once deployed (or running locally), these should all return JSON:

```bash
curl "https://your-worker-url/api/geocode?lat=37.7749&lon=-122.4194"
curl "https://your-worker-url/api/risk?lat=37.7749&lon=-122.4194"
curl "https://your-worker-url/api/fires?lat=37.7749&lon=-122.4194"
curl "https://your-worker-url/api/airquality?lat=37.7749&lon=-122.4194&source=openmeteo"
curl "https://your-worker-url/api/incidents/global?days=30"
```

If `/api/fires` or `/api/fires/global` return an error mentioning
`FIRMS_MAP_KEY`, double check step 5 — that's almost always a missing or
mistyped secret.

## Rate limits & caching (good to know)

- **FIRMS**: each MAP_KEY has a shared transaction quota across all your
  requests. The Worker edge-caches `/api/fires` and `/api/fires/global`
  responses (5–10 min) so multiple visitors checking similar locations
  don't multiply your FIRMS usage.
- **Open-Meteo**: generous free tier, no key needed, no practical limit
  for an app this size.
- **NASA EONET**: free, no key, no documented hard limit.
- **BigDataCloud reverse geocoding**: free tier is rate-limited per IP;
  fine for normal personal/small-scale use.

## What's NOT included here

The satellite pixel-imagery analysis endpoint described in
`satellite-imagery-backend-spec.md` (burn severity from Sentinel-2/Landsat,
smoke plume segmentation) is a separate, much larger build — it needs
Copernicus/USGS credentials, large raster downloads, and real image
processing that's a poor fit for a Worker's CPU/memory limits. This
backend covers everything the current frontend (`app.js`) actually calls.
