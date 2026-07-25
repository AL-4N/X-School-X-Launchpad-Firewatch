/**
 * forecast.js — 5-day fire weather outlook.
 *
 * Fetches the OWM 5-day / 3-hour forecast, picks the noon reading for each
 * day, runs the Canadian FWI engine on it, and returns an array of day
 * objects the frontend can render as a forecast strip.
 */

import { computeFwiSystem } from './fwi.js';

const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

export async function fetchFireForecast(lat, lon, env) {
  const key = env.OWM_API_KEY;
  if (!key) throw new Error('OWM_API_KEY not configured');

  const params = new URLSearchParams({
    lat,
    lon,
    appid: key,
    units: 'metric',
    cnt: 40, // 5 days × 8 three-hour slots
  });

  const res = await fetch(`${OWM_FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`OWM forecast fetch failed: ${res.status}`);
  const data = await res.json();

  // Group slots by calendar date (UTC).
  const byDate = {};
  for (const item of data.list) {
    const date = item.dt_txt.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(item);
  }

  const days = [];
  for (const [date, items] of Object.entries(byDate)) {
    // Prefer the slot closest to noon (peak conditions for FWI).
    const noon = items.slice().sort((a, b) => {
      const ah = parseInt(a.dt_txt.slice(11, 13), 10);
      const bh = parseInt(b.dt_txt.slice(11, 13), 10);
      return Math.abs(ah - 12) - Math.abs(bh - 12);
    })[0];

    const temp = noon.main.temp;
    const rh = noon.main.humidity;
    const wind = noon.wind.speed * 3.6; // m/s → km/h
    // Sum all 3-hour rainfall slots across the day for a daily total.
    const rain24h = items.reduce((s, i) => s + (i.rain?.['3h'] || 0), 0);
    const month = new Date(`${date}T12:00:00Z`).getUTCMonth();

    const fwiResult = computeFwiSystem({ temp, rh, wind, rain24h, month });

    days.push({
      date,
      temp: Math.round(temp * 10) / 10,
      humidity: Math.round(rh),
      wind: Math.round(wind * 10) / 10,
      rain: Math.round(rain24h * 10) / 10,
      fwi: fwiResult.indices.fwi,
      danger: fwiResult.danger,
      // OWM icon code e.g. "01d", "10n" — frontend maps to emoji.
      icon: noon.weather?.[0]?.icon || '01d',
      condition: noon.weather?.[0]?.description || '',
    });

    if (days.length >= 5) break;
  }

  return { days };
}
