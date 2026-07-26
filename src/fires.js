/**
 * fires.js — NASA FIRMS (Fire Information for Resource Management System)
 * active fire detections, via the public FIRMS Area API. Requires a free
 * MAP_KEY from https://firms.modaps.eosdis.nasa.gov/api/ (set as the
 * FIRMS_MAP_KEY secret) — the key is rate-limited per-key, not per-user,
 * so it must stay server-side.
 *
 * Three VIIRS satellites are queried in parallel for local fires (S-NPP,
 * NOAA-20, NOAA-21) because each has different overpass times — a fire
 * caught between S-NPP passes might only appear in NOAA-20 or NOAA-21
 * data. Results are merged and deduplicated by proximity (~375m = one
 * VIIRS pixel) so the same thermal anomaly detected by two satellites
 * doesn't appear twice on the map.
 */

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

// All four active fire sources — VIIRS (375m) for precision, MODIS (1km)
// for broader temporal coverage. Different satellites have different overpass
// times, so a fire visible in MODIS may not yet appear in any VIIRS feed.
const LOCAL_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];

/** Local fires within `radiusKm` of a point, last 24h.
 * Queries all three VIIRS satellites in parallel and deduplicates. */
export async function fetchLocalFires(lat, lon, env, radiusKm = 65){
  const key = env.FIRMS_MAP_KEY;
  if(!key) throw new Error('Fire detection is not configured on this server (missing FIRMS_MAP_KEY)');

  // ~1 degree latitude ≈ 111km; longitude degrees shrink with cos(latitude).
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  const west = lon - dLon, east = lon + dLon, south = lat - dLat, north = lat + dLat;
  const bbox = `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;

  // Fetch all four satellites simultaneously over 2 days (not 1) to
  // compensate for the 3-6h NRT processing lag — otherwise recent
  // detections may not yet appear in the 24h window. Each detection row
  // carries its own timestamp so users can see how fresh it is.
  const results = await Promise.allSettled(
    LOCAL_SOURCES.map(source =>
      fetch(`${FIRMS_BASE}/${key}/${source}/${bbox}/2`)
        .then(res => {
          if(!res.ok) return [];
          return res.text().then(csv => parseFirmsCsv(csv).map(rowToFire));
        })
        .catch(() => [])
    )
  );

  // Flatten all detections from every satellite.
  const allFires = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Filter to actual radius (bbox is a square approximation).
  const inRadius = allFires.filter(f =>
    Number.isFinite(f.lat) && Number.isFinite(f.lon) &&
    haversineKm(lat, lon, f.lat, f.lon) <= radiusKm
  );

  // Deduplicate: two detections within ~0.004° (~375m, one VIIRS pixel)
  // of each other are the same thermal anomaly from different passes.
  // Keep the one with the higher FRP (more energetic read).
  const fires = deduplicate(inRadius, 0.004);

  return { fires };
}

/** Ambient worldwide fire dots for the map's global layer, last 24h.
 * Uses MODIS (1km) for lower payload size vs VIIRS at global scale. */
export async function fetchGlobalFires(env){
  const key = env.FIRMS_MAP_KEY;
  if(!key) throw new Error('Fire detection is not configured on this server (missing FIRMS_MAP_KEY)');

  const url = `${FIRMS_BASE}/${key}/MODIS_NRT/world/1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`FIRMS global fetch failed (${res.status})`);
  const csv = await res.text();

  const rows = parseFirmsCsv(csv);
  const fires = rows.map(rowToFire).filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lon));
  return { fires };
}

/** Greedy deduplication: for each unvisited detection, collect all others
 * within `thresholdDeg` degrees and keep only the highest-FRP one. */
function deduplicate(fires, thresholdDeg){
  const used = new Uint8Array(fires.length);
  const out = [];
  for(let i = 0; i < fires.length; i++){
    if(used[i]) continue;
    let best = fires[i];
    used[i] = 1;
    for(let j = i + 1; j < fires.length; j++){
      if(used[j]) continue;
      if(
        Math.abs(fires[j].lat - fires[i].lat) < thresholdDeg &&
        Math.abs(fires[j].lon - fires[i].lon) < thresholdDeg
      ){
        used[j] = 1;
        if((fires[j].frp || 0) > (best.frp || 0)) best = fires[j];
      }
    }
    out.push(best);
  }
  return out;
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
  const lines = csv.trim().split(/\r?\n/);
  if(lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim());
  if(!header.includes('latitude') || !header.includes('longitude')){
    // FIRMS returns a plain-text error instead of CSV on bad requests.
    throw new Error(`FIRMS returned unexpected response: ${lines[0].slice(0, 200)}`);
  }

  return lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] != null ? cells[i].trim() : undefined; });
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
