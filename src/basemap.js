/**
 * basemap.js — basemap tile source.
 *
 * CARTO's raster basemaps now require an API key and watermark
 * unauthenticated requests, so when CARTO_API_KEY is configured we proxy
 * their tiles with the key attached server-side (the key never reaches
 * the browser).
 *
 * Without a key the frontend renders the same Positron/Dark Matter
 * designs as keyless vector tiles from OpenFreeMap, requested directly —
 * so this handler only ever serves the CARTO path.
 *
 * Note: CARTO is retiring raster (PNG) basemaps in favour of vector
 * tiles, so the proxied path has a shelf life; the keyless default is
 * what keeps the map working if it goes away.
 */

const CARTO_STYLE = { light: 'light_all', dark: 'dark_all' };

export function basemapProvider(env){
  return env.CARTO_API_KEY ? 'carto' : 'openfreemap';
}

export async function fetchBasemapTile(url, env){
  const key = env.CARTO_API_KEY;
  if(!key){
    throw Object.assign(
      new Error('Basemap proxy is only used when CARTO_API_KEY is configured'),
      { status: 404 },
    );
  }

  // ['api','basemap', theme, z, x, y]
  const [, , theme, z, x, y] = url.pathname.split('/').filter(Boolean);
  const style = CARTO_STYLE[theme];
  const zi = Number(z), xi = Number(x), yi = Number(y);
  if(!style || ![zi, xi, yi].every(Number.isInteger) || zi < 0 || zi > 20){
    throw Object.assign(
      new Error('Expected /api/basemap/{light|dark}/{z}/{x}/{y}'),
      { status: 400 },
    );
  }

  const res = await fetch(
    `https://basemaps.cartocdn.com/${style}/${zi}/${xi}/${yi}.png?api_key=${key}`,
  );
  if(!res.ok) throw new Error(`Upstream CARTO basemap error (${res.status})`);
  return new Response(res.body, { headers: { 'content-type': 'image/png' } });
}
