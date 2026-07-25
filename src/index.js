/**
 * index.js — Firewatch Worker
 *
 * Serves the static frontend (index.html/app.js/styles.css, via
 * Cloudflare's static assets binding) AND the /api/* backend on the same
 * origin, so the frontend's same-origin fetches need no CORS handling.
 *
 * All third-party API keys (FIRMS_MAP_KEY, OWM_API_KEY) live as Worker
 * secrets and are never sent to the browser.
 */

import { computeFwiSystem } from './fwi.js';
import { fetchWeather } from './weather.js';
import { fetchAirQuality } from './airquality.js';
import { fetchLocalFires, fetchGlobalFires } from './fires.js';
import { fetchGlobalIncidents } from './incidents.js';
import { forwardGeocode, reverseGeocode } from './geocode.js';
import { getPrevCodes, saveCodes } from './fwiCache.js';

const JSON_HEADERS = { 'content-type': 'application/json;charset=UTF-8' };

function json(data, init){
  return new Response(JSON.stringify(data), { headers: JSON_HEADERS, ...init });
}

function errorResponse(err, status = 502){
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: message }, { status });
}

function requireLatLon(url){
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if(!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180){
    throw Object.assign(new Error('Valid lat/lon query params are required'), { status: 400 });
  }
  return { lat, lon };
}

/** Cache GET responses at Cloudflare's edge for a short TTL — these are
 * all "current conditions" endpoints that don't need per-second
 * freshness, and this meaningfully cuts upstream API calls (and FIRMS'
 * per-key rate limit exposure) when multiple users check the same area. */
async function withEdgeCache(request, ctx, ttlSeconds, handler){
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cached = await cache.match(cacheKey);
  if(cached) return cached;

  const response = await handler();
  if(response.status === 200){
    const toCache = new Response(response.body, response);
    toCache.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    return toCache;
  }
  return response;
}

const routes = {
  '/api/risk': async (url, env) => {
    const { lat, lon } = requireLatLon(url);
    const weather = await fetchWeather(lat, lon);
    const prevCodes = await getPrevCodes(lat, lon, env);
    const fwi = computeFwiSystem({
      temp: weather.temp,
      rh: weather.humidity,
      wind: weather.wind,
      rain24h: weather.rain24h,
      month: weather.month,
      prevCodes,
    });
    // Fire-and-forget: persist today's codes for tomorrow's carry-forward,
    // without making the response wait on the KV write.
    await saveCodes(lat, lon, fwi.codes, env);
    return json({ weather, fwi });
  },

  '/api/fires': async (url, env) => {
    const { lat, lon } = requireLatLon(url);
    const data = await fetchLocalFires(lat, lon, env);
    return json(data);
  },

  '/api/fires/global': async (_url, env) => {
    const data = await fetchGlobalFires(env);
    return json(data);
  },

  '/api/airquality': async (url, env) => {
    const { lat, lon } = requireLatLon(url);
    const source = url.searchParams.get('source') || 'openmeteo';
    const data = await fetchAirQuality(lat, lon, source, env);
    return json(data);
  },

  '/api/geocode': async (url) => {
    const { lat, lon } = requireLatLon(url);
    const data = await reverseGeocode(lat, lon);
    return json(data);
  },

  '/api/geocode/search': async (url) => {
    const q = url.searchParams.get('q');
    if(!q || q.trim().length < 2){
      throw Object.assign(new Error('Query param "q" (2+ chars) is required'), { status: 400 });
    }
    const data = await forwardGeocode(q.trim());
    return json(data);
  },

  '/api/incidents/global': async (url) => {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    const data = await fetchGlobalIncidents(Number.isFinite(days) ? days : 30);
    return json(data);
  },
};

// Per-route edge-cache TTLs (seconds). Fires and weather change fastest;
// geocoding and global incident lists are stable for longer.
const CACHE_TTL = {
  '/api/risk': 300,           // 5 min
  '/api/fires': 300,          // 5 min
  '/api/fires/global': 600,   // 10 min — larger payload, changes less per-user-relevantly
  '/api/airquality': 300,     // 5 min
  '/api/geocode': 86400,      // 1 day — a lat/lon's place name doesn't change
  '/api/geocode/search': 3600,// 1 hr
  '/api/incidents/global': 900, // 15 min
};

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname.startsWith('/api/')){
      const handler = routes[url.pathname];
      if(!handler){
        return json({ error: 'Not found' }, { status: 404 });
      }
      if(request.method !== 'GET'){
        return json({ error: 'Method not allowed' }, { status: 405 });
      }

      const ttl = CACHE_TTL[url.pathname];

      try{
        if(ttl){
          return await withEdgeCache(request, ctx, ttl, () => handler(url, env));
        }
        return await handler(url, env);
      }catch(err){
        return errorResponse(err, err.status || 502);
      }
    }

    // Non-API requests fall through to static assets (index.html, app.js,
    // styles.css), served via the ASSETS binding configured in wrangler.toml.
    if(env.ASSETS){
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
