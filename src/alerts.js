/**
 * alerts.js — government weather alerts from OWM One Call API 3.0.
 *
 * One Call 3.0 is a separate subscription tier; a standard free key returns
 * a 401/402. The function always returns { alerts: [] } on any error so the
 * rest of the app degrades gracefully when the endpoint isn't available.
 */

const OWM_ONECALL_URL = 'https://api.openweathermap.org/data/3.0/onecall';

export async function fetchWeatherAlerts(lat, lon, env) {
  const key = env.OWM_API_KEY;
  if (!key) return { alerts: [] };

  const params = new URLSearchParams({
    lat,
    lon,
    appid: key,
    // Only ask for the alerts section — skip the large hourly/daily arrays.
    exclude: 'minutely,hourly,daily,current',
  });

  try {
    const res = await fetch(`${OWM_ONECALL_URL}?${params}`);
    if (!res.ok) return { alerts: [] }; // graceful: free tier has no One Call access
    const data = await res.json();

    const alerts = (data.alerts || []).map(a => ({
      event: a.event,
      sender: a.sender_name,
      start: (a.start || 0) * 1000, // unix seconds → ms
      end: (a.end || 0) * 1000,
      description: (a.description || '').slice(0, 400),
    }));

    return { alerts };
  } catch {
    return { alerts: [] };
  }
}
