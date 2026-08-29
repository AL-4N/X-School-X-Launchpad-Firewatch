/**
 * tiles.js — NASA FIRMS WMS thermal-tile passthrough.
 *
 * The frontend requests /api/fires/tiles/{z}/{x}/{y}; this converts the
 * XYZ tile coordinate to a WMS bbox, forwards to FIRMS's mapserver with
 * the key attached server-side, and streams the PNG back untouched so
 * FIRMS_MAP_KEY never reaches the browser.
 */

/** Converts an XYZ tile coordinate to a WGS84 [lonMin, latMin, lonMax, latMax] bbox. */
export function tileToBBox(x, y, z){
  const n = Math.pow(2, z);
  x = ((x % n) + n) % n; // normalize wrapped world copies before bbox math
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latMin = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return [lonMin, latMin, lonMax, latMax];
}

export async function fetchFireTile(url, env){
  const key = env.FIRMS_MAP_KEY;
  if(!key) throw new Error('Fire detection is not configured on this server (missing FIRMS_MAP_KEY)');

  // ['api','fires','tiles', z, x, y]
  const [, , , z, x, y] = url.pathname.split('/').filter(Boolean);
  const zi = Number(z), xi = Number(x), yi = Number(y);
  if(![zi, xi, yi].every(Number.isInteger) || zi < 0 || zi > 20){
    throw Object.assign(new Error('Expected /api/fires/tiles/{z}/{x}/{y}'), { status: 400 });
  }

  const bbox = tileToBBox(xi, yi, zi);
  const wmsUrl =
    `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${key}/` +
    `?REQUEST=GetMap&LAYERS=fires_viirs_noaa21_24` +
    `&SRS=EPSG:4326&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256` +
    `&FORMAT=image/png&TRANSPARENT=TRUE&VERSION=1.1.1`;

  const res = await fetch(wmsUrl);
  if(!res.ok) throw new Error(`Upstream FIRMS tile error (${res.status})`);
  return new Response(res.body, {
    headers: { 'content-type': 'image/png' },
  });
}
