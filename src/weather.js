/**
 * weather.js — fetches current + recent weather from Open-Meteo (free,
 * no API key) and shapes it into what the FWI system and frontend need.
 */

const OM_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Fetches current conditions + last 7 days of daily rain, all from a
 * single Open-Meteo call (it supports mixing current/hourly/daily in
 * one request), to keep this to one upstream fetch. */
export async function fetchWeather(lat, lon){
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,apparent_temperature',
    daily: 'precipitation_sum',
    past_days: '7',
    forecast_days: '1',
    wind_speed_unit: 'kmh',
    timezone: 'auto',
  });

  const res = await fetch(`${OM_FORECAST_URL}?${params}`);
  if(!res.ok) throw new Error('Weather fetch failed');
  const data = await res.json();

  const cur = data.current;
  if(!cur) throw new Error('Weather response missing current conditions');

  // Sum the last 7 completed days of precipitation (excludes today, which
  // is still in progress) for the "7-day rain" figure used both in the UI
  // and as the FWI rain24h proxy for the most recent day.
  const dailyRain = data.daily?.precipitation_sum || [];
  const last7 = dailyRain.slice(0, 7); // past_days=7 puts history first, today last
  const rain7d = last7.reduce((s, v) => s + (v || 0), 0);
  const rain24h = dailyRain.length ? (dailyRain[dailyRain.length - 2] ?? 0) : 0; // yesterday's total as the most recent complete day

  return {
    temp: cur.temperature_2m,
    humidity: cur.relative_humidity_2m,
    wind: cur.wind_speed_10m,
    windDir: cur.wind_direction_10m,
    feelsLike: cur.apparent_temperature,
    rain7d,
    rain24h,
    // Timezone-local month (0-indexed) for FWI day-length factors.
    month: new Date(data.current.time).getUTCMonth(),
  };
}
