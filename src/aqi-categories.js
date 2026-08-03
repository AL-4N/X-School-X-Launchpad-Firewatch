/**
 * aqi-categories.js — Pure AQI boundary logic (no i18n / browser globals).
 *
 * These functions return only numeric level and hex colour so they can be
 * imported in both the Worker and in tests without pulling in browser
 * globals (t(), tf(), TRANSLATIONS, etc.) from public/app.js.
 *
 * Labels and descriptions are handled by the frontend layer that calls
 * these helpers and passes the results through the i18n helpers.
 */

/**
 * US AQI scale (EPA).
 * Returns { level: 0-5, hex } based on the AQI integer value.
 *   0 = Good        (0–50)
 *   1 = Moderate    (51–100)
 *   2 = USG         (101–150)
 *   3 = Unhealthy   (151–200)
 *   4 = Very Unhealthy (201–300)
 *   5 = Hazardous   (301+)
 */
export function usAqiLevel(aqi) {
  if (aqi <= 50)  return { level: 0, hex: '#2ecc71' };
  if (aqi <= 100) return { level: 1, hex: '#f1c40f' };
  if (aqi <= 150) return { level: 2, hex: '#e67e22' };
  if (aqi <= 200) return { level: 3, hex: '#e74c3c' };
  if (aqi <= 300) return { level: 4, hex: '#8e44ad' };
  return          { level: 5, hex: '#c0392b' };
}

/**
 * OpenWeatherMap AQI scale (1–5).
 * Converts OWM's 1-based level into the same 0-based level used by the UI,
 * plus a matching hex colour.
 *   OWM 1 → level 0 (Good)
 *   OWM 5 → level 4 (Very Poor)
 */
export function owmAqiLevel(level) {
  const map = { 1: '#2ecc71', 2: '#f1c40f', 3: '#e67e22', 4: '#e74c3c', 5: '#8e44ad' };
  return { level: level - 1, hex: map[level] || '#aaa' };
}
