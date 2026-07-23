/**
 * Firewatch Worker
 * -----------------------------------------------------------------------
 * Single Cloudflare Worker that proxies every external data source the
 * Firewatch frontend needs. The browser only ever talks to this Worker;
 * it never sees FIRMS_MAP_KEY or OWM_API_KEY. Those live as Worker
 * secrets (set via `wrangler secret put`) and are injected into `env`
 * at request time — never present in source, never sent to the client.
 *
 * Routes:
 *   GET /api/risk?lat=&lon=          -> weather + computed FWI risk
 *   GET /api/airquality?lat=&lon=&source=openmeteo|openweathermap
 *   GET /api/fires?lat=&lon=          -> NASA FIRMS point detections (CSV->JSON)
 *   GET /api/fires/global             -> whole-world FIRMS snapshot, cached 5min
 *   GET /api/fires/tiles/{z}/{x}/{y}  -> NASA FIRMS WMS tile passthrough
 *   GET /api/geocode?lat=&lon=        -> reverse geocoding (place name)
 *   GET /api/geocode/search?q=        -> forward geocoding (place search, for location picker)
 *   GET /api/incidents/global?days=   -> NASA EONET wildfire events worldwide (open + closed)
 * -----------------------------------------------------------------------
 */

import { computeFWI } from './fwi-engine.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your frontend's exact origin before production use
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function parseLatLon(url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** GET-request cache TTLs (seconds) by path, checked most-specific prefix
 * first. Every upstream here is a free-tier API (FIRMS, Open-Meteo, USGS-
 * successor Nominatim, EONET) — caching identical requests protects those
 * quotas, speeds up repeat visits, and blunts naive request-spam abuse
 * (varying lat/lon still bypasses it, which is a separate rate-limiting
 * concern, not something caching alone solves). */
const CACHE_TTL_BY_PREFIX = [
  { prefix: '/api/fires/global', ttl: 300 },
  { prefix: '/api/fires/tiles/', ttl: 300 },
  { prefix: '/api/fires', ttl: 180 },
  { prefix: '/api/risk', ttl: 300 },
  { prefix: '/api/airquality', ttl: 300 },
  { prefix: '/api/geocode/search', ttl: 600 },
  { prefix: '/api/geocode', ttl: 1800 },
  { prefix: '/api/incidents/global', ttl: 600 },
];

function cacheTtlFor(pathname) {
  const match = CACHE_TTL_BY_PREFIX.find(({ prefix }) => pathname.startsWith(prefix));
  return match ? match.ttl : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const ttl = request.method === 'GET' ? cacheTtlFor(url.pathname) : null;
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    if (ttl) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    try {
      let response;
      if (url.pathname === '/api/risk') response = await handleRisk(url);
      else if (url.pathname === '/api/airquality') response = await handleAirQuality(url, env);
      else if (url.pathname === '/api/fires/global') response = await handleGlobalFires(url, env);
      else if (url.pathname === '/api/fires') response = await handleFires(url, env);
      else if (url.pathname.startsWith('/api/fires/tiles/')) response = await handleFireTiles(url, request, env);
      else if (url.pathname === '/api/geocode/search') response = await handleGeocodeSearch(url);
      else if (url.pathname === '/api/geocode') response = await handleGeocode(url);
      else if (url.pathname === '/api/incidents/global') response = await handleGlobalIncidents(url);
      else if (url.pathname === '/api/health') response = json({ status: 'ok' });
      else response = json({ error: 'Not found' }, 404);

      // Only successful responses are cached — an upstream 502/500 stays
      // uncached so the very next request retries fresh instead of being
      // stuck serving a cached failure for the TTL window.
      if (ttl && response.status === 200) {
        const toCache = new Response(response.body, response);
        toCache.headers.set('Cache-Control', `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
        return toCache;
      }
      return response;
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error', detail: String(err) }, 500);
    }
  },
};

/* ---------------- Weather + FWI risk ---------------- */

async function handleRisk(url) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,apparent_temperature` +
    `&daily=precipitation_sum&past_days=7&forecast_days=1&timezone=auto`;

  const res = await fetch(weatherUrl);
  if (!res.ok) return json({ error: 'Upstream weather provider error' }, 502);
  const data = await res.json();

  const temp = data.current?.temperature_2m;
  const wind = data.current?.wind_speed_10m;
  const windDir = data.current?.wind_direction_10m ?? null;
  const humidity = data.current?.relative_humidity_2m;
  const rainToday = data.current?.precipitation ?? 0;
  const rain7d = (data.daily?.precipitation_sum || []).reduce((a, b) => a + (b || 0), 0);
  const feelsLike = data.current?.apparent_temperature ?? temp;

  // Stop bad upstream data here rather than letting it silently propagate
  // through the FWI math as NaN — see fwi-engine.js for what that produces.
  if (![temp, wind, humidity].every(Number.isFinite)) {
    return json({ error: 'Upstream weather provider returned incomplete data' }, 502);
  }

  const fwiResult = computeFWI({ temp, rh: humidity, wind, rain24h: rainToday }, lat, new Date());

  return json({
    weather: {
      temp, wind, windDir, humidity, feelsLike,
      rain24h: rainToday,
      rain7d: Math.round(rain7d * 10) / 10,
    },
    fwi: fwiResult,
  });
}

/* ---------------- Air quality (dual source) ---------------- */

async function handleAirQuality(url, env) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;
  const source = url.searchParams.get('source') || 'openmeteo';

  if (source === 'openweathermap') {
    if (!env.OWM_API_KEY) return json({ error: 'OpenWeatherMap key not configured on server' }, 500);
    const owmUrl = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${env.OWM_API_KEY}`;
    const res = await fetch(owmUrl);
    if (!res.ok) return json({ error: 'Upstream OpenWeatherMap error' }, 502);
    const data = await res.json();
    const entry = data.list?.[0];
    if (!entry) return json({ error: 'No air quality data for this location' }, 404);
    return json({
      source: 'openweathermap',
      scale: '1-5',
      aqi: entry.main.aqi,
      components: entry.components,
    });
  }

  // default: Open-Meteo, no key required
  const omUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5&timezone=auto`;
  const res = await fetch(omUrl);
  if (!res.ok) return json({ error: 'Upstream Open-Meteo error' }, 502);
  const data = await res.json();
  const aqi = data.current?.us_aqi;
  if (aqi == null) return json({ error: 'No air quality data for this location' }, 404);
  return json({
    source: 'openmeteo',
    scale: 'us-aqi',
    aqi: Math.round(aqi),
    pm2_5: data.current?.pm2_5 ?? null,
  });
}

/* ---------------- Fires (NASA FIRMS) ---------------- */

/** Single-satellite NRT products have real, non-fire-related coverage gaps —
 * polar orbiters pass over different longitude bands at different times, and
 * near-real-time processing lags differently by region, so "last 24h" from
 * one satellite can look empty over say Asia while another satellite has
 * nothing but Asia. Combining sources is how FIRMS' own map avoids this. */
const FIRMS_SOURCES = ['VIIRS_NOAA21_NRT', 'MODIS_NRT'];

/** Parses a FIRMS Area API CSV response into our fire-detection shape.
 * Handles both VIIRS ("bright_ti4") and MODIS ("brightness") column naming.
 * Shared by the local (near-user) and global (whole-world) fire routes. */
function parseFirmsCsv(text) {
  // Split on \r\n or \n so Windows-style FIRMS downloads don't leave \r
  // on the last field of every row, which would cause indexOf to miss it.
  const rows = text.trim().split(/\r?\n/);
  if (rows.length <= 1) return [];

  // Strip any stray \r from individual fields (guards against mixed endings).
  const header = rows[0].split(',').map(h => h.trim());
  const latIdx = header.indexOf('latitude');
  const lonIdx = header.indexOf('longitude');

  // If the required coordinate columns are absent the schema has changed;
  // bail out explicitly rather than silently yielding zero fires per row.
  if (latIdx === -1 || lonIdx === -1) return [];

  const brightIdx = header.indexOf('bright_ti4') >= 0 ? header.indexOf('bright_ti4') : header.indexOf('brightness');
  const confIdx = header.indexOf('confidence');
  const dateIdx = header.indexOf('acq_date');
  const timeIdx = header.indexOf('acq_time');
  const frpIdx = header.indexOf('frp');

  const fires = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split(',');
    const flat = parseFloat(cols[latIdx]);
    const flon = parseFloat(cols[lonIdx]);
    if (Number.isNaN(flat) || Number.isNaN(flon)) continue;
    fires.push({
      lat: flat,
      lon: flon,
      brightness: brightIdx >= 0 ? parseFloat(cols[brightIdx]) : null,
      confidence: confIdx >= 0 ? cols[confIdx] : null,
      date: dateIdx >= 0 ? cols[dateIdx] : null,
      time: timeIdx >= 0 ? cols[timeIdx] : null,
      frp: frpIdx >= 0 ? parseFloat(cols[frpIdx]) : null,
    });
  }
  return fires;
}

/** Fetches and merges detections across all configured satellites for one
 * bbox/day-range. A failure on one source just means that source contributes
 * nothing — it doesn't fail the whole request. */
async function fetchFirmsMulti(env, bbox, days) {
  const results = await Promise.all(
    FIRMS_SOURCES.map(async (source) => {
      try {
        const firmsUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/${source}/${bbox}/${days}`;
        const res = await fetch(firmsUrl);
        if (!res.ok) return [];
        return parseFirmsCsv(await res.text());
      } catch {
        return [];
      }
    })
  );
  return results.flat();
}

/** Aggregates fire points onto a coarse lat/lon grid, summing FRP per cell.
 * Used only for the global ambient view — merges the many overlapping
 * pixels a single fire complex produces into one representative point,
 * cutting payload size without dropping real detections. */
function binFires(fires, gridDeg) {
  const cells = new Map();
  for (const f of fires) {
    const lat = Math.round(f.lat / gridDeg) * gridDeg;
    const lon = Math.round(f.lon / gridDeg) * gridDeg;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const existing = cells.get(key);
    const frp = f.frp || 0;
    if (existing) existing.frp += frp;
    else cells.set(key, { lat, lon, frp });
  }
  return Array.from(cells.values());
}

async function handleFires(url, env) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  if (!env.FIRMS_MAP_KEY) return json({ error: 'FIRMS key not configured on server' }, 500);

  const d = parseFloat(env.FIRMS_RADIUS_DEG || '0.6');
  const bbox = `${(lon - d).toFixed(2)},${(lat - d).toFixed(2)},${(lon + d).toFixed(2)},${(lat + d).toFixed(2)}`;
  const fires = await fetchFirmsMulti(env, bbox, 1);

  return json({ count: fires.length, fires });
}

/** Whole-world snapshot of active detections, for showing ambient fire
 * activity on the map before any location is selected / when zoomed out.
 * Cached for a few minutes since it's identical for every user. */
async function handleGlobalFires(url, env) {
  if (!env.FIRMS_MAP_KEY) return json({ error: 'FIRMS key not configured on server' }, 500);

  // 48h window (vs 24h for the local endpoint) — a single satellite's "last 24h"
  // NRT snapshot has real, non-fire-related coverage gaps by region depending on
  // orbit/processing timing; widening the window fills them in for this ambient
  // whole-world view. Binned afterward since the wider window pulls ~90k raw points.
  const fires = await fetchFirmsMulti(env, '-180,-90,180,90', 2);
  const binned = binFires(fires, 0.25);

  return json({ count: binned.length, fires: binned }, 200, { 'Cache-Control': 'public, max-age=300' });
}

/** Passes through NASA FIRMS WMS tile images. The frontend requests
 * /api/fires/tiles/{z}/{x}/{y} and this converts the XYZ tile coordinate
 * to a WMS bbox, forwards to FIRMS's mapserver with the key attached, and
 * streams the PNG back untouched. */
async function handleFireTiles(url, request, env) {
  if (!env.FIRMS_MAP_KEY) return new Response('FIRMS key not configured', { status: 500 });

  const parts = url.pathname.split('/').filter(Boolean); // ['api','fires','tiles', z, x, y]
  const [, , , z, x, y] = parts;
  if (!z || !x || !y) return badRequest('Expected /api/fires/tiles/{z}/{x}/{y}');

  const bbox = tileToBBox(Number(x), Number(y), Number(z));
  const wmsUrl =
    `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${env.FIRMS_MAP_KEY}/` +
    `?REQUEST=GetMap&LAYERS=fires_viirs_noaa21_24` +
    `&SRS=EPSG:4326&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE&VERSION=1.1.1`;

  const res = await fetch(wmsUrl);
  if (!res.ok) return new Response('Upstream FIRMS tile error', { status: 502 });
  return new Response(res.body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS },
  });
}

function tileToBBox(x, y, z) {
  const n = Math.pow(2, z);
  x = ((x % n) + n) % n; // normalize out-of-range x (wrapped world copies) before bbox math
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const latMax = (latRadMax * 180) / Math.PI;
  const latMin = (latRadMin * 180) / Math.PI;
  return [lonMin, latMin, lonMax, latMax];
}

/* ---------------- Reverse geocoding ---------------- */

async function handleGeocode(url) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`;
  const res = await fetch(geoUrl, {
    headers: { 'User-Agent': 'FirewatchApp/1.0 (contact: set-your-email-here)' },
  });
  if (res.status === 429) return json({ error: 'Geocoding service is rate-limited — try again shortly' }, 429);
  if (!res.ok) return json({ error: 'Upstream geocoding error' }, 502);
  const data = await res.json();
  const a = data.address || {};
  const name = a.town || a.city || a.village || a.suburb || a.county || a.state || data.display_name?.split(',')[0] || 'Unknown location';
  const region = a.state || a.country || '';

  return json({ name, region, displayName: region ? `${name}, ${region}` : name });
}

/* ---------------- Forward geocoding (location search/picker) ---------------- */

async function handleGeocodeSearch(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ results: [] });
  if (q.length > 200) return badRequest('q is too long');

  const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6`;
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': 'FirewatchApp/1.0 (contact: set-your-email-here)' },
  });
  if (res.status === 429) return json({ error: 'Geocoding service is rate-limited — try again shortly' }, 429);
  if (!res.ok) return json({ error: 'Upstream geocoding error' }, 502);
  const data = await res.json();

  const results = (data || []).map((r) => {
    const a = r.address || {};
    const name = a.town || a.city || a.village || a.suburb || a.county || r.display_name?.split(',')[0] || 'Unknown';
    const region = a.state || a.country || '';
    return {
      name,
      region,
      displayName: region ? `${name}, ${region}` : name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    };
  }).filter((r) => !Number.isNaN(r.lat) && !Number.isNaN(r.lon));

  return json({ results });
}

/* ---------------- Global wildfire incidents (NASA EONET) ---------------- */

async function handleGlobalIncidents(url) {
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 120);

  const eonetUrl = `https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=all&days=${days}&limit=75`;
  const res = await fetch(eonetUrl);
  if (!res.ok) return json({ error: 'Upstream EONET error' }, 502);
  const data = await res.json();

  const incidents = (data.events || [])
    .map((e) => {
      const geoms = e.geometry || [];
      const last = geoms[geoms.length - 1];
      if (!last || last.type !== 'Point' || !Array.isArray(last.coordinates)) return null;
      const [lon, lat] = last.coordinates;
      if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
      return {
        id: e.id,
        title: e.title,
        lat,
        lon,
        date: last.date,
        isClosed: !!e.closed,
        link: e.sources?.[0]?.url || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  return json({ count: incidents.length, days, incidents });
}