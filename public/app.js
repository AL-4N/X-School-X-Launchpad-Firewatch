/**
 * app.js — Firewatch frontend
 * This file makes NO direct calls to NASA FIRMS, OpenWeatherMap, or any
 * third-party API. Everything goes through the Worker backend at
 * WORKER_BASE_URL, which holds all API keys server-side. The browser
 * never sees a key.
 */

// The frontend and Worker API deploy together (Cloudflare Workers static
// assets), so API calls are same-origin — no absolute URL needed, and no
// CORS involved.
const WORKER_BASE_URL = '';

let map, userMarker, fireLayer, globalFireLayer, incidentLayer;
let userLat, userLon;
let fireSort = 'distance'; // 'distance' | 'size'
let fireSortAsc = true;    // true = closest/smallest first
let firesExpanded = false;
let aqiSource = 'openmeteo'; // 'openmeteo' | 'openweathermap' — both proxied server-side now
let globalIncidents = [];
let incidentsShownOnMap = false;
let searchDebounceTimer = null;
let lastSearchResults = [];
let lastFires = [];
let profile = 'general';
let pickMarker = null;
let pickedLat = null, pickedLon = null, pickedName = null;
let globalFiresCache = null; // fetched once, reused across location changes/map rebuilds

/* ---------------- Share ---------------- */

function shareLocation(){
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('share-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 2000);
  }).catch(() => {
    // Fallback: prompt with URL selected
    window.prompt('Copy this link:', url);
  });
}

/* ---------------- Saved locations (localStorage) ---------------- */

const SAVED_KEY = 'firewatch_saved_locations';

function getSavedLocations(){
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch { return []; }
}

function isCurrentLocationSaved(){
  if(userLat == null || userLon == null) return false;
  return getSavedLocations().some(
    s => Math.abs(s.lat - userLat) < 0.0001 && Math.abs(s.lon - userLon) < 0.0001
  );
}

function toggleSaveLocation(){
  if(userLat == null || userLon == null) return;
  let saved = getSavedLocations();
  const idx = saved.findIndex(
    s => Math.abs(s.lat - userLat) < 0.0001 && Math.abs(s.lon - userLon) < 0.0001
  );
  if(idx >= 0){
    saved.splice(idx, 1);
  } else {
    const name = document.getElementById('place-name').textContent || `${userLat.toFixed(3)}, ${userLon.toFixed(3)}`;
    saved = [{ name, lat: userLat, lon: userLon }, ...saved].slice(0, 10);
  }
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  updateSaveBtn();
  renderSavedPlaces();
}

function removeSavedLocation(lat, lon){
  const saved = getSavedLocations().filter(
    s => !(Math.abs(s.lat - lat) < 0.0001 && Math.abs(s.lon - lon) < 0.0001)
  );
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  updateSaveBtn();
  renderSavedPlaces();
}

function updateSaveBtn(){
  const btn = document.getElementById('save-btn');
  if(!btn) return;
  const saved = isCurrentLocationSaved();
  btn.textContent = saved ? '✓ Saved' : '🔖 Save';
  btn.classList.toggle('saved', saved);
}

function renderSavedPlaces(){
  const saved = getSavedLocations();
  const box = document.getElementById('saved-places');
  if(!box) return;
  if(!saved.length){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  saved.forEach(s => {
    const chip = document.createElement('div');
    chip.className = 'saved-chip';
    chip.innerHTML = `<span class="chip-name" title="${s.name}">${s.name}</span><span class="chip-x" title="Remove">✕</span>`;
    chip.querySelector('.chip-name').onclick = () => loadLocation(s.lat, s.lon, s.name);
    chip.querySelector('.chip-x').onclick = (e) => { e.stopPropagation(); removeSavedLocation(s.lat, s.lon); };
    box.appendChild(chip);
  });
}

/* ---------------- Be Ready checklist ---------------- */

const READY_KEY = 'firewatch_ready_checklist';

function loadReadyChecklist(){
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(READY_KEY) || '{}'); } catch {}
  document.querySelectorAll('.ready-item').forEach(item => {
    const key = item.dataset.key;
    const cb = item.querySelector('input[type=checkbox]');
    if(saved[key]){ cb.checked = true; item.classList.add('checked'); }
  });
  updateReadyProgress();
}

function onReadyCheck(cb){
  const item = cb.closest('.ready-item');
  item.classList.toggle('checked', cb.checked);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(READY_KEY) || '{}'); } catch {}
  saved[item.dataset.key] = cb.checked;
  localStorage.setItem(READY_KEY, JSON.stringify(saved));
  updateReadyProgress();
}

function updateReadyProgress(){
  const items = document.querySelectorAll('.ready-item');
  const total = items.length;
  const done = [...items].filter(i => i.querySelector('input').checked).length;
  const el = document.getElementById('ready-progress');
  if(!el) return;
  el.textContent = `${done} / ${total}`;
  el.classList.toggle('complete', done === total);
}

/* ---------------- Wind direction ---------------- */

