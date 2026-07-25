/**
 * incidents.js — NASA EONET (Earth Observatory Natural Event Tracker)
 * wildfire category feed. Free, no API key required.
 */

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';

export async function fetchGlobalIncidents(days = 30){
  const params = new URLSearchParams({
    category: 'wildfires',
    status: 'all',
    days: String(days),
    limit: '100',
  });
  const res = await fetch(`${EONET_URL}?${params}`);
  if(!res.ok) throw new Error('EONET fetch failed');
  const data = await res.json();

  const incidents = (data.events || [])
    .map(eventToIncident)
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  return { incidents };
}

function eventToIncident(ev){
  // EONET geometries are usually Point; a wildfire event can carry
  // multiple geometry updates over its lifetime (fire perimeter growth) —
  // take the most recent one as the current representative location.
  const geom = ev.geometry?.[ev.geometry.length - 1];
  if(!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) return null;

  const [lon, lat] = geom.coordinates;
  return {
    title: ev.title,
    date: geom.date,
    lat,
    lon,
    isClosed: !!ev.closed,
  };
}
