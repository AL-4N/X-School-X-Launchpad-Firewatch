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
 *   GET /api/fires/tiles/{z}/{x}/{y}  -> NASA FIRMS WMS tile passthrough
 *   GET /api/earthquakes?lat=&lon=
 *   GET /api/flood?lat=&lon=
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/api/risk') return handleRisk(url);
      if (url.pathname === '/api/airquality') return handleAirQuality(url, env);
      if (url.pathname === '/api/fires') return handleFires(url, env);
      if (url.pathname.startsWith('/api/fires/tiles/')) return handleFireTiles(url, request, env);
      if (url.pathname === '/api/earthquakes') return handleEarthquakes(url);
      if (url.pathname === '/api/flood') return handleFlood(url);
      if (url.pathname === '/api/geocode') return handleGeocode(url);
      if (url.pathname === '/api/geocode/search') return handleGeocodeSearch(url);
      if (url.pathname === '/api/incidents/global') return handleGlobalIncidents(url);
      if (url.pathname === '/api/health') return json({ status: 'ok' });

      return json({ error: 'Not found' }, 404);
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
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation` +
    `&daily=precipitation_sum&past_days=7&forecast_days=1&timezone=auto`;

  const res = await fetch(weatherUrl);
  if (!res.ok) return json({ error: 'Upstream weather provider error' }, 502);
  const data = await res.json();

  const temp = data.current.temperature_2m;
  const wind = data.current.wind_speed_10m;
  const humidity = data.current.relative_humidity_2m;
  const rainToday = data.current.precipitation ?? 0;
  const rain7d = (data.daily.precipitation_sum || []).reduce((a, b) => a + (b || 0), 0);

  const fwiResult = computeFWI({ temp, rh: humidity, wind, rain24h: rainToday }, lat, new Date());

  return json({
    weather: {
      temp, wind, humidity,
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

async function handleFires(url, env) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  if (!env.FIRMS_MAP_KEY) return json({ error: 'FIRMS key not configured on server' }, 500);

  const d = parseFloat(env.FIRMS_RADIUS_DEG || '0.6');
  const bbox = `${(lon - d).toFixed(2)},${(lat - d).toFixed(2)},${(lon + d).toFixed(2)},${(lat + d).toFixed(2)}`;
  const firmsUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/${bbox}/1`;

  const res = await fetch(firmsUrl);
  if (!res.ok) return json({ error: 'Upstream FIRMS error' }, 502);
  const text = await res.text();
  const rows = text.trim().split('\n');
  if (rows.length <= 1) return json({ count: 0, fires: [] });

  const header = rows[0].split(',');
  const latIdx = header.indexOf('latitude');
  const lonIdx = header.indexOf('longitude');
  const brightIdx = header.indexOf('bright_ti4');
  const confIdx = header.indexOf('confidence');
  const dateIdx = header.indexOf('acq_date');
  const timeIdx = header.indexOf('acq_time');

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
    });
  }

  return json({ count: fires.length, fires });
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
    `?REQUEST=GetMap&LAYERS=fires_viirs_snpp_24` +
    `&SRS=EPSG:4326&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE&VERSION=1.1.1`;

  const res = await fetch(wmsUrl);
  if (!res.ok) return new Response('Upstream FIRMS tile error', { status: 502 });
  return new Response(res.body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS },
  });
}

function tileToBBox(x, y, z) {
  const n = Math.pow(2, z);
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const latMax = (latRadMax * 180) / Math.PI;
  const latMin = (latRadMin * 180) / Math.PI;
  return [lonMin, latMin, lonMax, latMax];
}

/* ---------------- Earthquakes (USGS) ---------------- */

async function handleEarthquakes(url) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  const res = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson');
  if (!res.ok) return json({ error: 'Upstream USGS error' }, 502);
  const data = await res.json();

  const nearby = data.features
    .map((f) => {
      const [flon, flat] = f.geometry.coordinates;
      const distKm = haversine(lat, lon, flat, flon);
      return {
        mag: f.properties.mag,
        place: f.properties.place,
        time: f.properties.time,
        lat: flat,
        lon: flon,
        distKm: Math.round(distKm),
      };
    })
    .filter((f) => f.distKm <= 500)
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 10);

  return json({ count: nearby.length, earthquakes: nearby });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------------- River flood risk (Open-Meteo) ---------------- */

async function handleFlood(url) {
  const coords = parseLatLon(url);
  if (!coords) return badRequest('lat and lon query params are required and must be valid');
  const { lat, lon } = coords;

  const floodUrl = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lon}&daily=river_discharge,river_discharge_mean`;
  const res = await fetch(floodUrl);
  if (!res.ok) return json({ error: 'Upstream flood provider error' }, 502);
  const data = await res.json();

  const discharge = data.daily?.river_discharge?.[0] ?? null;
  const mean = data.daily?.river_discharge_mean?.[0] ?? null;

  return json({ discharge, mean, hasData: discharge != null && mean != null });
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

  const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6`;
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': 'FirewatchApp/1.0 (contact: set-your-email-here)' },
  });
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