/**
 * geocode.js — location search + reverse geocoding.
 * Uses Open-Meteo's free geocoding API (no key required) for forward
 * search, and BigDataCloud's free reverse-geocoding endpoint (no key
 * required, generous rate limit) for "what place is this lat/lon".
 */

const OM_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_GEOCODE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

export async function forwardGeocode(query){
  const url = `${OM_GEOCODE_URL}?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Geocoding search failed');
  const data = await res.json();

  const results = (data.results || []).map(r => {
    const regionParts = [r.admin1, r.country].filter(Boolean);
    return {
      name: r.name,
      region: regionParts.join(', '),
      lat: r.latitude,
      lon: r.longitude,
      displayName: [r.name, ...regionParts].join(', '),
    };
  });

  return { results };
}

export async function reverseGeocode(lat, lon){
  const url = `${REVERSE_GEOCODE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Reverse geocoding failed');
  const data = await res.json();

  const city = data.city || data.locality || data.principalSubdivision;
  const region = data.principalSubdivision;
  const country = data.countryName;
  const parts = [city, region !== city ? region : null, country].filter(Boolean);

  return {
    displayName: parts.length ? parts.join(', ') : `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
  };
}