function degreesToCompass(deg){
  if(deg == null) return '—';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/* ---------------- Units (°C/°F, km/h ↔ mph) ---------------- */

const UNIT_KEY = 'firewatch_unit';
let unit = localStorage.getItem(UNIT_KEY) || 'C'; // 'C' | 'F'

function cToF(c){ return (c * 9/5) + 32; }
function kmhToMph(k){ return k * 0.621371; }

/** Formats a Celsius value in whichever unit is currently selected, with the
 * degree symbol and letter (e.g. "24°C" / "75°F"). Pass decimals=0 for
 * whole-number display (used almost everywhere in this compact UI). */
function fmtTemp(c, decimals){
  if(c == null || Number.isNaN(c)) return '—';
  const val = unit === 'F' ? cToF(c) : c;
  const d = decimals == null ? 0 : decimals;
  return `${val.toFixed(d)}°${unit}`;
}

function fmtWind(kmh){
  if(kmh == null || Number.isNaN(kmh)) return '—';
  return unit === 'F' ? `${Math.round(kmhToMph(kmh))}` : `${Math.round(kmh)}`;
}

function windUnitLabel(){
  return unit === 'F' ? 'Wind mph' : 'Wind km/h';
}

function setUnit(u){
  if(u !== 'C' && u !== 'F') return;
  unit = u;
  localStorage.setItem(UNIT_KEY, unit);
  document.getElementById('unit-c').classList.toggle('active', unit === 'C');
  document.getElementById('unit-f').classList.toggle('active', unit === 'F');
  // Re-render every already-loaded card so units flip instantly without a refetch.
  refreshUnitDependentUI();
}

/** Re-paints all currently-visible unit-dependent numbers from cached state
 * (current, lastWeather) rather than re-fetching — units are a display
 * concern only. */
function refreshUnitDependentUI(){
  if(current.actualTempC != null){
    document.getElementById('w-temp').textContent = fmtTemp(current.actualTempC);
  }
  if(current.windKmh != null){
    document.getElementById('w-wind').textContent = fmtWind(current.windKmh);
  }
  const windLbl = document.getElementById('w-wind-lbl');
  if(windLbl) windLbl.innerHTML = `${windUnitLabel()} · <span id="w-winddir">${degreesToCompass(lastWeather?.windDir)}</span>`;

  if(current.heatFeelsC != null){
    document.getElementById('heat-big').textContent = fmtTemp(current.heatFeelsC).replace(`°${unit}`, '');
    document.getElementById('heat-big-unit').textContent = `°${unit} feels-like`;
  }
  if(lastWeather){
    document.getElementById('heat-foot').textContent =
      `Actual ${fmtTemp(lastWeather.temp)} · humidity ${Math.round(lastWeather.humidity)}% · source: Open-Meteo`;
  }
}

// Levels are 0=green(good) 1=yellow(moderate) 2=orange(unhealthy) 3=red(severe),
// shared across the hero verdict and each risk card so the "worst of three" logic is one source of truth.
const LEVEL_COLORS = ['#2ecc71', '#f1c40f', '#e67e22', '#e74c3c'];
const LEVEL_NAMES = ['GREEN', 'YELLOW', 'ORANGE', 'RED'];

const current = {
  nearestFireMiles: null, nearestFireDir: null, fireCount: 0, fwiDangerLevel: null, fwiDangerHex: null,
  fireLevel: null, compositeScore: null,
  aqiLevel: null, aqiValue: null, aqiScale: null,
  heatLevel: null, heatFeelsC: null, actualTempC: null, humidity: null, windKmh: null,
};
let lastWeather = null; // cached raw weather payload, used to re-render on unit toggle

const state = {
  loading: document.getElementById('state-loading'),
  error: document.getElementById('state-error'),
  app: document.getElementById('app'),
};

function showState(name){
  state.loading.classList.add('hidden');
  state.error.classList.add('hidden');
  state.app.classList.add('hidden');
  state[name].classList.remove('hidden');
}

async function api(path){
  const res = await fetch(`${WORKER_BASE_URL}${path}`);
  if(!res.ok){
    const body = await res.json().catch(()=>({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function requestLocation(){
  showState('loading');
  if(!navigator.geolocation){
    document.getElementById('error-text').textContent = "This browser doesn't support location services.";
    showState('error');
    return;
  }
  navigator.geolocation.getCurrentPosition(onLocationSuccess, onLocationError, {
    enableHighAccuracy:true, timeout:12000, maximumAge:60000
  });
}

function onLocationError(err){
  const messages = {
    1: "Location permission was denied. Please allow location access to see your wildfire risk.",
    2: "We couldn't determine your position. Check your connection and try again.",
    3: "Location request timed out. Try again."
  };
  document.getElementById('error-text').textContent = messages[err.code] || "Something went wrong getting your location.";
  showState('error');
}

async function onLocationSuccess(pos){
  loadLocation(pos.coords.latitude, pos.coords.longitude);
}

/** Central entry point for showing risk data at a given coordinate — used
 * both for GPS-detected location and for a manually searched/selected one. */
async function loadLocation(lat, lon, knownDisplayName){
  userLat = lat;
  userLon = lon;
  showState('app');
  closeLocSearchResults();
  document.getElementById('loc-search-input').value = '';

  // Reflect location in the URL so a refresh or a shared link lands back
  // on the same spot instead of forcing a re-geolocate/re-search.
  const params = new URLSearchParams();
  params.set('lat', lat.toFixed(4));
  params.set('lon', lon.toFixed(4));
  history.replaceState(null, '', `?${params.toString()}`);

  if(map){ map.remove(); map = null; }
  globalFireLayer = null;
  incidentLayer = null;
  incidentsShownOnMap = false;
  pickMarker = null;
  pickedLat = pickedLon = pickedName = null;
  const incidentsBtn = document.getElementById('incidents-map-btn');
  if(incidentsBtn) incidentsBtn.classList.remove('active');

  updateSaveBtn();
  renderSavedPlaces();

  Object.keys(current).forEach(k => current[k] = null);
  current.fireCount = 0;
  lastFires = [];
  satHistory = [];
  firesExpanded = false;
  lastWeather = null;
  updateHero();

  initMap();
  if(knownDisplayName){
    document.getElementById('place-name').textContent = knownDisplayName;
  } else {
    loadPlaceName();
  }
  loadWeatherAndRisk();
  loadAirQuality();
  loadFires();
  loadGlobalIncidents();
  loadForecast();
  loadWeatherAlerts();
}

/* ---------------- Location search (manual location picker) ---------------- */

function onLocSearchInput(value){
  clearTimeout(searchDebounceTimer);
  const q = value.trim();
  if(q.length < 2){
    closeLocSearchResults();
    return;
  }
  searchDebounceTimer = setTimeout(() => runLocSearch(q), 350);
}

async function runLocSearch(q){
  try{
    const data = await api(`/api/geocode/search?q=${encodeURIComponent(q)}`);
    lastSearchResults = data.results || [];
    renderLocSearchResults();
  }catch(e){
    console.error('Location search failed', e);
  }
}

function renderLocSearchResults(){
  const box = document.getElementById('loc-search-results');
  if(!lastSearchResults.length){
    box.innerHTML = '<div class="loc-result-row">No matching places found</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = '';
  lastSearchResults.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'loc-result-row';
    row.innerHTML = `${r.name}<span class="sub">${r.region || ''}</span>`;
    row.onclick = () => loadLocation(r.lat, r.lon, r.displayName);
    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

function closeLocSearchResults(){
  const box = document.getElementById('loc-search-results');
  if(box) box.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.locsearch');
  if(wrap && !wrap.contains(e.target)) closeLocSearchResults();
});

function setAqiSource(source, evt){
  if(evt) evt.stopPropagation();
  aqiSource = source;
  document.querySelectorAll('.aqi-source-toggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.source === source);
  });
  loadAirQuality();
}

/** Toggles the collapsed detail panel inside a risk card (FWI breakdown, AQI source picker). */
function toggleDetail(which){
  const panel = document.getElementById(`${which}-detail`);
  if(panel) panel.classList.toggle('hidden');
}

function setProfile(p){
  profile = p;
  document.querySelectorAll('.profile-tab').forEach(b=>{
    b.classList.toggle('active', b.dataset.profile === p);
  });
  renderAdvice();
}

/* ---------------- Map ---------------- */

function initMap(){
  map = L.map('map', {
    zoomControl:true, attributionControl:true,
    minZoom:1, maxBoundsViscosity:1.0,
  }).setView([userLat, userLon], 10);
  map.setMaxBounds([[-90,-180],[90,180]]);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18, noWrap: true,
  }).addTo(map);

  const userIcon = L.divIcon({
    className:'',
    html:'<div style="width:16px;height:16px;border-radius:50%;background:#4A90D9;border:3px solid #fff;box-shadow:0 0 0 4px rgba(74,144,217,0.3);"></div>',
    iconSize:[16,16], iconAnchor:[8,8]
  });
  userMarker = L.marker([userLat, userLon], {icon:userIcon}).addTo(map);
  fireLayer = L.layerGroup().addTo(map);

  map.on('click', onMapClick);
  document.getElementById('firms-tile-toggle-wrap').classList.remove('hidden');
  loadGlobalFireDots();

  // Escape key collapses expanded map
  document.addEventListener('keydown', function onEsc(e){
    if(e.key === 'Escape') collapseMap();
  }, { once: false });
}

function toggleMapExpand(){
  const panel = document.getElementById('map-panel');
  const btn = document.getElementById('map-expand-btn');
  const expanded = panel.classList.toggle('expanded');
  btn.textContent = expanded ? '✕ Close' : '⤢ Expand';
  if(map) setTimeout(() => { map.invalidateSize(); map.setMinZoom(1); }, 50);
}

function collapseMap(){
  const panel = document.getElementById('map-panel');
  if(!panel.classList.contains('expanded')) return;
  panel.classList.remove('expanded');
  const btn = document.getElementById('map-expand-btn');
  if(btn) btn.textContent = '⤢ Expand';
  if(map) setTimeout(() => { map.invalidateSize(); map.setMinZoom(1); }, 50);
}

/** Ambient worldwide fire activity — raw FIRMS detections at actual
 * coordinates, rendered via Leaflet's Canvas renderer so 10 000 dots
 * draw efficiently. Adjacent satellite pixels in the same burn area
 * naturally overlap and read as organic blobs rather than a grid. */
async function loadGlobalFireDots(){
  if(!globalFiresCache){
    try{
      const data = await api('/api/fires/global');
      globalFiresCache = data.fires || [];
    }catch(e){
      console.error('Global fire data load failed', e);
      globalFiresCache = [];
    }
  }
  if(!map || !globalFiresCache.length) return;

  const renderer = L.canvas({ padding: 0.5 });
  globalFireLayer = L.layerGroup();
  globalFiresCache.forEach(f => {
    // Scale radius logarithmically by FRP (Fire Radiative Power, MW).
    // log1p gives a smooth curve: frp=0→r=2, frp=10→r=4, frp=100→r=6, frp=1000→r=8
    const frp = f.frp || 0;
    const radius = Math.max(2, Math.min(9, 2 + Math.log1p(frp) * 0.95));
    // Shift color toward red as intensity increases.
    const color = frp >= 200 ? '#e74c3c' : frp >= 50 ? '#ff7c2a' : '#ff5e2a';
    L.circleMarker([f.lat, f.lon], {
      renderer,
      radius, weight: 0,
      fillColor: color,
      fillOpacity: frp >= 50 ? 0.9 : 0.75,
    }).addTo(globalFireLayer);
  });
  if(globalFiresOn) globalFireLayer.addTo(map);
}

/* ---------------- Click-to-pick a location on the map ---------------- */

const pickIcon = L.divIcon({
  className:'',
  html:'<div style="width:14px;height:14px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#ff5e2a;border:2px solid #fff;"></div>',
  iconSize:[14,14], iconAnchor:[7,14]
});

function renderPickPopup(){
  const label = pickedName || `${pickedLat.toFixed(3)}, ${pickedLon.toFixed(3)}`;
  return `<div class="pick-popup">
    <div class="pick-popup-name">${label}</div>
    <button onclick="selectPickedLocation()">📍 Select this location</button>
  </div>`;
}

async function onMapClick(e){
  pickedLat = e.latlng.lat;
  pickedLon = e.latlng.lng;
  pickedName = null;

  if(pickMarker) map.removeLayer(pickMarker);
  pickMarker = L.marker([pickedLat, pickedLon], {icon:pickIcon}).addTo(map);
  pickMarker.bindPopup(renderPickPopup()).openPopup();

  try{
    const data = await api(`/api/geocode?lat=${pickedLat}&lon=${pickedLon}`);
    pickedName = data.displayName;
    if(pickMarker.isPopupOpen()) pickMarker.setPopupContent(renderPickPopup());
  }catch(err){
    // leave the coordinate label in place — selecting still works fine
  }
}

function selectPickedLocation(){
  if(pickedLat == null || pickedLon == null) return;
  loadLocation(pickedLat, pickedLon, pickedName || undefined);
}

let globalFiresOn = true;
function toggleGlobalFires(){
  globalFiresOn = !globalFiresOn;
  const btn = document.getElementById('firms-tile-btn');
  btn.classList.toggle('active', globalFiresOn);
  if(!globalFireLayer) return;
  if(globalFiresOn){ globalFireLayer.addTo(map); } else { map.removeLayer(globalFireLayer); }
}

/* ---------------- Location name ---------------- */

async function loadPlaceName(){
  try{
    const data = await api(`/api/geocode?lat=${userLat}&lon=${userLon}`);
    document.getElementById('place-name').textContent = data.displayName;
  }catch(e){
    document.getElementById('place-name').textContent = `${userLat.toFixed(3)}, ${userLon.toFixed(3)}`;
  }
  // Refresh save button label now that we have the place name
  updateSaveBtn();
}

/* ---------------- Weather + FWI risk ---------------- */

async function loadWeatherAndRisk(){
  try{
    const data = await api(`/api/risk?lat=${userLat}&lon=${userLon}`);
    const { weather, fwi } = data;
    lastWeather = weather;

    document.getElementById('w-temp').textContent = fmtTemp(weather.temp);
    document.getElementById('w-wind').textContent = fmtWind(weather.wind);
    const windLbl = document.getElementById('w-wind-lbl');
    if(windLbl) windLbl.innerHTML = `${windUnitLabel()} · <span id="w-winddir">${degreesToCompass(weather.windDir)}</span>`;
    document.getElementById('w-humidity').textContent = `${Math.round(weather.humidity)}%`;
    document.getElementById('w-rain').textContent = `${weather.rain7d.toFixed(0)}mm`;

    current.actualTempC = weather.temp;
    current.humidity = weather.humidity;
    current.windKmh = weather.wind;

    renderRisk(fwi, weather);
    renderHeat(weather);
    checkSevereWeather(weather);
  }catch(e){
    console.error(e);
    document.getElementById('place-name').textContent += ' (weather unavailable)';

    // Without this, a failed fetch for a NEW location leaves the Heat card,
    // weather grid, and hero verdict silently showing the PREVIOUS location's
    // numbers with nothing but a small text note that anything went wrong —
    // easy to miss, and misleading for a safety tool. Make "unknown" visible.
    ['w-temp','w-wind','w-humidity','w-rain'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
    document.getElementById('heat-big').textContent = '—';
    document.getElementById('heat-desc').textContent = 'Weather data unavailable right now.';
    document.getElementById('heat-foot').textContent = 'Source: Open-Meteo';
    const heatLevelEl = document.getElementById('heat-level');
    heatLevelEl.querySelector('.dot').style.background = 'var(--muted)';
    document.getElementById('heat-level-word').textContent = '—';
    document.getElementById('card-heat').style.borderTopColor = 'var(--border)';

    recomputeFireLevel();
    updateHero();
    renderAdvice();
  }
}

/* ---------------- Heat card ---------------- */

/** NWS-style heat caution thresholds, converted from °F to °C, applied to
 * feels-like (apparent) temperature. */
function heatCategory(feelsC){
  if(feelsC >= 51.7) return { level:3, label:'Extreme Danger', desc:'Heat stroke is likely — avoid outdoor exposure entirely.' };
  if(feelsC >= 39.4) return { level:3, label:'Danger', desc:'High risk of heat-related illness — avoid strenuous outdoor activity.' };
  if(feelsC >= 32.2) return { level:2, label:'Extreme Caution', desc:'Caution — hydrate and take breaks in the shade.' };
  if(feelsC >= 26.7) return { level:1, label:'Caution', desc:'Fatigue is possible with prolonged exposure or activity.' };
  return { level:0, label:'Comfortable', desc:'Heat is not a significant concern right now.' };
}

function renderHeat(weather){
  const cat = heatCategory(weather.feelsLike);
  current.heatLevel = cat.level;
  current.heatFeelsC = weather.feelsLike;

  document.getElementById('heat-big').textContent = Math.round(unit === 'F' ? cToF(weather.feelsLike) : weather.feelsLike);
  const heatUnitEl = document.getElementById('heat-big-unit');
  if(heatUnitEl) heatUnitEl.textContent = `°${unit} feels-like`;
  document.getElementById('heat-desc').textContent = cat.desc;
  document.getElementById('heat-foot').textContent =
    `Actual ${fmtTemp(weather.temp)} · humidity ${Math.round(weather.humidity)}% · source: Open-Meteo`;

  const levelEl = document.getElementById('heat-level');
  levelEl.querySelector('.dot').style.background = LEVEL_COLORS[cat.level];
  const heatWordEl = document.getElementById('heat-level-word');
  heatWordEl.textContent = cat.label;
  heatWordEl.style.color = LEVEL_COLORS[cat.level];
  document.getElementById('card-heat').style.borderTopColor = LEVEL_COLORS[cat.level];

  updateHero();
  renderAdvice();
}

function checkSevereWeather({temp, wind}){
  const alerts = [];
  if(wind >= 50){
    alerts.push({ level:'severe', icon:'🌪', title:'High Wind Warning', text:'Sustained winds this strong can down trees and rapidly spread any fire.' });
  } else if(wind >= 35){
    alerts.push({ level:'warn', icon:'💨', title:'Strong Wind Advisory', text:'Elevated winds may cause difficult outdoor conditions.' });
  }
  if(temp >= 40){
    alerts.push({ level:'severe', icon:'🌡', title:'Extreme Heat Warning', text:'Dangerous heat levels — limit outdoor exposure and stay hydrated.' });
  } else if(temp >= 35){
    alerts.push({ level:'warn', icon:'🌡', title:'Heat Advisory', text:'High temperatures increase health and fire risks.' });
  }
  updateHazards('weather', alerts);
}

let hazardAlertsState = [];
function updateHazards(source, newAlerts){
  hazardAlertsState = hazardAlertsState.filter(a => a.source !== source).concat(
    newAlerts.map(a => ({...a, source}))
  );
  drawHazardAlerts();
}

function drawHazardAlerts(){
  const box = document.getElementById('hazard-alerts');
  box.innerHTML = '';
  hazardAlertsState.forEach(a=>{
    const el = document.createElement('div');
    el.className = `hazard-chip ${a.level}`;
    el.innerHTML = `<span class="icn">${a.icon}</span><div><b>${a.title}</b>${a.text}</div>`;
    box.appendChild(el);
  });
}

/* ---------------- Hero verdict (worst of the four risk signals) ---------------- */

function updateHero(){
  const levels = [
    { key:'fire', level:current.fireLevel, label:'Wildfire risk' },
    { key:'air', level:current.aqiLevel, label:'Air quality' },
    { key:'heat', level:current.heatLevel, label:'Heat' },
  ].filter(x => x.level != null);

  const hero = document.getElementById('hero');
  if(!levels.length){
    document.getElementById('hero-headline').textContent = 'Checking current conditions…';
    document.getElementById('hero-sub').textContent = 'Overall level is the worst of your three risks below.';
    document.getElementById('hero-badge').textContent = '—';
    return;
  }

  const worst = levels.reduce((a, b) => b.level > a.level ? b : a);
  const level = worst.level;
  const hex = LEVEL_COLORS[level];

  hero.style.borderColor = hex;
  document.getElementById('hero-icon').style.background = hex;
  document.getElementById('hero-icon').textContent = { fire:'🔥', air:'🌫️', heat:'🌡️' }[worst.key];

  const statusWord = ['GOOD', 'MODERATE', 'UNHEALTHY', 'SEVERE'][level];
  const badge = document.getElementById('hero-badge');
  badge.textContent = `${LEVEL_NAMES[level]} · ${statusWord}`;
  badge.style.background = hex;

  const headline = document.getElementById('hero-headline');
  if(level === 0) headline.textContent = 'Conditions look good — enjoy the outdoors.';
  else if(level === 1) headline.textContent = `${worst.label} is elevated today — stay aware.`;
  else if(level === 2) headline.textContent = `${worst.label} is unhealthy today — limit time outdoors.`;
  else headline.textContent = `${worst.label} is at dangerous levels — avoid outdoor exposure.`;

  document.getElementById('hero-sub').textContent = 'Overall level is the worst of your three risks below.';

  const place = document.getElementById('place-name').textContent;
  document.getElementById('hero-place').textContent = place;
  const now = new Date();
  document.getElementById('hero-updated').textContent =
    `Updated ${now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · local`;
}

/* ---------------- "What should I do?" advice engine ---------------- */

/* Profile-specific advice that is always shown regardless of conditions. */
const STANDING_ADVICE = {
  general: [
    'Check local fire authority alerts before outdoor activities.',
    'Keep windows closed on smoky or high-wind days.',
    'Know your nearest two evacuation routes.',
    'Keep at least 3 days of emergency supplies at home.',
  ],
  asthma: [
    'Keep your rescue inhaler accessible at all times.',
    'Monitor AQI daily — airways react before you feel it.',
    'Use a HEPA air filter indoors on smoky days.',
    'Have a written asthma action plan and share it with someone nearby.',
  ],
  elderly: [
    'Stay hydrated — thirst response weakens with age.',
    'Keep medications stocked for at least 2 weeks.',
    'Identify a cool refuge (library, community center) if AC fails.',
    'Ensure someone checks in on you daily during high-risk periods.',
  ],
  outdoor: [
    'Check fire weather forecast before starting each shift.',
    'Carry water and a dust mask on every job.',
    'Have a communication plan for areas with no cell signal.',
    'Know the location of the nearest fire station or emergency exit.',
  ],
};

/* Emergency resource links per profile. */
const PROFILE_RESOURCES = {
  general:  [{ label:'CAL FIRE alerts', href:'https://www.fire.ca.gov/' }, { label:'Air quality map', href:'https://www.airnow.gov/' }],
  asthma:   [{ label:'Air quality map', href:'https://www.airnow.gov/' }, { label:'Asthma & Allergy Foundation', href:'https://www.aafa.org/' }],
  elderly:  [{ label:'CAL FIRE alerts', href:'https://www.fire.ca.gov/' }, { label:'Red Cross preparedness', href:'https://www.redcross.org/get-help/how-to-prepare-for-emergencies.html' }],
  outdoor:  [{ label:'CAL FIRE alerts', href:'https://www.fire.ca.gov/' }, { label:'OSHA heat safety', href:'https://www.osha.gov/heat' }],
};

function renderAdvice(){
  const { fireLevel, aqiLevel, heatLevel, windKmh } = current;
  const anyData = fireLevel != null || aqiLevel != null || heatLevel != null;

  // --- Condition-specific items (dynamic) ---
  const conditionItems = [];

  if(aqiLevel != null){
    if(aqiLevel === 0) conditionItems.push({ icon:'✓', good:true, text:'Air quality is good — fine for outdoor activity today.' });
    else {
      const aqiThreshold = profile === 'asthma' ? 1 : 2;
      if(aqiLevel >= aqiThreshold) conditionItems.push({ icon:'⚠', text:'Keep windows and doors closed today.' });
      if(aqiLevel >= 1 && profile === 'outdoor') conditionItems.push({ icon:'😷', text:'Wear an N95 mask if working outdoors for extended periods.' });
      if(aqiLevel >= 1 && profile === 'asthma') conditionItems.push({ icon:'💊', text:'Have your rescue inhaler on your person, not just nearby.' });
      if(aqiLevel >= 2) conditionItems.push({ icon:'🏠', text:'Stay indoors and run an air purifier or AC on recirculate.' });
    }
  }

  if(heatLevel != null){
    if(heatLevel === 0) conditionItems.push({ icon:'✓', good:true, text:'Temperatures are comfortable — no heat precautions needed.' });
    else {
      if(heatLevel >= 2) conditionItems.push({ icon:'🌡', text:'Move exercise indoors — avoid strenuous outdoor activity.' });
      else conditionItems.push({ icon:'💧', text:'Stay hydrated and take breaks in the shade.' });
      if(heatLevel >= 1 && profile === 'elderly') conditionItems.push({ icon:'🕐', text:'Avoid outdoor activity during peak heat hours (12–4 pm).' });
      if(heatLevel >= 1 && profile === 'outdoor') conditionItems.push({ icon:'🌿', text:'Take shade breaks every 20 minutes and drink 1 cup of water every 20 min.' });
      if(heatLevel >= 2 && profile === 'elderly') conditionItems.push({ icon:'📞', text:'Check on neighbours with limited mobility or no air conditioning.' });
    }
  }

  if(fireLevel != null){
    if(fireLevel === 0) conditionItems.push({ icon:'✓', good:true, text:'No active fires detected nearby — conditions look calm.' });
    else if(fireLevel === 1) conditionItems.push({ icon:'👀', text:'Stay aware of nearby fire activity and any sudden air quality changes.' });
    else if(fireLevel >= 2) conditionItems.push({ icon:'🚗', text:'Have an evacuation bag packed and monitor official fire alerts closely.' });
  }

  if(fireLevel >= 3) conditionItems.push({ icon:'🚨', text:'Follow all official evacuation orders immediately — do not wait.' });
  if(windKmh != null && windKmh >= 35) conditionItems.push({ icon:'💨', text:'Secure loose outdoor furniture and items — winds can spread embers.' });

  // --- Standing (always-on) advice for this profile ---
  const standing = STANDING_ADVICE[profile] || STANDING_ADVICE.general;

  // --- Resources ---
  const resources = PROFILE_RESOURCES[profile] || PROFILE_RESOURCES.general;

  // --- Render ---
  const list = document.getElementById('advice-list');

  let html = '';

  if(!anyData){
    html += `<div class="advice-item"><span class="chk muted">…</span>Waiting for current conditions…</div>`;
  } else if(conditionItems.length){
    html += `<div class="advice-section-label">Right now</div>`;
    html += conditionItems.map(i =>
      `<div class="advice-item${i.good ? ' good' : ''}"><span class="chk">${i.icon}</span>${i.text}</div>`
    ).join('');
  }

  html += `<div class="advice-section-label">Always</div>`;
  html += standing.map(t => `<div class="advice-item baseline"><span class="chk">✓</span>${t}</div>`).join('');

  html += `<div class="advice-section-label">Resources</div>`;
  html += `<div class="advice-resources">` +
    resources.map(r => `<a href="${r.href}" target="_blank" rel="noopener">${r.label} ↗</a>`).join('') +
    `</div>`;

  list.innerHTML = html;
}

/* ================================================================
 * IMPROVED SCORING ENGINE
 *
 * The old model used a single lookup off the raw FWI number, plus a
 * separate, disconnected "nearest fire distance" rule bolted on
 * afterward (recomputeFireLevel). That meant a location with a
 * moderate FWI but an intensifying, wind-driven fire 20 miles away
 * scored the same as one with no satellite fire activity at all.
 *
 * This version computes a single 0–100 COMPOSITE RISK SCORE that
 * blends four weighted components, each independently visible in the
 * UI breakdown so the score is auditable rather than a black box:
 *
 *   1. FWI weather danger      (40%) — conditions are primed to burn
 *   2. Satellite fire proximity (30%) — a real detected fire nearby
 *   3. Satellite fire momentum  (20%) — is that fire intensifying
 *      (rising FRP / new clusters) or dying down, across passes
 *   4. Wind/spread multiplier   (10%) — high wind amplifies both
 *      weather danger and an existing fire's spread rate together
 *
 * Components 2 and 3 come from the satellite analytics module below.
 * ================================================================ */

/** Maps the Canadian FWI 0–~30(+) scale to a 0–100 sub-score using a
 * smooth diminishing-returns curve (sqrt) rather than a hard step
 * function — a jump from FWI 8→10 should visibly move the needle even
 * though both fall in the same "moderate" bucket under the old model. */
function fwiToSubscore(fwi){
  if(fwi == null || Number.isNaN(fwi)) return 0;
  const capped = Math.max(0, Math.min(fwi, 40));
  return Math.min(100, Math.round(Math.sqrt(capped / 40) * 100));
}

/** Distance-based proximity sub-score: an inverse-distance curve
 * rather than the old 3-bucket cliff (≤10mi / ≤25mi / else), so a fire
 * at 11mi doesn't read identically to one at 24mi. */
function proximitySubscore(miles){
  if(miles == null) return 0;
  if(miles <= 1) return 100;
  if(miles >= 60) return 0;
  // Smooth falloff: 100 at 1mi, ~50 at 15mi, ~0 at 60mi.
  return Math.round(100 * Math.exp(-miles / 18));
}

/** Momentum sub-score from satellite analytics: rewards rising total
 * FRP and growing cluster count between consecutive FIRMS fetches for
 * the same location, since a fire getting MORE intense between passes
 * is materially more dangerous than a stable one at the same distance. */
function momentumSubscore(sat){
  if(!sat || sat.frpTrendPct == null) return 0;
  // frpTrendPct: e.g. +45 means FRP up 45% since last pass.
  const clamped = Math.max(-100, Math.min(200, sat.frpTrendPct));
  return Math.round(Math.max(0, Math.min(100, 50 + clamped / 2)));
}

/** Wind acts as a multiplier on both weather danger and an active
 * fire's spread rate — the same wind speed matters more when there's
 * already something burning nearby. Returns a 0–100 sub-score AND is
 * also applied as a small direct multiplier on the composite total. */
function windSubscore(windKmh){
  if(windKmh == null) return 0;
  return Math.round(Math.min(100, (windKmh / 60) * 100));
}

/** The single entry point: computes the composite 0–100 score and a
 * breakdown array for display, from whatever component data is
 * currently available. Missing components are weighted out (their
 * weight is redistributed proportionally) rather than counted as 0,
 * so a slow satellite fetch doesn't drag the score down artificially. */
function computeCompositeScore(){
  const fwiSub = fwiToSubscore(current.fwiRaw);
  const proxSub = proximitySubscore(current.nearestFireMiles);
  const momSub = momentumSubscore(satAnalytics);
  const windSub = windSubscore(current.windKmh);

  const components = [
    { key:'weather', label:'Weather (FWI)', weight:0.40, value:fwiSub, available: current.fwiRaw != null },
    { key:'proximity', label:'Satellite fire proximity', weight:0.30, value:proxSub, available: current.nearestFireMiles != null || current.fireCount === 0 },
    { key:'momentum', label:'Fire intensity trend', weight:0.20, value:momSub, available: satAnalytics != null && satAnalytics.frpTrendPct != null },
    { key:'wind', label:'Wind amplification', weight:0.10, value:windSub, available: current.windKmh != null },
  ];

  const availableWeight = components.filter(c => c.available).reduce((s, c) => s + c.weight, 0);
  if(availableWeight === 0){ current.compositeScore = null; return null; }

  let score = 0;
  components.forEach(c => {
    if(!c.available) return;
    const normWeight = c.weight / availableWeight; // redistribute missing weight
    score += c.value * normWeight;
  });
  score = Math.round(Math.max(0, Math.min(100, score)));

  current.compositeScore = score;
  return { score, components };
}

function compositeLevel(score){
  if(score == null) return null;
  if(score >= 75) return 3;
  if(score >= 50) return 2;
  if(score >= 25) return 1;
  return 0;
}

function renderCompositeScore(){
  const result = computeCompositeScore();
  const scoreEl = document.getElementById('composite-score');
  const fillEl = document.getElementById('composite-bar-fill');
  const breakdownEl = document.getElementById('composite-breakdown');
  if(!scoreEl || !fillEl || !breakdownEl) return;

  if(!result){
    scoreEl.innerHTML = '--<small>/100</small>';
    fillEl.style.width = '0%';
    fillEl.style.background = 'var(--ink-soft, #999)';
    breakdownEl.innerHTML = '<div class="empty-note">Waiting for enough data to compute a composite score…</div>';
    return;
  }

  const { score, components } = result;
  const level = compositeLevel(score);
  const hex = LEVEL_COLORS[level];

  scoreEl.innerHTML = `${score}<small>/100</small>`;
  scoreEl.style.color = hex;
  fillEl.style.width = `${score}%`;
  fillEl.style.background = hex;

  breakdownEl.innerHTML = components.map(c => {
    const dim = c.available ? '' : ' style="opacity:0.4"';
    const valText = c.available ? `${c.value}` : '—';
    return `<div class="composite-row"${dim}>
      <span class="composite-row-label">${c.label}<small>(${Math.round(c.weight*100)}%)</small></span>
      <span class="composite-row-bar"><span style="width:${c.available ? c.value : 0}%"></span></span>
      <span class="composite-row-val">${valText}</span>
    </div>`;
  }).join('');

  recomputeFireLevel();
}

/* ---------------- Risk rendering (FWI-driven) ---------------- */

function renderRisk(fwiResult, weather){
  const { codes, indices, danger, isColdStart } = fwiResult;

  current.fwiDangerLevel = danger.level;
  current.fwiDangerHex = danger.hex;
  current.fwiRaw = indices.fwi;

  document.getElementById('score-num').textContent = indices.fwi;
  document.getElementById('score-num').style.color = danger.hex;

  const badge = document.getElementById('cat-badge');
  badge.textContent = danger.class.toUpperCase();
  badge.style.background = danger.hex;

  document.getElementById('fwi-ffmc').textContent = codes.ffmc;
  document.getElementById('fwi-dmc').textContent = codes.dmc;
  document.getElementById('fwi-dc').textContent = codes.dc;
  document.getElementById('fwi-isi').textContent = indices.isi;
  document.getElementById('fwi-bui').textContent = indices.bui;

  const factors = [];
  if(weather.wind >= 30) factors.push({icon:'💨', text:`Wind at ${fmtWind(weather.wind)} ${unit === 'F' ? 'mph' : 'km/h'} is a major driver of the Initial Spread Index`});
  else if(weather.wind >= 15) factors.push({icon:'💨', text:`Moderate wind (${fmtWind(weather.wind)} ${unit === 'F' ? 'mph' : 'km/h'}) is contributing to spread potential`});
  else factors.push({icon:'✓', text:'Low wind speeds are limiting spread potential'});

  if(weather.humidity <= 30) factors.push({icon:'🏜', text:`Low humidity (${Math.round(weather.humidity)}%) is drying fine surface fuels quickly`});
  else if(weather.humidity >= 60) factors.push({icon:'✓', text:'Higher humidity is slowing fine fuel drying'});

  if(weather.rain7d <= 2) factors.push({icon:'☀️', text:'Little rain in the past week is allowing deeper fuel layers to dry out (reflected in DMC/DC)'});
  else if(weather.rain7d >= 15) factors.push({icon:'✓', text:'Recent rainfall is keeping deeper fuel layers moist'});

  if(weather.temp >= 30) factors.push({icon:'🌡', text:`High temperature (${fmtTemp(weather.temp)}) is accelerating fuel drying`});

  if(satAnalytics && satAnalytics.frpTrendPct != null && satAnalytics.frpTrendPct >= 25){
    factors.push({icon:'🛰', text:`Satellite passes show fire radiative power up ${Math.round(satAnalytics.frpTrendPct)}% since the last pass — an intensifying, not just persistent, fire`});
  }

  const list = document.getElementById('factors-list');
  list.innerHTML = '';
  factors.forEach(f=>{
    const row = document.createElement('div');
    row.className = 'factor-row';
    row.innerHTML = `<span class="icn">${f.icon}</span><span>${f.text}</span>`;
    list.appendChild(row);
  });

  const concernBox = document.getElementById('concern-box');
  if(danger.level >= 4){
    concernBox.classList.remove('hidden');
    document.getElementById('concern-text').textContent =
      danger.level >= 5
        ? 'The Initial Spread Index and fuel buildup both indicate potential for fast-moving, intense fire behavior.'
        : 'Conditions favor increased fire spread rate — the Buildup Index shows meaningful fuel available to burn.';
  } else {
    concernBox.classList.add('hidden');
  }

  document.getElementById('cold-start-note').classList.toggle('hidden', !isColdStart);

  const now = new Date();
  document.getElementById('updated-text').textContent = `Updated ${now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;

  renderCompositeScore();
  recomputeFireLevel();
  updateHero();
  renderAdvice();
}

/* ---------------- Air Quality (dual source, both server-proxied) ---------------- */

async function loadAirQuality(){
  document.getElementById('aqi-desc').textContent = 'Loading air quality data…';
  try{
    const data = await api(`/api/airquality?lat=${userLat}&lon=${userLon}&source=${aqiSource}`);
    if(data.scale === 'us-aqi'){
      renderAQI_US(data.aqi, data.pm2_5, 'Open-Meteo (CAMS)');
    } else {
      renderAQI_OWM(data.aqi, data.components);
    }
  }catch(e){
    console.error(e);
    document.getElementById('aqi-desc').textContent = 'Air quality data unavailable right now.';
    document.getElementById('aqi-num').textContent = '—';
    document.getElementById('aqi-foot').textContent = 'Source: unavailable';
    const airLevelEl = document.getElementById('air-level');
    airLevelEl.querySelector('.dot').style.background = 'var(--muted)';
    document.getElementById('air-level-word').textContent = '—';
    document.getElementById('card-air').style.borderTopColor = 'var(--border)';
    document.getElementById('scale-note').textContent = 'US EPA AQI · data unavailable';
    document.getElementById('scale-pointer').style.left = '0%';

    current.aqiLevel = null;
    current.aqiValue = null;
    updateHero();
    renderAdvice();
  }
}

function usAqiCategory(aqi){
  if(aqi <= 50) return { label:'GOOD', short:'Good', level:0, hex:'#2ecc71', desc:'Air quality is satisfactory.' };
  if(aqi <= 100) return { label:'MODERATE', short:'Moderate', level:1, hex:'#f1c40f', desc:'Acceptable, but a concern for unusually sensitive people.' };
  if(aqi <= 150) return { label:'UNHEALTHY (SENSITIVE)', short:'Sensitive', level:2, hex:'#e67e22', desc:'Sensitive groups may experience health effects.' };
  if(aqi <= 200) return { label:'UNHEALTHY', short:'Unhealthy', level:3, hex:'#e74c3c', desc:'Everyone may begin to experience health effects.' };
  if(aqi <= 300) return { label:'VERY UNHEALTHY', short:'Very Unhealthy', level:3, hex:'#9b59b6', desc:'Health alert — everyone may experience serious effects.' };
  return { label:'HAZARDOUS', short:'Hazardous', level:3, hex:'#6c3483', desc:'Emergency conditions — entire population at risk.' };
}

function owmAqiCategory(level){
  const map = {
    1: { label:'GOOD', short:'Good', level:0, hex:'#2ecc71', desc:'Air quality is good.' },
    2: { label:'FAIR', short:'Fair', level:0, hex:'#2ecc71', desc:'Air quality is acceptable.' },
    3: { label:'MODERATE', short:'Moderate', level:1, hex:'#f1c40f', desc:'Sensitive groups may notice effects.' },
    4: { label:'POOR', short:'Poor', level:2, hex:'#e67e22', desc:'Health effects may be experienced by most people.' },
    5: { label:'VERY POOR', short:'Very Poor', level:3, hex:'#e74c3c', desc:'Health warning of emergency conditions.' },
  };
  return map[level] || map[1];
}

/** Approximate 0–500 US AQI equivalent for the OpenWeatherMap 1–5 scale,
 * used only to position the pointer on the shared AQI gradient bar. */
function owmToApproxUsAqi(level){
  return { 1:25, 2:75, 3:125, 4:175, 5:250 }[level] || 25;
}

function updateAqiCard(numText, cat, descText, footText, approxUsAqi){
  document.getElementById('aqi-num').textContent = numText;
  document.getElementById('aqi-desc').textContent = descText;
  document.getElementById('aqi-foot').textContent = footText;

  const levelEl = document.getElementById('air-level');
  levelEl.querySelector('.dot').style.background = cat.hex;
  const airWordEl = document.getElementById('air-level-word');
  airWordEl.textContent = cat.short;
  airWordEl.style.color = cat.hex;
  document.getElementById('card-air').style.borderTopColor = cat.hex;

  current.aqiLevel = cat.level;
  current.aqiValue = approxUsAqi;

  const pct = Math.max(0, Math.min(100, (approxUsAqi / 300) * 100));
  document.getElementById('scale-pointer').style.left = `${pct}%`;
  document.getElementById('scale-note').innerHTML = `US EPA AQI · currently <b>${approxUsAqi} (${cat.short})</b>`;

  updateHero();
  renderAdvice();
}

function renderAQI_US(aqi, pm25, sourceLabel){
  const cat = usAqiCategory(aqi);
  const pmText = pm25 != null ? ` PM2.5 is ${Math.round(pm25)} µg/m³.` : '';
  clearOwmPollutants();
  updateAqiCard(aqi, cat, `${cat.desc}${pmText}`, `Dominant pollutant: PM2.5 · source: ${sourceLabel}`, aqi);
  updateHazards('aqi', aqi > 150 ? [{
    level: aqi > 200 ? 'severe' : 'warn', icon:'😷',
    title: aqi > 200 ? 'Unhealthy Air Quality' : 'Air Quality Advisory',
    text: 'Poor air quality may indicate nearby smoke or pollution — consider limiting outdoor exposure.'
  }] : []);
}

function renderAQI_OWM(level, components){
  const cat = owmAqiCategory(level);
  const pm25 = components?.pm2_5;
  const pmText = pm25 != null ? ` PM2.5 is ${pm25.toFixed(1)} µg/m³.` : '';
  updateAqiCard(level, cat, `${cat.desc}${pmText}`, `Dominant pollutant: PM2.5 · source: OpenWeatherMap (1–5 scale)`, owmToApproxUsAqi(level));
  updateHazards('aqi', level >= 4 ? [{
    level: level === 5 ? 'severe' : 'warn', icon:'😷',
    title: level === 5 ? 'Unhealthy Air Quality' : 'Air Quality Advisory',
    text: 'Poor air quality may indicate nearby smoke or pollution — consider limiting outdoor exposure.'
  }] : []);

  // Render individual pollutant breakdown when OWM source is active.
  renderOwmPollutants(components);
}

function renderOwmPollutants(components){
  const box = document.getElementById('owm-pollutants');
  if(!box) return;
  if(!components){ box.classList.add('hidden'); return; }

  const pollutants = [
    { key:'pm2_5',  label:'PM2.5',  unit:'µg/m³' },
    { key:'pm10',   label:'PM10',   unit:'µg/m³' },
    { key:'no2',    label:'NO₂',    unit:'µg/m³' },
    { key:'o3',     label:'O₃',     unit:'µg/m³' },
    { key:'co',     label:'CO',     unit:'µg/m³' },
    { key:'so2',    label:'SO₂',    unit:'µg/m³' },
  ].filter(p => components[p.key] != null);

  if(!pollutants.length){ box.classList.add('hidden'); return; }

  box.className = 'owm-pollutants';
  box.innerHTML = pollutants.map(p => {
    const val = components[p.key];
    return `<div class="poll-chip">
      <div class="poll-val">${val < 10 ? val.toFixed(1) : Math.round(val)}</div>
      <div class="poll-lbl">${p.label}<br><span style="opacity:0.6">${p.unit}</span></div>
    </div>`;
  }).join('');
}

// Clear the pollutant breakdown when switching away from OWM source.
function clearOwmPollutants(){
  const box = document.getElementById('owm-pollutants');
  if(box){ box.classList.add('hidden'); box.innerHTML = ''; }
}

/* ---------------- Fires (NASA FIRMS, via Worker) ---------------- */

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearingCompass(lat1, lon1, lat2, lon2){
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/** FIRMS acq_date is YYYY-MM-DD and acq_time is a 4-digit HHMM, both UTC. */
function timeAgoFromFirms(dateStr, timeStr){
  if(!dateStr) return 'recently';
  const t = (timeStr || '0000').padStart(4, '0');
  const iso = `${dateStr}T${t.slice(0,2)}:${t.slice(2)}:00Z`;
  const detected = new Date(iso);
  const mins = Math.round((Date.now() - detected.getTime()) / 60000);
  if(mins < 60) return `${Math.max(mins,0)} min ago`;
  const hrs = Math.round(mins / 60);
  if(hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs/24)} day${hrs>=48?'s':''} ago`;
}

function confidenceLabel(code){
  const map = { l:'low', n:'nominal', h:'high' };
  return map[(code || '').toLowerCase()] || (code || 'unknown');
}

/** Combines the new composite score with real-time fire proximity so the
 * wildfire card reflects the full picture. If a composite score is
 * available it drives the level directly (it already incorporates
 * proximity, momentum, and wind); otherwise falls back to the legacy
 * proximity/FWI rule so the card still degrades gracefully if satellite
 * or weather data is temporarily missing. */
function recomputeFireLevel(){
  const miles = current.nearestFireMiles;
  const fwiLvl = current.fwiDangerLevel;

  let level;
  if(current.compositeScore != null){
    level = compositeLevel(current.compositeScore);
  } else {
    level = 0;
    if(miles != null && miles <= 10) level = 3;
    else if(miles != null && miles <= 25) level = 2;
    else if(fwiLvl >= 5) level = Math.max(level, 3);
    else if(fwiLvl >= 4) level = Math.max(level, 2);
    else if(fwiLvl >= 2) level = Math.max(level, 1);
  }
  current.fireLevel = level;

  const levelEl = document.getElementById('fire-level');
  if(!levelEl) return;
  levelEl.querySelector('.dot').style.background = LEVEL_COLORS[level];
  const fireWordEl = document.getElementById('fire-level-word');
  fireWordEl.textContent = ['Low','Elevated','High','Severe'][level];
  fireWordEl.style.color = LEVEL_COLORS[level];
  document.getElementById('card-fire').style.borderTopColor = LEVEL_COLORS[level];
}

async function loadFires(){
  if(!map) return;
  try{
    const data = await api(`/api/fires?lat=${userLat}&lon=${userLon}`);
    fireLayer.clearLayers();

    lastFires = data.fires.map(f => ({
      ...f,
      distKm: haversineKm(userLat, userLon, f.lat, f.lon),
      dir: bearingCompass(userLat, userLon, f.lat, f.lon),
    })).sort((a, b) => a.distKm - b.distKm);

    // L.circle radius is in metres — matches the ~375m VIIRS pixel footprint
    // so the circle scales correctly as you zoom in/out.
    lastFires.forEach(f=>{
      const r = f.frp != null ? Math.max(300, Math.min(800, 375 + f.frp * 2)) : 375;
      L.circle([f.lat, f.lon], {
        radius: r, color: '#c0392b', weight: 1,
        fillColor: '#ff5e2a', fillOpacity: 0.75,
      }).bindPopup(`<b>Fire detection</b><br>Confidence: ${confidenceLabel(f.confidence)}${f.frp != null ? '<br>FRP: ' + Math.round(f.frp) + ' MW' : ''}`)
        .addTo(fireLayer);
    });

    current.fireCount = lastFires.length;
    current.nearestFireMiles = lastFires.length ? lastFires[0].distKm * 0.621371 : null;
    current.nearestFireDir = lastFires.length ? lastFires[0].dir : null;

    renderFiresCard();
    runSatelliteAnalytics(lastFires);
    renderCompositeScore();
    recomputeFireLevel();
    updateHero();
    renderAdvice();
  }catch(e){
    console.error('Fire data load failed', e);
    document.getElementById('fire-big').textContent = '—';
    document.getElementById('fire-big-unit').textContent = '';
    document.getElementById('fire-desc').textContent = 'Fire detection data temporarily unavailable';
    document.getElementById('fire-foot').textContent = 'Source: unavailable';
    document.getElementById('fires-detail-list').innerHTML =
      '<div class="empty-note">Couldn\'t reach NASA FIRMS — try again shortly.</div>';
    const fireLevelEl = document.getElementById('fire-level');
    fireLevelEl.querySelector('.dot').style.background = 'var(--muted)';
    document.getElementById('fire-level-word').textContent = '—';
    document.getElementById('card-fire').style.borderTopColor = 'var(--border)';

    current.nearestFireMiles = null;
    current.nearestFireDir = null;
    renderSatelliteError();
    recomputeFireLevel();
    updateHero();
    renderAdvice();
  }
}

function setFireSort(key){
  fireSort = key;
  // Default direction: distance → closest first (asc); size → biggest first (desc)
  fireSortAsc = key === 'distance';
  updateFireSortUI();
  renderFiresCard();
}

function toggleFireSortDir(){
  fireSortAsc = !fireSortAsc;
  updateFireSortUI();
  renderFiresCard();
}

function updateFireSortUI(){
  document.getElementById('sort-btn-distance')?.classList.toggle('active', fireSort === 'distance');
  document.getElementById('sort-btn-size')?.classList.toggle('active', fireSort === 'size');
  const dirBtn = document.getElementById('sort-dir-btn');
  if(dirBtn) dirBtn.textContent = fireSortAsc ? '↑' : '↓';
}

function toggleFiresExpand(){
  firesExpanded = !firesExpanded;
  renderFiresList(getSortedFires());
}

function getSortedFires(){
  return [...lastFires].sort((a, b) => {
    let diff;
    if(fireSort === 'size') diff = (b.frp || 0) - (a.frp || 0);
    else diff = a.distKm - b.distKm;
    return fireSortAsc ? diff : -diff;
  });
}

function renderFiresList(sorted){
  const list = document.getElementById('fires-detail-list');
  const expandBtn = document.getElementById('fires-expand-btn');
  const PREVIEW = 5;
  const shown = firesExpanded ? sorted : sorted.slice(0, PREVIEW);

  list.innerHTML = '';
  shown.forEach((f, i) => {
    const miles = Math.round(f.distKm * 0.621371);
    const distColor = miles <= 10 ? '#e67e22' : miles <= 25 ? '#f1c40f' : '#2ecc71';
    const frpColor = f.frp >= 100 ? '#e74c3c' : f.frp >= 30 ? '#e67e22' : '#ff5e2a';
    const row = document.createElement('div');
    row.className = 'quake-row';
    row.innerHTML = `
      <div class="quake-mag" style="background:${frpColor}">🔥</div>
      <div class="quake-info">
        <div class="quake-place">Detection #${sorted.indexOf(f)+1}</div>
        <div class="quake-time">Detected ${timeAgoFromFirms(f.date, f.time)} · confidence ${confidenceLabel(f.confidence)}${f.frp != null ? ` · FRP ${Math.round(f.frp)} MW` : ''}</div>
      </div>
      <div class="quake-dist" style="color:${distColor}">${miles} mi<span class="sub">${f.dir}</span></div>`;
    list.appendChild(row);
  });

  if(expandBtn){
    if(sorted.length > PREVIEW){
      expandBtn.classList.remove('hidden');
      expandBtn.textContent = firesExpanded
        ? 'Show less ▴'
        : `Show all ${sorted.length} ▾`;
    } else {
      expandBtn.classList.add('hidden');
    }
  }
}

function renderFiresCard(){
  const big = document.getElementById('fire-big');
  const unitEl = document.getElementById('fire-big-unit');
  const desc = document.getElementById('fire-desc');
  const foot = document.getElementById('fire-foot');
  const sortBar = document.getElementById('fires-sort-bar');

  if(!lastFires.length){
    big.textContent = '—';
    unitEl.textContent = '';
    desc.textContent = 'No active fire detected nearby. Stay aware of local conditions.';
    foot.textContent = 'Source: NASA FIRMS';
    document.getElementById('fires-detail-list').innerHTML =
      '<div class="empty-note">No fire detections within ~65km in the last 24h.</div>';
    document.getElementById('fires-expand-btn')?.classList.add('hidden');
    if(sortBar) sortBar.classList.add('hidden');
    return;
  }

  if(sortBar) sortBar.classList.remove('hidden');

  // Hero numbers always reflect the closest fire regardless of sort.
  const nearest = lastFires[0]; // lastFires is always sorted by distance from loadFires()
  const miles = Math.round(nearest.distKm * 0.621371);
  big.textContent = miles;
  unitEl.textContent = ` mi ${nearest.dir}`;
  desc.textContent = miles <= 10
    ? 'An active fire is close by. Stay alert and follow local evacuation guidance.'
    : miles <= 25
      ? 'Nearest active fire is a moderate distance away. Stay aware.'
      : 'Nearest active fire detection is a safe distance away.';

  const brightest = lastFires.reduce((m, f) => f.brightness != null && f.brightness > m ? f.brightness : m, 0);
  foot.textContent = `${lastFires.length} detection${lastFires.length > 1 ? 's' : ''} nearby` +
    (brightest ? ` · brightest ${Math.round(brightest)} K` : '') + ' · source: NASA FIRMS';

  renderFiresList(getSortedFires());
}

/* ================================================================
 * SATELLITE FIRE-DETECTION ANALYTICS
 *
 * "Satellite image analysis" in the literal sense (classifying raw
 * pixel imagery — smoke plumes, burn scar texture, vegetation
 * indices) needs imagery the browser doesn't have access to; FIRMS
 * only exposes point detections it already extracted server-side from
 * MODIS/VIIRS. What's genuinely derivable client-side from that data,
 * and genuinely useful, is treated here as a proper analytics layer
 * rather than faked:
 *
 *  - CLUSTERING: group raw detection points into contiguous fire
 *    clusters (points within ~2km of each other), since 40 raw FIRMS
 *    points are usually 3-4 real fires' worth of repeated satellite
 *    passes, not 40 separate fires.
 *  - TOTAL FRP: sum of Fire Radiative Power across all detections —
 *    the standard satellite-derived proxy for total energy release.
 *  - TREND: compares this fetch's total FRP for the same location
 *    against the previous fetch (kept in-memory per session) to
 *    surface whether detected fire activity is growing or shrinking
 *    between satellite passes.
 *  - CONFIDENCE: average detection confidence, since FIRMS explicitly
 *    flags low-confidence detections (small/cool sources, sun glint,
 *    etc.) that shouldn't be weighted the same as high-confidence ones.
 *
 * See /mnt/user-data/outputs/satellite-imagery-backend-spec.md for what
 * a true pixel-level imagery pipeline (e.g. Sentinel-2/Landsat NBR burn
 * severity, smoke plume segmentation) would require on the backend.
 * ================================================================ */

let satAnalytics = null;
let satHistory = []; // [{ timestamp, totalFrp, clusterCount }, ...] this session, this location

const SAT_CONFIDENCE_WEIGHTS = { l: 0.3, n: 0.7, h: 1.0 };

/** Greedy single-link clustering: two detections within ~2km are the
 * same cluster. Good enough for "how many distinct fires" without
 * needing a real DBSCAN implementation for a handful of points. */
function clusterFireDetections(fires, thresholdKm){
  const threshold = thresholdKm || 2;
  const clusters = [];
  const visited = new Array(fires.length).fill(false);

  for(let i = 0; i < fires.length; i++){
    if(visited[i]) continue;
    const cluster = [fires[i]];
    visited[i] = true;
    // Expand cluster by checking all unvisited points against any point
    // already in the cluster (simple flood-fill, fine at this scale).
    let grew = true;
    while(grew){
      grew = false;
      for(let j = 0; j < fires.length; j++){
        if(visited[j]) continue;
        const inRange = cluster.some(c => haversineKm(c.lat, c.lon, fires[j].lat, fires[j].lon) <= threshold);
        if(inRange){
          cluster.push(fires[j]);
          visited[j] = true;
          grew = true;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function runSatelliteAnalytics(fires){
  if(!fires || !fires.length){
    satAnalytics = { totalFrp: 0, clusterCount: 0, avgConfidence: null, frpTrendPct: null, verdict: 'clear' };
    satHistory.push({ timestamp: Date.now(), totalFrp: 0, clusterCount: 0 });
    renderSatelliteCard();
    return;
  }

  const clusters = clusterFireDetections(fires, 2);
  const totalFrp = fires.reduce((sum, f) => sum + (f.frp || 0), 0);

  const confVals = fires
    .map(f => SAT_CONFIDENCE_WEIGHTS[(f.confidence || '').toLowerCase()])
    .filter(v => v != null);
  const avgConfidence = confVals.length ? confVals.reduce((a,b) => a+b, 0) / confVals.length : null;

  // Trend vs the previous fetch for this same location/session.
  let frpTrendPct = null;
  const prev = satHistory[satHistory.length - 1];
  if(prev && prev.totalFrp > 0){
    frpTrendPct = ((totalFrp - prev.totalFrp) / prev.totalFrp) * 100;
  }

  let verdict;
  if(frpTrendPct != null && frpTrendPct >= 25) verdict = 'intensifying';
  else if(frpTrendPct != null && frpTrendPct <= -25) verdict = 'weakening';
  else verdict = 'stable';

  satAnalytics = { totalFrp, clusterCount: clusters.length, avgConfidence, frpTrendPct, verdict };
  satHistory.push({ timestamp: Date.now(), totalFrp, clusterCount: clusters.length });
  if(satHistory.length > 20) satHistory.shift(); // keep memory bounded across a long session

  renderSatelliteCard();
}

function renderSatelliteCard(){
  const verdictEl = document.getElementById('sat-verdict');
  const trendEl = document.getElementById('sat-trend');
  const frpEl = document.getElementById('sat-frp-total');
  const clustersEl = document.getElementById('sat-clusters');
  const growthEl = document.getElementById('sat-growth');
  const confEl = document.getElementById('sat-confidence');
  const futureNoteEl = document.getElementById('sat-future-note');
  if(!verdictEl) return;

  if(!satAnalytics){
    verdictEl.textContent = 'Gathering satellite passes…';
    return;
  }

  const { totalFrp, clusterCount, avgConfidence, frpTrendPct, verdict } = satAnalytics;

  const verdictText = {
    clear: 'No satellite-detected fire activity nearby',
    stable: `${clusterCount} fire cluster${clusterCount === 1 ? '' : 's'} detected — activity level stable between passes`,
    intensifying: `${clusterCount} fire cluster${clusterCount === 1 ? '' : 's'} detected — intensifying between satellite passes`,
    weakening: `${clusterCount} fire cluster${clusterCount === 1 ? '' : 's'} detected — activity declining between passes`,
  }[verdict];
  verdictEl.textContent = verdictText;
  verdictEl.style.color = verdict === 'intensifying' ? 'var(--extreme, #b23a2e)' : '';

  trendEl.textContent = frpTrendPct == null ? 'First pass' : `${frpTrendPct >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(frpTrendPct))}%`;
  trendEl.style.color = frpTrendPct == null ? '' : (frpTrendPct >= 25 ? 'var(--extreme, #b23a2e)' : frpTrendPct <= -25 ? 'var(--vlow, #3b7a57)' : '');

  frpEl.textContent = totalFrp > 0 ? Math.round(totalFrp) : '—';
  clustersEl.textContent = clusterCount || '0';
  growthEl.textContent = frpTrendPct == null ? '—' : `${frpTrendPct >= 0 ? '+' : ''}${Math.round(frpTrendPct)}%`;
  confEl.textContent = avgConfidence != null ? `${Math.round(avgConfidence * 100)}%` : '—';

  if(futureNoteEl){
    futureNoteEl.innerHTML = clusterCount > 0
      ? '<b>Coming soon:</b> true pixel-level imagery analysis (Sentinel-2/Landsat burn-severity index, smoke plume segmentation) requires a backend imagery pipeline — see the satellite-imagery-backend-spec doc for what that would add beyond these point-detection analytics.'
      : '';
  }
}

function renderSatelliteError(){
  satAnalytics = null;
  const verdictEl = document.getElementById('sat-verdict');
  if(verdictEl) verdictEl.textContent = 'Satellite analytics unavailable right now';
  ['sat-frp-total','sat-clusters','sat-growth','sat-confidence'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.textContent = '—';
  });
  const trendEl = document.getElementById('sat-trend');
  if(trendEl) trendEl.textContent = '—';
}

/* ---------------- Global wildfire incidents (NASA EONET, via Worker) ---------------- */

async function loadGlobalIncidents(){
  const note = document.getElementById('incidents-count-note');
  const list = document.getElementById('incidents-list');
  note.textContent = 'Loading global incident data…';
  try{
    const data = await api('/api/incidents/global?days=30');
    globalIncidents = data.incidents || [];
    note.textContent = globalIncidents.length
      ? `${globalIncidents.length} wildfire incident${globalIncidents.length>1?'s':''} tracked worldwide in the past 30 days`
      : 'No global wildfire incidents tracked in the past 30 days';
    renderIncidentsList();
  }catch(e){
    console.error('Global incidents load failed', e);
    note.textContent = 'Global incident data unavailable right now';
    list.innerHTML = '<div class="empty-note">Couldn\'t reach NASA EONET — try again shortly.</div>';
  }
}

function renderIncidentsList(){
  const list = document.getElementById('incidents-list');
  if(!globalIncidents.length){
    list.innerHTML = '<div class="empty-note">No global wildfire incidents tracked in the past 30 days.</div>';
    return;
  }
  list.innerHTML = '';
  globalIncidents.slice(0, 12).forEach(inc => {
    const d = new Date(inc.date);
    const dateStr = d.toLocaleDateString([], {month:'short', day:'numeric'});
    const row = document.createElement('div');
    row.className = 'quake-row incident-row';
    row.innerHTML = `
      <div class="quake-mag" style="background:${inc.isClosed ? '#a4948a' : '#ff5e2a'}">🔥</div>
      <div class="quake-info">
        <div class="quake-place">${inc.title}<span class="incident-badge ${inc.isClosed ? 'closed' : 'open'}">${inc.isClosed ? 'Past' : 'Active'}</span></div>
        <div class="quake-time">${dateStr}</div>
      </div>`;
    row.onclick = () => {
      if(!map) return;
      if(!incidentsShownOnMap) toggleGlobalIncidentsOnMap();
      map.flyTo([inc.lat, inc.lon], 6, { duration: 0.8 });
    };
    list.appendChild(row);
  });
}

/** Plots global incidents as markers on the main Leaflet map and zooms out
 * to a world view so they're all visible; toggling off returns to the
 * user's local view and clears the layer. */
function toggleGlobalIncidentsOnMap(){
  if(!map) return;
  const btn = document.getElementById('incidents-map-btn');
  incidentsShownOnMap = !incidentsShownOnMap;
  btn.classList.toggle('active', incidentsShownOnMap);

  if(!incidentLayer) incidentLayer = L.layerGroup().addTo(map);

  if(incidentsShownOnMap){
    incidentLayer.clearLayers();
    globalIncidents.forEach(inc => {
      L.circleMarker([inc.lat, inc.lon], {
        radius: 5, color: inc.isClosed ? '#a4948a' : '#ff5e2a',
        fillColor: inc.isClosed ? '#a4948a' : '#ff5e2a', fillOpacity:0.75, weight:1
      }).bindPopup(`<b>${inc.title}</b><br>${new Date(inc.date).toLocaleDateString()}${inc.isClosed ? ' · past' : ' · active'}`)
        .addTo(incidentLayer);
    });
    if(globalIncidents.length){
      map.fitBounds(L.latLngBounds(globalIncidents.map(i => [i.lat, i.lon])), { padding:[30,30], maxZoom:5 });
    }
  } else {
    incidentLayer.clearLayers();
    map.setView([userLat, userLon], 10);
  }
}

/* ---------------- 5-Day Fire Weather Forecast ---------------- */

/** Maps OWM icon codes to a single representative emoji. */
function owmIconEmoji(code){
  const map = {
    '01':'☀️', '02':'⛅', '03':'☁️', '04':'☁️',
    '09':'🌧️', '10':'🌦️', '11':'⛈️', '13':'❄️', '50':'🌫️',
  };
  return map[code.slice(0, 2)] || '🌤️';
}

async function loadForecast(){
  const row = document.getElementById('forecast-row');
  if(!row) return;
  try{
    const data = await api(`/api/forecast?lat=${userLat}&lon=${userLon}`);
    const days = data.days || [];
    if(!days.length){
      row.innerHTML = '<div class="empty-note">No forecast data available for this location.</div>';
      return;
    }
    row.innerHTML = '';
    days.forEach(d => {
      const date = new Date(d.date + 'T12:00:00Z');
      const dayName = date.toLocaleDateString([], { weekday:'short', timeZone:'UTC' });
      const tempStr = unit === 'F' ? `${Math.round(cToF(d.temp))}°F` : `${d.temp}°C`;
      const windStr = unit === 'F' ? `${Math.round(kmhToMph(d.wind))} mph` : `${d.wind} km/h`;

      const card = document.createElement('div');
      card.className = 'forecast-day';
      card.style.borderTopColor = d.danger.hex;
      card.innerHTML = `
        <div class="forecast-day-name">${dayName}</div>
        <div class="forecast-day-icon">${owmIconEmoji(d.icon)}</div>
        <div class="forecast-fwi">${d.fwi}</div>
        <div class="forecast-fwi-lbl">FWI</div>
        <div class="forecast-danger" style="background:${d.danger.hex}">${d.danger.class}</div>
        <div class="forecast-stats">
          <span>🌡 ${tempStr}</span>
          <span>💧 ${d.humidity}%</span>
          <span>💨 ${windStr}</span>
        </div>`;
      row.appendChild(card);
    });
  }catch(e){
    console.error('Forecast load failed', e);
    if(row) row.innerHTML = '<div class="empty-note">Fire weather outlook temporarily unavailable.</div>';
  }
}

/* ---------------- Weather Alerts (OWM One Call) ---------------- */

/** Maps a raw OWM alert event string to a severity level and icon. */
function classifyAlert(event){
  const e = event.toLowerCase();
  if(/red flag|fire weather|extreme fire/.test(e)) return { level:'severe', icon:'🔥' };
  if(/tornado|hurricane|typhoon/.test(e)) return { level:'severe', icon:'🌪' };
  if(/flood|tsunami/.test(e)) return { level:'severe', icon:'🌊' };
  if(/extreme heat|excessive heat|heat emergency/.test(e)) return { level:'severe', icon:'🌡' };
  if(/high wind|damaging wind/.test(e)) return { level:'severe', icon:'💨' };
  if(/heat|wind|thunderstorm|snow|ice/.test(e)) return { level:'warn', icon:'⚠️' };
  return { level:'warn', icon:'⚠️' };
}

async function loadWeatherAlerts(){
  try{
    const data = await api(`/api/alerts?lat=${userLat}&lon=${userLon}`);
    const alerts = data.alerts || [];
    if(!alerts.length){ updateHazards('owm-alerts', []); return; }

    const chips = alerts.map(a => {
      const { level, icon } = classifyAlert(a.event);
      // Trim description to one sentence for the chip.
      const desc = (a.description || '').split(/[.\n]/)[0].trim().slice(0, 160);
      return { level, icon, title: a.event, text: desc || `Issued by ${a.sender || 'local authority'}.` };
    });
    updateHazards('owm-alerts', chips);
  }catch(e){
    console.error('Alerts load failed', e);
    updateHazards('owm-alerts', []);
  }
}

/* ---------------- Init ---------------- */
(function initFromUrlOrGeolocate(){
  // Reflect saved unit preference in the header toggle before any data loads.
  document.getElementById('unit-c').classList.toggle('active', unit === 'C');
  document.getElementById('unit-f').classList.toggle('active', unit === 'F');

  renderSavedPlaces();
  loadReadyChecklist();
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  const valid = Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  if(valid){
    loadLocation(lat, lon);
  } else {
    requestLocation();
  }
})();
