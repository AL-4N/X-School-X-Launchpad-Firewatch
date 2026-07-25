/**
 * fires.js — NASA FIRMS (Fire Information for Resource Management System)
 * active fire detections, via the public FIRMS Area API. Requires a free
 * MAP_KEY from https://firms.modaps.eosdis.nasa.gov/api/ (set as the
 * FIRMS_MAP_KEY secret) — the key is rate-limited per-key, not per-user,
 * so it must stay server-side.
 *
 * FIRMS returns CSV, not JSON, so we parse it here. Source is VIIRS
 * (S-NPP + NOAA-20), ~375m pixel resolution, which has better small-fire
 * detection than the older 1km MODIS product.
 */

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/** Local fires within `radiusKm` of a point, last 24h. FIRMS' area API
 * takes a bounding box, not a radius, so we compute one from the radius
 * and filter precisely client-side (well, Worker-side) after parsing. */
export async function fetchLocalFires(lat, lon, env, radiusKm = 65){
  const key = env.FIRMS_MAP_KEY;
  if(!key) throw new Error('Fire detection is not configured on this server (missing FIRMS_MAP_KEY)');

  // ~1 degree latitude ≈ 111km; longitude degrees shrink with cos(latitude).
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  const west = lon - dLon, east = lon + dLon, south = lat - dLat, north = lat + dLat;
  const bbox = `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;

  const url = `${FIRMS_BASE}/${key}/VIIRS_SNPP_NRT/${bbox}/1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`FIRMS fetch failed (${res.status})`);
  const csv = await res.text();

  const rows = parseFirmsCsv(csv);
  const fires = rows
    .map(rowToFire)
    .filter(f => haversineKm(lat, lon, f.lat, f.lon) <= radiusKm);

  return { fires };
}

/** Ambient worldwide fire dots for the map's global layer, last 24h,
 * MODIS (1km, wider coverage, lower request volume than global VIIRS)
 * to keep the payload a reasonable size for a client-side render. */
export async function fetchGlobalFires(env){
  const key = env.FIRMS_MAP_KEY;
  if(!key) throw new Error('Fire detection is not configured on this server (missing FIRMS_MAP_KEY)');

  const url = `${FIRMS_BASE}/${key}/MODIS_NRT/world/1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`FIRMS global fetch failed (${res.status})`);
  const csv = await res.text();

  const rows = parseFirmsCsv(csv);
  const fires = rows.map(rowToFire);
  return { fires };
}

function rowToFire(row){
  return {
    lat: parseFloat(row.latitude),
    lon: parseFloat(row.longitude),
    brightness: row.bright_ti4 != null ? parseFloat(row.bright_ti4) : (row.brightness != null ? parseFloat(row.brightness) : null),
    confidence: row.confidence,
    frp: row.frp != null ? parseFloat(row.frp) : null,
    date: row.acq_date,
    time: row.acq_time,
  };
}

function parseFirmsCsv(csv){
  const lines = csv.trim().split('\n');
  if(lines.length < 2) return []; // header only, or an error message body

  const header = lines[0].split(',').map(h => h.trim());
  // FIRMS returns a plain-text error (e.g. "Invalid MAP_KEY") instead of
  // CSV when something's wrong — detect that rather than silently
  // returning garbage rows.
  if(!header.includes('latitude') || !header.includes('longitude')){
    throw new Error(`FIRMS returned an unexpected response: ${lines[0].slice(0, 200)}`);
  }

  return lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
