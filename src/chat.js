/**
 * chat.js — Gemini-backed mini chatbot
 *
 * Proxies chat messages to the Gemini API so the API key (GEMINI_API_KEY,
 * a Worker secret) never reaches the browser. The frontend sends the
 * conversation plus a snapshot of the current on-screen risk data, which
 * gets folded into the system instruction so the bot can answer questions
 * like "is it safe to go outside" using the same numbers the page shows.
 */

const GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2000;

const SYSTEM_PROMPT = `You are the Firewatch Assistant, a small help chatbot embedded in a
wildfire/air-quality risk dashboard called Firewatch. Answer questions about
wildfire risk, air quality, heat safety, and general emergency preparedness,
using the "Current conditions" data below when relevant. Keep answers short
(a few sentences) and practical. If asked something unrelated to fire,
weather, air quality, or safety, politely redirect to those topics. You are
not a substitute for official emergency guidance — for active emergencies,
tell the user to follow local authorities and call 911.`;

function buildContextBlock(context){
  if(!context || typeof context !== 'object') return 'Current conditions: unavailable.';
  const lines = [];
  if(context.place) lines.push(`Location: ${context.place}`);
  if(context.fireLevel) lines.push(`Wildfire risk level: ${context.fireLevel}`);
  if(context.compositeScore != null) lines.push(`Composite fire risk score: ${context.compositeScore}/100`);
  if(context.aqiLevel) lines.push(`Air quality level: ${context.aqiLevel} (AQI ${context.aqiValue ?? '—'})`);
  if(context.heatLevel) lines.push(`Heat risk level: ${context.heatLevel} (feels like ${context.heatFeelsC ?? '—'}°C)`);
  if(context.nearestFireMiles != null) lines.push(`Nearest detected fire: ${context.nearestFireMiles} miles ${context.nearestFireDir || ''}`.trim());
  return lines.length ? `Current conditions:\n${lines.join('\n')}` : 'Current conditions: unavailable.';
}

function sanitizeMessages(messages){
  if(!Array.isArray(messages) || messages.length === 0){
    throw Object.assign(new Error('"messages" must be a non-empty array'), { status: 400 });
  }
  const trimmed = messages.slice(-MAX_MESSAGES);
  return trimmed.map((m) => {
    const role = m && m.role === 'model' ? 'model' : 'user';
    const text = String(m && m.text || '').slice(0, MAX_MESSAGE_LENGTH);
    if(!text.trim()){
      throw Object.assign(new Error('Each message needs non-empty "text"'), { status: 400 });
    }
    return { role, parts: [{ text }] };
  });
}

export async function fetchChatReply(body, env){
  if(!env.GEMINI_API_KEY){
    throw Object.assign(new Error('Chat is not configured (missing GEMINI_API_KEY)'), { status: 503 });
  }

  const contents = sanitizeMessages(body && body.messages);
  const contextBlock = buildContextBlock(body && body.context);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n${contextBlock}` }] },
      generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
    }),
  });

  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(`Gemini API error: ${res.status} ${errText}`.slice(0, 300)), { status: 502 });
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if(!reply){
    throw Object.assign(new Error('Gemini returned an empty response'), { status: 502 });
  }
  return reply;
}
