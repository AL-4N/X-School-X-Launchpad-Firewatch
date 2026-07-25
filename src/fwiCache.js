/**
 * fwiCache.js — carries yesterday's FFMC/DMC/DC forward per location so
 * the FWI system accumulates realistically across days instead of
 * resetting to standard startup values on every request (see fwi.js).
 *
 * Locations are bucketed to a coarse grid (~0.1° ≈ 11km) so nearby
 * requests share the same drought history rather than creating a fresh
 * cold-start entry per exact GPS coordinate — meaningful for DC, which
 * is a regional/seasonal signal, not a hyper-local one.
 *
 * Requires a KV namespace bound as FWI_CACHE in wrangler.toml. If it's
 * not bound (e.g. local dev without KV set up), this degrades gracefully
 * to always-cold-start rather than throwing.
 */

function gridKey(lat, lon){
  const glat = Math.round(lat * 10) / 10;
  const glon = Math.round(lon * 10) / 10;
  return `fwi:${glat}:${glon}`;
}

function todayUtcDateString(){
  return new Date().toISOString().slice(0, 10);
}

export async function getPrevCodes(lat, lon, env){
  if(!env.FWI_CACHE) return null;
  try{
    const raw = await env.FWI_CACHE.get(gridKey(lat, lon));
    if(!raw) return null;
    const entry = JSON.parse(raw);

    // Only use yesterday's (or today's earlier) codes if they're recent —
    // a cache entry more than 2 days stale means we missed a day's weather
    // entirely, and carrying forward across a gap would silently fabricate
    // a moisture history that never happened.
    const ageDays = (Date.now() - new Date(entry.date).getTime()) / 86400000;
    if(ageDays > 2) return null;

    return entry.codes;
  }catch(e){
    console.error('FWI cache read failed', e);
    return null;
  }
}

export async function saveCodes(lat, lon, codes, env){
  if(!env.FWI_CACHE) return;
  try{
    const entry = { date: todayUtcDateString(), codes };
    // 4-day TTL: comfortably covers the 2-day staleness cutoff above with
    // margin, without keeping unbounded history for locations no one revisits.
    await env.FWI_CACHE.put(gridKey(lat, lon), JSON.stringify(entry), { expirationTtl: 4 * 86400 });
  }catch(e){
    console.error('FWI cache write failed', e);
  }
}
