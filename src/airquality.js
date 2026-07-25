/**
 * airquality.js — proxies two air-quality sources server-side so no key
 * is ever exposed to the browser.
 *
 *  - Open-Meteo Air Quality API (CAMS-based): free, no key, returns US AQI
 *    directly.
 *  - OpenWeatherMap Air Pollution API: requires OWM_API_KEY (free tier
 *    available), returns their 1-5 scale + raw pollutant components.
 */

const OM_AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const OWM_AQ_URL = 'https://api.openweathermap.org/data/2.5/air_pollution';

export async function fetchAirQuality(lat, lon, source, env){
  if(source === 'openweathermap'){
    return fetchOwm(lat, lon, env);
  }
  return fetchOpenMeteo(lat, lon);
}

async function fetchOpenMeteo(lat, lon){
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'us_aqi,pm2_5',
  });
  const res = await fetch(`${OM_AQ_URL}?${params}`);
  if(!res.ok) throw new Error('Open-Meteo air quality fetch failed');
  const data = await res.json();
  const cur = data.current;
  if(!cur || cur.us_aqi == null) throw new Error('Air quality data unavailable for this location');

  return {
    scale: 'us-aqi',
    aqi: Math.round(cur.us_aqi),
    pm2_5: cur.pm2_5,
  };
}

async function fetchOwm(lat, lon, env){
  const key = env.OWM_API_KEY;
  if(!key){
    throw new Error('OpenWeatherMap is not configured on this server (missing OWM_API_KEY)');
  }
  const params = new URLSearchParams({ lat, lon, appid: key });
  const res = await fetch(`${OWM_AQ_URL}?${params}`);
  if(!res.ok) throw new Error('OpenWeatherMap air quality fetch failed');
  const data = await res.json();
  const entry = data.list?.[0];
  if(!entry) throw new Error('OpenWeatherMap returned no air quality data');

  return {
    scale: 'owm',
    aqi: entry.main.aqi, // 1-5
    components: entry.components,
  };
}
