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

let map, userMarker, fireLayer, globalFireLayer, incidentLayer, tileLayer;
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
  btn.textContent = saved ? t('saved_btn') : t('save_btn');
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
      tf('heat_source', {temp: fmtTemp(lastWeather.temp), hum: Math.round(lastWeather.humidity)});
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
let lastAqiData = null; // cached AQI payload, used to re-render on language change

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
    document.getElementById('error-text').textContent = t('loc_no_geo');
    showState('error');
    return;
  }
  navigator.geolocation.getCurrentPosition(onLocationSuccess, onLocationError, {
    enableHighAccuracy:true, timeout:12000, maximumAge:60000
  });
}

function onLocationError(err){
  const messages = {
    1: t('loc_err_denied'),
    2: t('loc_err_unavail'),
    3: t('loc_err_timeout'),
  };
  document.getElementById('error-text').textContent = messages[err.code] || t('loc_err_default');
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
  lastAqiData = null;
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
  tileLayer = L.tileLayer(
    document.body.classList.contains('theme-light')
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 18, noWrap: true }
  ).addTo(map);

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
  btn.textContent = expanded ? t('map_close') : t('map_expand');
  if(map) setTimeout(() => { map.invalidateSize(); map.setMinZoom(1); }, 50);
}

function collapseMap(){
  const panel = document.getElementById('map-panel');
  if(!panel.classList.contains('expanded')) return;
  panel.classList.remove('expanded');
  const btn = document.getElementById('map-expand-btn');
  if(btn) btn.textContent = t('map_expand');
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
  if(feelsC >= 51.7) return { level:3, label:t('heat_cat_4_label'), desc:t('heat_cat_4_desc') };
  if(feelsC >= 39.4) return { level:3, label:t('heat_cat_3_label'), desc:t('heat_cat_3_desc') };
  if(feelsC >= 32.2) return { level:2, label:t('heat_cat_2_label'), desc:t('heat_cat_2_desc') };
  if(feelsC >= 26.7) return { level:1, label:t('heat_cat_1_label'), desc:t('heat_cat_1_desc') };
  return { level:0, label:t('heat_cat_0_label'), desc:t('heat_cat_0_desc') };
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
    tf('heat_source', {temp: fmtTemp(weather.temp), hum: Math.round(weather.humidity)});

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
    document.getElementById('hero-headline').textContent = t('hero_checking');
    document.getElementById('hero-sub').textContent = t('hero_sub');
    document.getElementById('hero-badge').textContent = '—';
    return;
  }

  const worst = levels.reduce((a, b) => b.level > a.level ? b : a);
  const level = worst.level;
  const hex = LEVEL_COLORS[level];

  hero.style.borderColor = hex;
  document.getElementById('hero-icon').style.background = hex;
  document.getElementById('hero-icon').textContent = { fire:'🔥', air:'🌫️', heat:'🌡️' }[worst.key];

  const statusWord = [t('status_good'), t('status_moderate'), t('status_unhealthy'), t('status_severe')][level];
  const badge = document.getElementById('hero-badge');
  badge.textContent = `${LEVEL_NAMES[level]} · ${statusWord}`;
  badge.style.background = hex;

  const headline = document.getElementById('hero-headline');
  const labelKey = { fire:'fire_card_label', air:'air_card_label', heat:'heat_card_label' }[worst.key];
  const label = t(labelKey).replace(/^[^\s]+\s/, ''); // strip emoji
  if(level === 0) headline.textContent = t('hero_good');
  else if(level === 1) headline.textContent = tf('hero_elevated', {label});
  else if(level === 2) headline.textContent = tf('hero_unhealthy', {label});
  else headline.textContent = tf('hero_dangerous', {label});

  document.getElementById('hero-sub').textContent = t('hero_sub');

  const place = document.getElementById('place-name').textContent;
  document.getElementById('hero-place').textContent = place;
  const now = new Date();
  document.getElementById('hero-updated').textContent =
    `Updated ${now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · local`;
}

/* ---------------- "What should I do?" advice engine ---------------- */

/* Profile-specific standing advice — looks up translations at render time via t(). */
function getStandingAdvice(prof){
  return [0,1,2,3].map(i => t(`standing_${prof}_${i}`));
}

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
    if(aqiLevel === 0) conditionItems.push({ icon:'✓', good:true, text:t('advice_air_good') });
    else {
      const aqiThreshold = profile === 'asthma' ? 1 : 2;
      if(aqiLevel >= aqiThreshold) conditionItems.push({ icon:'⚠', text:t('advice_windows') });
      if(aqiLevel >= 1 && profile === 'outdoor') conditionItems.push({ icon:'😷', text:t('advice_n95_outdoor') });
      if(aqiLevel >= 1 && profile === 'asthma') conditionItems.push({ icon:'💊', text:t('advice_inhaler') });
      if(aqiLevel >= 2) conditionItems.push({ icon:'🏠', text:t('advice_indoors') });
    }
  }

  if(heatLevel != null){
    if(heatLevel === 0) conditionItems.push({ icon:'✓', good:true, text:t('advice_heat_good') });
    else {
      if(heatLevel >= 2) conditionItems.push({ icon:'🌡', text:t('advice_exercise') });
      else conditionItems.push({ icon:'💧', text:t('advice_hydrate') });
      if(heatLevel >= 1 && profile === 'elderly') conditionItems.push({ icon:'🕐', text:t('advice_peak_heat') });
      if(heatLevel >= 1 && profile === 'outdoor') conditionItems.push({ icon:'🌿', text:t('advice_shade_breaks') });
      if(heatLevel >= 2 && profile === 'elderly') conditionItems.push({ icon:'📞', text:t('advice_check_neighbors') });
    }
  }

  if(fireLevel != null){
    if(fireLevel === 0) conditionItems.push({ icon:'✓', good:true, text:t('advice_fire_good') });
    else if(fireLevel === 1) conditionItems.push({ icon:'👀', text:t('advice_fire_aware') });
    else if(fireLevel >= 2) conditionItems.push({ icon:'🚗', text:t('advice_evac_bag') });
  }

  if(fireLevel >= 3) conditionItems.push({ icon:'🚨', text:t('advice_evacuate_now') });
  if(windKmh != null && windKmh >= 35) conditionItems.push({ icon:'💨', text:t('advice_wind') });

  // --- Standing (always-on) advice for this profile ---
  const standing = getStandingAdvice(profile) || getStandingAdvice('general');

  // --- Resources ---
  const resources = PROFILE_RESOURCES[profile] || PROFILE_RESOURCES.general;

  // --- Render ---
  const list = document.getElementById('advice-list');

  let html = '';

  if(!anyData){
    html += `<div class="advice-item"><span class="chk muted">…</span>${t('advice_waiting')}</div>`;
  } else if(conditionItems.length){
    html += `<div class="advice-section-label">${t('advice_right_now')}</div>`;
    html += conditionItems.map(i =>
      `<div class="advice-item${i.good ? ' good' : ''}"><span class="chk">${i.icon}</span>${i.text}</div>`
    ).join('');
  }

  html += `<div class="advice-section-label">${t('advice_always')}</div>`;
  html += standing.map(s => `<div class="advice-item baseline"><span class="chk">✓</span>${s}</div>`).join('');

  html += `<div class="advice-section-label">${t('advice_resources')}</div>`;
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
  badge.dataset.tip = `FWI danger class (Canadian FWI System) — Low (0–5), Moderate (5–10), High (10–17), Very High (17–21), Extreme (21–28), Catastrophic (28+). Current FWI: ${indices.fwi}.`;

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
  document.getElementById('aqi-desc').textContent = t('aqi_loading');
  try{
    const data = await api(`/api/airquality?lat=${userLat}&lon=${userLon}&source=${aqiSource}`);
    if(data.scale === 'us-aqi'){
      renderAQI_US(data.aqi, data.pm2_5);
    } else {
      renderAQI_OWM(data.aqi, data.components);
    }
  }catch(e){
    console.error(e);
    document.getElementById('aqi-desc').textContent = t('aqi_unavailable');
    document.getElementById('aqi-num').textContent = '—';
    document.getElementById('aqi-foot').textContent = t('aqi_foot_unavail');
    const airLevelEl = document.getElementById('air-level');
    airLevelEl.querySelector('.dot').style.background = 'var(--muted)';
    document.getElementById('air-level-word').textContent = '—';
    document.getElementById('card-air').style.borderTopColor = 'var(--border)';
    document.getElementById('scale-note').textContent = t('aqi_scale_unavail');
    document.getElementById('scale-pointer').style.left = '0%';

    current.aqiLevel = null;
    current.aqiValue = null;
    updateHero();
    renderAdvice();
  }
}

function usAqiCategory(aqi){
  if(aqi <= 50)  return { label:t('aqi_us_0_label'), short:t('aqi_us_0_short'), level:0, hex:'#2ecc71', desc:t('aqi_us_0_desc') };
  if(aqi <= 100) return { label:t('aqi_us_1_label'), short:t('aqi_us_1_short'), level:1, hex:'#f1c40f', desc:t('aqi_us_1_desc') };
  if(aqi <= 150) return { label:t('aqi_us_2_label'), short:t('aqi_us_2_short'), level:2, hex:'#e67e22', desc:t('aqi_us_2_desc') };
  if(aqi <= 200) return { label:t('aqi_us_3_label'), short:t('aqi_us_3_short'), level:3, hex:'#e74c3c', desc:t('aqi_us_3_desc') };
  if(aqi <= 300) return { label:t('aqi_us_4_label'), short:t('aqi_us_4_short'), level:3, hex:'#9b59b6', desc:t('aqi_us_4_desc') };
  return { label:t('aqi_us_5_label'), short:t('aqi_us_5_short'), level:3, hex:'#6c3483', desc:t('aqi_us_5_desc') };
}

function owmAqiCategory(level){
  const map = {
    1: { label:t('aqi_owm_1_label'), short:t('aqi_owm_1_short'), level:0, hex:'#2ecc71', desc:t('aqi_owm_1_desc') },
    2: { label:t('aqi_owm_2_label'), short:t('aqi_owm_2_short'), level:0, hex:'#2ecc71', desc:t('aqi_owm_2_desc') },
    3: { label:t('aqi_owm_3_label'), short:t('aqi_owm_3_short'), level:1, hex:'#f1c40f', desc:t('aqi_owm_3_desc') },
    4: { label:t('aqi_owm_4_label'), short:t('aqi_owm_4_short'), level:2, hex:'#e67e22', desc:t('aqi_owm_4_desc') },
    5: { label:t('aqi_owm_5_label'), short:t('aqi_owm_5_short'), level:3, hex:'#e74c3c', desc:t('aqi_owm_5_desc') },
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
  document.getElementById('scale-note').textContent = tf('aqi_scale_note', {aqi: approxUsAqi, short: cat.short});

  updateHero();
  renderAdvice();
}

function renderAQI_US(aqi, pm25){
  lastAqiData = {type:'us', aqi, pm25};
  const cat = usAqiCategory(aqi);
  const pmText = pm25 != null ? tf('aqi_pm25', {val: Math.round(pm25)}) : '';
  clearOwmPollutants();
  updateAqiCard(aqi, cat, `${cat.desc}${pmText}`, t('aqi_foot_cams'), aqi);
  updateHazards('aqi', aqi > 150 ? [{
    level: aqi > 200 ? 'severe' : 'warn', icon:'😷',
    title: aqi > 200 ? 'Unhealthy Air Quality' : 'Air Quality Advisory',
    text: 'Poor air quality may indicate nearby smoke or pollution — consider limiting outdoor exposure.'
  }] : []);
}

function renderAQI_OWM(level, components){
  lastAqiData = {type:'owm', level, components};
  const cat = owmAqiCategory(level);
  const pm25 = components?.pm2_5;
  const pmText = pm25 != null ? tf('aqi_pm25', {val: pm25.toFixed(1)}) : '';
  updateAqiCard(level, cat, `${cat.desc}${pmText}`, t('aqi_foot_owm'), owmToApproxUsAqi(level));
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

function rerenderAqi(){
  if(!lastAqiData) return;
  if(lastAqiData.type === 'us') renderAQI_US(lastAqiData.aqi, lastAqiData.pm25);
  else renderAQI_OWM(lastAqiData.level, lastAqiData.components);
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

  const CONF_TIPS = {
    low: 'Low confidence — possibly sun glint, industrial heat, or a very small/cool source. Treat with caution.',
    nominal: 'Nominal confidence — a typical VIIRS detection; likely a real fire but some uncertainty remains.',
    high: 'High confidence — a strong, clear thermal anomaly very likely to be an active fire.',
  };
  const FRP_TIP = 'FRP (Fire Radiative Power) — satellite-measured energy release in megawatts. Approximates fire intensity: higher MW = more energetic burning.';

  list.innerHTML = '';
  shown.forEach((f, i) => {
    const miles = Math.round(f.distKm * 0.621371);
    const distColor = miles <= 10 ? '#e67e22' : miles <= 25 ? '#f1c40f' : '#2ecc71';
    const frpColor = f.frp >= 100 ? '#e74c3c' : f.frp >= 30 ? '#e67e22' : '#ff5e2a';
    const confLabel = confidenceLabel(f.confidence);
    const confTip = CONF_TIPS[confLabel] || 'Detection confidence reported by the VIIRS satellite sensor.';
    const row = document.createElement('div');
    row.className = 'quake-row';
    row.innerHTML = `
      <div class="quake-mag" style="background:${frpColor}">🔥</div>
      <div class="quake-info">
        <div class="quake-place">${tf('detection_label', {n: sorted.indexOf(f)+1})}</div>
        <div class="quake-time">${t('detected_ago')} ${timeAgoFromFirms(f.date, f.time)} · <span data-tip="${confTip}">${t('confidence_label')} ${confLabel}</span>${f.frp != null ? ` · <span data-tip="${FRP_TIP}">FRP ${Math.round(f.frp)} MW</span>` : ''}</div>
      </div>
      <div class="quake-dist" style="color:${distColor}">${miles} mi<span class="sub">${f.dir}</span></div>`;
    list.appendChild(row);
  });

  if(expandBtn){
    if(sorted.length > PREVIEW){
      expandBtn.classList.remove('hidden');
      expandBtn.textContent = firesExpanded
        ? t('fire_show_less')
        : tf('fire_show_all', {n: sorted.length});
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
    desc.textContent = t('fire_no_detection');
    foot.textContent = t('fire_source');
    document.getElementById('fires-detail-list').innerHTML =
      `<div class="empty-note">${t('fire_no_detection_list')}</div>`;
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
  desc.textContent = miles <= 10 ? t('fire_close')
    : miles <= 25 ? t('fire_moderate') : t('fire_far');

  const brightest = lastFires.reduce((m, f) => f.brightness != null && f.brightness > m ? f.brightness : m, 0);
  const s = lastFires.length > 1 ? 's' : '';
  foot.textContent = tf('fire_detections', {n: lastFires.length, s}) +
    (brightest ? ` · ${tf('fire_brightest', {k: Math.round(brightest)})}` : '') + ` · ${t('fire_source')}`;

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
    verdictEl.textContent = t('sat_gathering');
    return;
  }

  const { totalFrp, clusterCount, avgConfidence, frpTrendPct, verdict } = satAnalytics;

  const satKey = verdict === 'clear' ? 'sat_clear'
    : clusterCount === 1 ? `sat_${verdict}_1` : `sat_${verdict}_pl`;
  const verdictText = verdict === 'clear' ? t('sat_clear') : tf(satKey, {n: clusterCount});
  verdictEl.textContent = verdictText;
  verdictEl.style.color = verdict === 'intensifying' ? 'var(--extreme, #b23a2e)' : '';

  trendEl.textContent = frpTrendPct == null ? t('sat_first_pass') : `${frpTrendPct >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(frpTrendPct))}%`;
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
  if(verdictEl) verdictEl.textContent = t('sat_unavailable');
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
  note.textContent = t('incidents_loading');
  try{
    const data = await api('/api/incidents/global?days=30');
    globalIncidents = data.incidents || [];
    const n = globalIncidents.length;
    note.textContent = n
      ? tf('incidents_count', {n, s: n>1?'s':''})
      : t('incidents_none');
    renderIncidentsList();
  }catch(e){
    console.error('Global incidents load failed', e);
    note.textContent = t('incidents_unavailable');
    list.innerHTML = `<div class="empty-note">${t('incidents_error')}</div>`;
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
        <div class="quake-place">${inc.title}<span class="incident-badge ${inc.isClosed ? 'closed' : 'open'}">${inc.isClosed ? t('incidents_past') : t('incidents_active')}</span></div>
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

/* ================================================================
 * LIGHT / DARK THEME
 * ================================================================ */

const THEME_KEY = 'fw-theme';

function applyTheme(theme){
  document.body.classList.remove('theme-dark','theme-light');
  document.body.classList.add(`theme-${theme}`);
  const btn = document.getElementById('theme-toggle-btn');
  if(btn) btn.textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem(THEME_KEY, theme);
  // Swap map tiles to match theme
  if(map && tileLayer){
    map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(
      theme === 'light'
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { attribution:'&copy; OpenStreetMap &copy; CARTO', maxZoom:18, noWrap:true }
    ).addTo(map);
  }
}

function initTheme(){
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}

function toggleTheme(){
  applyTheme(document.body.classList.contains('theme-dark') ? 'light' : 'dark');
}

/* ================================================================
 * INTERNATIONALISATION (i18n)
 * ================================================================ */

const LANG_KEY = 'fw-lang';
let currentLang = 'en';

const TRANSLATIONS = {
  en:{
    // Header / sections
    risk_intelligence:'Risk Intelligence',satellite_title:'Satellite Fire Analytics',
    nearby_title:'Nearby Fires',map_title:'Map',advice_title:'What should I do?',
    air_scale_title:'Air Quality Scale',incidents_title:'Global Wildfire Incidents',
    forecast_title:'5-Day Fire Weather Outlook',weather_title:'Weather',be_ready_title:'Be Ready',
    survival_title:'WILDFIRE SURVIVAL GUIDE',
    report_eyebrow:'HELP YOUR COMMUNITY',report_title:'Report a Fire Sighting',
    profile_general:'General',profile_asthma:'Asthma',profile_elderly:'Elderly',profile_outdoor:'Outdoor worker',
    sort_distance:'Distance',sort_size:'Size',
    // States / buttons
    loading_msg:'Waiting for location permission…',
    error_msg_default:'We need your location to assess wildfire risk here.',
    try_again:'Try again',locating:'Locating…',
    save_btn:'🔖 Save',saved_btn:'✓ Saved',share_btn:'↗ Share',my_location_btn:'📡 My location',
    search_placeholder:'Search a city or place…',
    // Risk card labels
    fire_card_label:'🔥 Wildfire',air_card_label:'🌫️ Air Quality',heat_card_label:'🌡️ Heat',
    fire_detail_hint:'Tap for FWI fire-danger details ▾',air_detail_hint:'Tap to change data source ▾',
    // Hero
    hero_checking:'Checking current conditions…',
    hero_sub:'Overall level is the worst of your three risks below.',
    hero_good:'Conditions look good — enjoy the outdoors.',
    hero_elevated:'{label} is elevated today — stay aware.',
    hero_unhealthy:'{label} is unhealthy today — limit time outdoors.',
    hero_dangerous:'{label} is at dangerous levels — avoid outdoor exposure.',
    status_good:'GOOD',status_moderate:'MODERATE',status_unhealthy:'UNHEALTHY',status_severe:'SEVERE',
    // Satellite
    sat_gathering:'Gathering satellite passes…',
    sat_clear:'No satellite-detected fire activity nearby',
    sat_stable_1:'{n} fire cluster detected — activity level stable between passes',
    sat_stable_pl:'{n} fire clusters detected — activity level stable between passes',
    sat_intensifying_1:'{n} fire cluster detected — intensifying between satellite passes',
    sat_intensifying_pl:'{n} fire clusters detected — intensifying between satellite passes',
    sat_weakening_1:'{n} fire cluster detected — activity declining between passes',
    sat_weakening_pl:'{n} fire clusters detected — activity declining between passes',
    sat_unavailable:'Satellite analytics unavailable right now',sat_first_pass:'First pass',
    // Fire card
    fire_no_detection:'No active fire detected nearby. Stay aware of local conditions.',
    fire_no_detection_list:'No fire detections within ~65km in the last 24h.',
    fire_close:'An active fire is close by. Stay alert and follow local evacuation guidance.',
    fire_moderate:'Nearest active fire is a moderate distance away. Stay aware.',
    fire_far:'Nearest active fire detection is a safe distance away.',
    fire_source:'Source: NASA FIRMS',
    fire_detections:'{n} detection{s} nearby',fire_brightest:'brightest {k} K',
    fire_show_all:'Show all {n} ▾',fire_show_less:'Show less ▴',
    detection_label:'Detection #{n}',detected_ago:'Detected',confidence_label:'confidence',
    // Advice
    advice_waiting:'Waiting for current conditions…',
    advice_right_now:'Right now',advice_always:'Always',advice_resources:'Resources',
    advice_air_good:'Air quality is good — fine for outdoor activity today.',
    advice_windows:'Keep windows and doors closed today.',
    advice_n95_outdoor:'Wear an N95 mask if working outdoors for extended periods.',
    advice_inhaler:'Have your rescue inhaler on your person, not just nearby.',
    advice_indoors:'Stay indoors and run an air purifier or AC on recirculate.',
    advice_heat_good:'Temperatures are comfortable — no heat precautions needed.',
    advice_exercise:'Move exercise indoors — avoid strenuous outdoor activity.',
    advice_hydrate:'Stay hydrated and take breaks in the shade.',
    advice_peak_heat:'Avoid outdoor activity during peak heat hours (12–4 pm).',
    advice_shade_breaks:'Take shade breaks every 20 minutes and drink 1 cup of water every 20 min.',
    advice_check_neighbors:'Check on neighbours with limited mobility or no air conditioning.',
    advice_fire_good:'No active fires detected nearby — conditions look calm.',
    advice_fire_aware:'Stay aware of nearby fire activity and any sudden air quality changes.',
    advice_evac_bag:'Have an evacuation bag packed and monitor official fire alerts closely.',
    advice_evacuate_now:'Follow all official evacuation orders immediately — do not wait.',
    advice_wind:'Secure loose outdoor furniture and items — winds can spread embers.',
    // Standing advice (always-on per profile)
    standing_general_0:'Check local fire authority alerts before outdoor activities.',
    standing_general_1:'Keep windows closed on smoky or high-wind days.',
    standing_general_2:'Know your nearest two evacuation routes.',
    standing_general_3:'Keep at least 3 days of emergency supplies at home.',
    standing_asthma_0:'Keep your rescue inhaler accessible at all times.',
    standing_asthma_1:'Monitor AQI daily — airways react before you feel it.',
    standing_asthma_2:'Use a HEPA air filter indoors on smoky days.',
    standing_asthma_3:'Have a written asthma action plan and share it with someone nearby.',
    standing_elderly_0:'Stay hydrated — thirst response weakens with age.',
    standing_elderly_1:'Keep medications stocked for at least 2 weeks.',
    standing_elderly_2:'Identify a cool refuge (library, community center) if AC fails.',
    standing_elderly_3:'Ensure someone checks in on you daily during high-risk periods.',
    standing_outdoor_0:'Check fire weather forecast before starting each shift.',
    standing_outdoor_1:'Carry water and a dust mask on every job.',
    standing_outdoor_2:'Have a communication plan for areas with no cell signal.',
    standing_outdoor_3:'Know the location of the nearest fire station or emergency exit.',
    // Incidents
    incidents_loading:'Loading global incident data…',
    incidents_count:'{n} wildfire incident{s} tracked worldwide in the past 30 days',
    incidents_none:'No global wildfire incidents tracked in the past 30 days',
    incidents_unavailable:'Global incident data unavailable right now',
    incidents_error:"Couldn't reach NASA EONET — try again shortly.",
    incidents_active:'Active',incidents_past:'Past',incidents_show_map:'🌍 Show on map',
    // Map
    map_expand:'⤢ Expand',map_your_location:'Your location',
    map_fire_low:'Fire (low)',map_fire_med:'Fire (med)',map_fire_intense:'Fire (intense)',
    map_click_spot:'Click map to check a spot',global_fires_btn:'🔥 Global fires',
    // Weather labels
    w_temp:'Temp',w_wind:'Wind',w_humidity:'Humidity',w_rain:'7-day rain',
    // Be Ready
    ready_sub:'Emergency preparedness checklist',
    ready_gobag:'Go bag packed with 3-day supplies',
    ready_docs:'Important documents copied or backed up',
    ready_meds:'Medications (7-day supply)',
    ready_routes:'Know your evacuation routes',
    ready_alerts:'Signed up for local emergency alerts',
    ready_masks:'N95 masks on hand for smoke',
    ready_battery:'Phone charger and backup battery',
    ready_pets:'Pet carriers and supplies ready',
    ready_contacts_title:'Emergency Contacts',
    // Tips phases
    tips_before_tab:'Before',tips_during_tab:'During',tips_after_tab:'After',
    tips_before_title:'Before a Fire',
    tips_before_sub:'What to do now, before fire season puts you under pressure.',
    tips_during_title:'During a Fire',
    tips_during_sub:'Real-time decisions that save lives when every minute counts.',
    tips_after_title:'After a Fire',
    tips_after_sub:'Safe re-entry and recovery steps to protect your health.',
    // Report form
    report_sub:'See smoke or flames? Generate a shareable report and contact authorities fast.',
    report_what_label:'What did you see?',
    report_smoke:'Smoke column or haze',report_flame:'Active flames visible',
    report_glow:'Unusual orange glow at night',report_other:'Other unusual activity',
    report_notes_label:'Notes (optional)',
    report_notes_placeholder:'Direction, distance estimate, wind conditions…',
    report_generate_btn:'Generate Report',report_copy_btn:'📋 Copy',report_to:'Report to:',
    // Heat categories
    heat_cat_4_label:'Extreme Danger',heat_cat_4_desc:'Heat stroke is likely — avoid outdoor exposure entirely.',
    heat_cat_3_label:'Danger',heat_cat_3_desc:'High risk of heat-related illness — avoid strenuous outdoor activity.',
    heat_cat_2_label:'Extreme Caution',heat_cat_2_desc:'Caution — hydrate and take breaks in the shade.',
    heat_cat_1_label:'Caution',heat_cat_1_desc:'Fatigue is possible with prolonged exposure or activity.',
    heat_cat_0_label:'Comfortable',heat_cat_0_desc:'Heat is not a significant concern right now.',
    heat_source:'Actual {temp} · humidity {hum}% · source: Open-Meteo',
    // AQI US categories
    aqi_us_0_label:'GOOD',aqi_us_0_short:'Good',aqi_us_0_desc:'Air quality is satisfactory.',
    aqi_us_1_label:'MODERATE',aqi_us_1_short:'Moderate',aqi_us_1_desc:'Acceptable, but a concern for unusually sensitive people.',
    aqi_us_2_label:'UNHEALTHY (SENSITIVE)',aqi_us_2_short:'Sensitive',aqi_us_2_desc:'Sensitive groups may experience health effects.',
    aqi_us_3_label:'UNHEALTHY',aqi_us_3_short:'Unhealthy',aqi_us_3_desc:'Everyone may begin to experience health effects.',
    aqi_us_4_label:'VERY UNHEALTHY',aqi_us_4_short:'Very Unhealthy',aqi_us_4_desc:'Health alert — everyone may experience serious effects.',
    aqi_us_5_label:'HAZARDOUS',aqi_us_5_short:'Hazardous',aqi_us_5_desc:'Emergency conditions — entire population at risk.',
    // AQI OWM categories
    aqi_owm_1_label:'GOOD',aqi_owm_1_short:'Good',aqi_owm_1_desc:'Air quality is good.',
    aqi_owm_2_label:'FAIR',aqi_owm_2_short:'Fair',aqi_owm_2_desc:'Air quality is acceptable.',
    aqi_owm_3_label:'MODERATE',aqi_owm_3_short:'Moderate',aqi_owm_3_desc:'Sensitive groups may notice effects.',
    aqi_owm_4_label:'POOR',aqi_owm_4_short:'Poor',aqi_owm_4_desc:'Health effects may be experienced by most people.',
    aqi_owm_5_label:'VERY POOR',aqi_owm_5_short:'Very Poor',aqi_owm_5_desc:'Health warning of emergency conditions.',
    // AQI UI
    aqi_loading:'Loading air quality data…',
    aqi_unavailable:'Air quality data unavailable right now.',
    aqi_foot_cams:'Dominant pollutant: PM2.5 · source: Open-Meteo (CAMS)',
    aqi_foot_owm:'Dominant pollutant: PM2.5 · source: OpenWeatherMap (1–5 scale)',
    aqi_foot_unavail:'Source: unavailable',
    aqi_scale_note:'US EPA AQI · currently {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · data unavailable',
    aqi_pm25:' PM2.5 is {val} µg/m³.',
    // Location errors
    loc_no_geo:"This browser doesn't support location services.",
    loc_err_denied:'Location permission was denied. Please allow location access to see your wildfire risk.',
    loc_err_unavail:"We couldn't determine your position. Check your connection and try again.",
    loc_err_timeout:'Location request timed out. Try again.',
    loc_err_default:'Something went wrong getting your location.',
    map_close:'✕ Close',
  },
  es:{
    risk_intelligence:'Inteligencia de Riesgo',satellite_title:'Análisis Satelital de Incendios',
    nearby_title:'Incendios Cercanos',map_title:'Mapa',advice_title:'¿Qué debo hacer?',
    air_scale_title:'Escala de Calidad del Aire',incidents_title:'Incendios Forestales Globales',
    forecast_title:'Pronóstico de Incendio (5 días)',weather_title:'Clima',be_ready_title:'Prepárate',
    survival_title:'GUÍA DE SUPERVIVENCIA',
    report_eyebrow:'AYUDA A TU COMUNIDAD',report_title:'Reportar un Avistamiento',
    profile_general:'General',profile_asthma:'Asma',profile_elderly:'Adulto mayor',profile_outdoor:'Trabajador al aire libre',
    sort_distance:'Distancia',sort_size:'Tamaño',
    loading_msg:'Esperando permiso de ubicación…',
    error_msg_default:'Necesitamos tu ubicación para evaluar el riesgo de incendio.',
    try_again:'Intentar de nuevo',locating:'Localizando…',
    save_btn:'🔖 Guardar',saved_btn:'✓ Guardado',share_btn:'↗ Compartir',my_location_btn:'📡 Mi ubicación',
    search_placeholder:'Busca una ciudad o lugar…',
    fire_card_label:'🔥 Incendio Forestal',air_card_label:'🌫️ Calidad del Aire',heat_card_label:'🌡️ Calor',
    fire_detail_hint:'Toca para ver detalles FWI ▾',air_detail_hint:'Toca para cambiar la fuente ▾',
    hero_checking:'Verificando condiciones actuales…',
    hero_sub:'El nivel general es el peor de los tres riesgos.',
    hero_good:'Las condiciones se ven bien — disfruta el exterior.',
    hero_elevated:'{label} está elevado hoy — mantente alerta.',
    hero_unhealthy:'{label} es poco saludable hoy — limita el tiempo al aire libre.',
    hero_dangerous:'{label} está en niveles peligrosos — evita la exposición exterior.',
    status_good:'BUENO',status_moderate:'MODERADO',status_unhealthy:'INSALUBRE',status_severe:'GRAVE',
    sat_gathering:'Recopilando pasadas de satélite…',
    sat_clear:'Sin actividad de incendio detectada por satélite cerca',
    sat_stable_1:'{n} grupo de incendio detectado — actividad estable entre pasadas',
    sat_stable_pl:'{n} grupos de incendios detectados — actividad estable entre pasadas',
    sat_intensifying_1:'{n} grupo de incendio detectado — intensificándose entre pasadas',
    sat_intensifying_pl:'{n} grupos de incendios detectados — intensificándose entre pasadas',
    sat_weakening_1:'{n} grupo de incendio detectado — actividad disminuyendo entre pasadas',
    sat_weakening_pl:'{n} grupos de incendios detectados — actividad disminuyendo entre pasadas',
    sat_unavailable:'Análisis satelital no disponible',sat_first_pass:'Primera pasada',
    fire_no_detection:'Ningún incendio activo detectado cerca. Mantente atento.',
    fire_no_detection_list:'Sin detecciones de incendio en ~65km en las últimas 24h.',
    fire_close:'Hay un incendio activo cerca. Mantente alerta y sigue las indicaciones locales.',
    fire_moderate:'El incendio activo más cercano está a distancia moderada. Mantente alerta.',
    fire_far:'La detección de incendio más cercana está a distancia segura.',
    fire_source:'Fuente: NASA FIRMS',
    fire_detections:'{n} detección{s} cercana{s}',fire_brightest:'más brillante {k} K',
    fire_show_all:'Ver todos {n} ▾',fire_show_less:'Ver menos ▴',
    detection_label:'Detección #{n}',detected_ago:'Detectado',confidence_label:'confianza',
    advice_waiting:'Esperando condiciones actuales…',
    advice_right_now:'Ahora mismo',advice_always:'Siempre',advice_resources:'Recursos',
    advice_air_good:'La calidad del aire es buena — apta para actividades al aire libre.',
    advice_windows:'Mantén ventanas y puertas cerradas hoy.',
    advice_n95_outdoor:'Usa mascarilla N95 si trabajas al exterior por períodos prolongados.',
    advice_inhaler:'Ten tu inhalador de rescate contigo, no solo cerca.',
    advice_indoors:'Quédate en interior y usa purificador de aire o AC en recirculación.',
    advice_heat_good:'Las temperaturas son cómodas — no se necesitan precauciones de calor.',
    advice_exercise:'Haz ejercicio en interior — evita actividad física intensa al exterior.',
    advice_hydrate:'Mantente hidratado y toma descansos a la sombra.',
    advice_peak_heat:'Evita actividad al exterior en horas de mayor calor (12–16 h).',
    advice_shade_breaks:'Descansa a la sombra cada 20 min y bebe agua frecuentemente.',
    advice_check_neighbors:'Revisa a vecinos con movilidad reducida o sin aire acondicionado.',
    advice_fire_good:'No se detectan incendios activos cerca — condiciones tranquilas.',
    advice_fire_aware:'Mantente atento a la actividad de incendios y cambios en la calidad del aire.',
    advice_evac_bag:'Ten lista una bolsa de evacuación y sigue las alertas oficiales.',
    advice_evacuate_now:'Sigue todas las órdenes de evacuación inmediatamente — no esperes.',
    advice_wind:'Asegura los muebles y objetos sueltos al exterior — el viento puede propagar brasas.',
    standing_general_0:'Consulta las alertas de la autoridad de incendios antes de actividades al exterior.',
    standing_general_1:'Mantén las ventanas cerradas en días con humo o viento fuerte.',
    standing_general_2:'Conoce tus dos rutas de evacuación más cercanas.',
    standing_general_3:'Mantén al menos 3 días de suministros de emergencia en casa.',
    standing_asthma_0:'Ten tu inhalador de rescate accesible en todo momento.',
    standing_asthma_1:'Monitorea el AQI diariamente — las vías respiratorias reaccionan antes de sentirlo.',
    standing_asthma_2:'Usa un filtro de aire HEPA en interior los días con humo.',
    standing_asthma_3:'Ten un plan de acción para el asma por escrito y compártelo con alguien cercano.',
    standing_elderly_0:'Mantente hidratado — la respuesta a la sed disminuye con la edad.',
    standing_elderly_1:'Ten medicamentos almacenados para al menos 2 semanas.',
    standing_elderly_2:'Identifica un refugio fresco (biblioteca, centro comunitario) si falla el AC.',
    standing_elderly_3:'Asegúrate de que alguien te visite diariamente en períodos de alto riesgo.',
    standing_outdoor_0:'Revisa el pronóstico de clima de incendio antes de cada turno.',
    standing_outdoor_1:'Lleva agua y mascarilla antipolvo en cada trabajo.',
    standing_outdoor_2:'Ten un plan de comunicación para zonas sin señal de celular.',
    standing_outdoor_3:'Conoce la ubicación de la estación de bomberos o salida de emergencia más cercana.',
    incidents_loading:'Cargando datos de incidentes globales…',
    incidents_count:'{n} incendio{s} forestal{s} rastreado{s} mundialmente en los últimos 30 días',
    incidents_none:'No se rastrearon incendios forestales globales en los últimos 30 días',
    incidents_unavailable:'Datos de incidentes globales no disponibles',
    incidents_error:'No se pudo conectar con NASA EONET — intenta de nuevo en breve.',
    incidents_active:'Activo',incidents_past:'Pasado',incidents_show_map:'🌍 Ver en mapa',
    map_expand:'⤢ Ampliar',map_your_location:'Tu ubicación',
    map_fire_low:'Fuego (bajo)',map_fire_med:'Fuego (medio)',map_fire_intense:'Fuego (intenso)',
    map_click_spot:'Toca el mapa para verificar un punto',global_fires_btn:'🔥 Incendios globales',
    w_temp:'Temp',w_wind:'Viento',w_humidity:'Humedad',w_rain:'Lluvia 7 días',
    ready_sub:'Lista de verificación de preparación para emergencias',
    ready_gobag:'Mochila preparada con suministros para 3 días',
    ready_docs:'Documentos importantes copiados o respaldados',
    ready_meds:'Medicamentos (suministro de 7 días)',
    ready_routes:'Conoce tus rutas de evacuación',
    ready_alerts:'Registrado para alertas de emergencia locales',
    ready_masks:'Mascarillas N95 disponibles para el humo',
    ready_battery:'Cargador y batería de respaldo para el teléfono',
    ready_pets:'Transportadores y suministros para mascotas listos',
    ready_contacts_title:'Contactos de Emergencia',
    tips_before_tab:'Antes',tips_during_tab:'Durante',tips_after_tab:'Después',
    tips_before_title:'Antes de un Incendio',
    tips_before_sub:'Qué hacer ahora, antes de que la temporada de incendios te presione.',
    tips_during_title:'Durante un Incendio',
    tips_during_sub:'Acciones a tomar cuando el incendio es inminente u ocurre.',
    tips_after_title:'Después de un Incendio',
    tips_after_sub:'Pasos de recuperación para proteger tu salud.',
    report_sub:'¿Ves humo o llamas? Genera un reporte compartible y contacta a las autoridades.',
    report_what_label:'¿Qué viste?',
    report_smoke:'Columna de humo o neblina',report_flame:'Llamas activas visibles',
    report_glow:'Resplandor naranja inusual de noche',report_other:'Otra actividad inusual',
    report_notes_label:'Notas (opcional)',
    report_notes_placeholder:'Dirección, estimado de distancia, condiciones de viento…',
    report_generate_btn:'Generar Reporte',report_copy_btn:'📋 Copiar',report_to:'Reportar a:',
    heat_cat_4_label:'Peligro extremo',heat_cat_4_desc:'El golpe de calor es probable — evita toda exposición al exterior.',
    heat_cat_3_label:'Peligro',heat_cat_3_desc:'Alto riesgo de enfermedad por calor — evita actividades físicas intensas al exterior.',
    heat_cat_2_label:'Precaución extrema',heat_cat_2_desc:'Precaución — hidrátate y toma descansos a la sombra.',
    heat_cat_1_label:'Precaución',heat_cat_1_desc:'La fatiga es posible con exposición o actividad prolongada.',
    heat_cat_0_label:'Confortable',heat_cat_0_desc:'El calor no es una preocupación significativa ahora.',
    heat_source:'Real {temp} · humedad {hum}% · fuente: Open-Meteo',
    aqi_us_0_label:'BUENO',aqi_us_0_short:'Bueno',aqi_us_0_desc:'La calidad del aire es satisfactoria.',
    aqi_us_1_label:'MODERADO',aqi_us_1_short:'Moderado',aqi_us_1_desc:'Aceptable, pero puede ser un problema para personas sensibles.',
    aqi_us_2_label:'NO SALUDABLE (SENSIBLES)',aqi_us_2_short:'Sensible',aqi_us_2_desc:'Los grupos sensibles pueden experimentar efectos en la salud.',
    aqi_us_3_label:'NO SALUDABLE',aqi_us_3_short:'No saludable',aqi_us_3_desc:'Todos pueden comenzar a experimentar efectos en la salud.',
    aqi_us_4_label:'MUY NO SALUDABLE',aqi_us_4_short:'Muy no saludable',aqi_us_4_desc:'Alerta de salud — todos pueden experimentar efectos graves.',
    aqi_us_5_label:'PELIGROSO',aqi_us_5_short:'Peligroso',aqi_us_5_desc:'Condiciones de emergencia — toda la población en riesgo.',
    aqi_owm_1_label:'BUENO',aqi_owm_1_short:'Bueno',aqi_owm_1_desc:'La calidad del aire es buena.',
    aqi_owm_2_label:'ACEPTABLE',aqi_owm_2_short:'Aceptable',aqi_owm_2_desc:'La calidad del aire es aceptable.',
    aqi_owm_3_label:'MODERADO',aqi_owm_3_short:'Moderado',aqi_owm_3_desc:'Los grupos sensibles pueden notar efectos.',
    aqi_owm_4_label:'MALO',aqi_owm_4_short:'Malo',aqi_owm_4_desc:'La mayoría de las personas pueden experimentar efectos en la salud.',
    aqi_owm_5_label:'MUY MALO',aqi_owm_5_short:'Muy malo',aqi_owm_5_desc:'Alerta de salud de emergencia.',
    aqi_loading:'Cargando datos de calidad del aire…',
    aqi_unavailable:'Datos de calidad del aire no disponibles.',
    aqi_foot_cams:'Contaminante dominante: PM2.5 · fuente: Open-Meteo (CAMS)',
    aqi_foot_owm:'Contaminante dominante: PM2.5 · fuente: OpenWeatherMap (escala 1–5)',
    aqi_foot_unavail:'Fuente: no disponible',
    aqi_scale_note:'US EPA AQI · actualmente {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · datos no disponibles',
    aqi_pm25:' PM2.5 es {val} µg/m³.',
    loc_no_geo:'Este navegador no admite servicios de ubicación.',
    loc_err_denied:'Se denegó el permiso de ubicación. Permite el acceso a la ubicación para ver tu riesgo de incendio.',
    loc_err_unavail:'No pudimos determinar tu posición. Verifica tu conexión e inténtalo de nuevo.',
    loc_err_timeout:'La solicitud de ubicación agotó el tiempo de espera. Inténtalo de nuevo.',
    loc_err_default:'Algo salió mal al obtener tu ubicación.',
    map_close:'✕ Cerrar',
  },
  fr:{
    risk_intelligence:'Intelligence des Risques',satellite_title:'Analyse Satellite des Incendies',
    nearby_title:'Incendies à Proximité',map_title:'Carte',advice_title:'Que dois-je faire ?',
    air_scale_title:"Échelle de Qualité de l'Air",incidents_title:'Incendies Mondiaux',
    forecast_title:'Prévisions Météo-Feux 5 Jours',weather_title:'Météo',be_ready_title:'Soyez Prêt',
    survival_title:'GUIDE DE SURVIE INCENDIE',
    report_eyebrow:'AIDEZ VOTRE COMMUNAUTÉ',report_title:'Signaler un Incendie',
    profile_general:'Général',profile_asthma:'Asthme',profile_elderly:'Personnes âgées',profile_outdoor:'Travailleur extérieur',
    sort_distance:'Distance',sort_size:'Taille',
    loading_msg:"En attente de la permission de localisation…",
    error_msg_default:"Nous avons besoin de votre localisation pour évaluer le risque d'incendie.",
    try_again:'Réessayer',locating:'Localisation…',
    save_btn:'🔖 Enregistrer',saved_btn:'✓ Enregistré',share_btn:'↗ Partager',my_location_btn:'📡 Ma position',
    search_placeholder:'Rechercher une ville ou un lieu…',
    fire_card_label:'🔥 Feux de Forêt',air_card_label:"🌫️ Qualité de l'Air",heat_card_label:'🌡️ Chaleur',
    fire_detail_hint:'Touchez pour les détails FWI ▾',air_detail_hint:'Touchez pour changer la source ▾',
    hero_checking:'Vérification des conditions actuelles…',
    hero_sub:'Le niveau global est le pire de vos trois risques.',
    hero_good:'Les conditions sont bonnes — profitez du plein air.',
    hero_elevated:"{label} est élevé aujourd'hui — restez vigilant.",
    hero_unhealthy:"{label} est mauvais aujourd'hui — limitez le temps en extérieur.",
    hero_dangerous:"{label} est à des niveaux dangereux — évitez l'exposition extérieure.",
    status_good:'BON',status_moderate:'MODÉRÉ',status_unhealthy:'MAUVAIS',status_severe:'SÉVÈRE',
    sat_gathering:'Collecte des passages satellites…',
    sat_clear:'Aucune activité de feu détectée par satellite à proximité',
    sat_stable_1:'{n} foyer détecté — activité stable entre les passages',
    sat_stable_pl:'{n} foyers détectés — activité stable entre les passages',
    sat_intensifying_1:"{n} foyer détecté — s'intensifie entre les passages satellites",
    sat_intensifying_pl:"{n} foyers détectés — s'intensifient entre les passages satellites",
    sat_weakening_1:'{n} foyer détecté — activité en baisse entre les passages',
    sat_weakening_pl:'{n} foyers détectés — activité en baisse entre les passages',
    sat_unavailable:'Analyse satellite indisponible',sat_first_pass:'Premier passage',
    fire_no_detection:'Aucun incendie actif détecté à proximité. Restez attentif.',
    fire_no_detection_list:'Aucune détection de feu dans ~65km au cours des dernières 24h.',
    fire_close:"Un incendie actif est proche. Restez alerte et suivez les consignes locales.",
    fire_moderate:"L'incendie actif le plus proche est à distance modérée. Restez vigilant.",
    fire_far:"La détection de feu la plus proche est à distance sûre.",
    fire_source:'Source : NASA FIRMS',
    fire_detections:'{n} détection{s} à proximité',fire_brightest:'plus brillant {k} K',
    fire_show_all:'Voir tout {n} ▾',fire_show_less:'Voir moins ▴',
    detection_label:'Détection #{n}',detected_ago:'Détecté',confidence_label:'confiance',
    advice_waiting:'En attente des conditions actuelles…',
    advice_right_now:'Maintenant',advice_always:'Toujours',advice_resources:'Ressources',
    advice_air_good:"La qualité de l'air est bonne — activités extérieures sans restriction.",
    advice_windows:"Gardez les fenêtres et portes fermées aujourd'hui.",
    advice_n95_outdoor:'Portez un masque N95 si vous travaillez en extérieur.',
    advice_inhaler:'Ayez votre inhalateur de secours sur vous, pas seulement à portée.',
    advice_indoors:"Restez à l'intérieur et utilisez un purificateur d'air ou la clim en recirculation.",
    advice_heat_good:'Les températures sont confortables — pas de précautions thermiques nécessaires.',
    advice_exercise:"Faites de l'exercice à l'intérieur — évitez l'effort physique intense en extérieur.",
    advice_hydrate:"Hydratez-vous et faites des pauses à l'ombre.",
    advice_peak_heat:"Évitez l'activité extérieure aux heures les plus chaudes (12–16 h).",
    advice_shade_breaks:"Faites des pauses à l'ombre toutes les 20 min et buvez régulièrement.",
    advice_check_neighbors:"Vérifiez l'état des voisins à mobilité réduite ou sans climatisation.",
    advice_fire_good:'Aucun incendie actif détecté à proximité — conditions calmes.',
    advice_fire_aware:"Restez attentif à l'activité des feux et aux changements de qualité de l'air.",
    advice_evac_bag:"Ayez un sac d'évacuation prêt et suivez les alertes officielles.",
    advice_evacuate_now:"Suivez immédiatement tous les ordres d'évacuation — n'attendez pas.",
    advice_wind:'Sécurisez les meubles et objets en extérieur — le vent peut propager des braises.',
    standing_general_0:'Consultez les alertes incendie avant toute activité extérieure.',
    standing_general_1:'Gardez les fenêtres fermées les jours de fumée ou de grand vent.',
    standing_general_2:"Connaissez vos deux itinéraires d'évacuation les plus proches.",
    standing_general_3:"Gardez au moins 3 jours de fournitures d'urgence à la maison.",
    standing_asthma_0:'Gardez votre inhalateur de secours accessible en tout temps.',
    standing_asthma_1:"Surveillez l'IQA quotidiennement — les voies respiratoires réagissent avant que vous le sentiez.",
    standing_asthma_2:"Utilisez un filtre à air HEPA en intérieur les jours de fumée.",
    standing_asthma_3:"Rédigez un plan d'action contre l'asthme et partagez-le avec quelqu'un de proche.",
    standing_elderly_0:"Restez hydraté — la sensation de soif s'affaiblit avec l'âge.",
    standing_elderly_1:'Gardez des médicaments pour au moins 2 semaines.',
    standing_elderly_2:"Identifiez un refuge frais (bibliothèque, centre communautaire) si la clim tombe en panne.",
    standing_elderly_3:"Assurez-vous que quelqu'un vous rend visite quotidiennement en période de risque élevé.",
    standing_outdoor_0:'Consultez les prévisions météo-feux avant chaque poste de travail.',
    standing_outdoor_1:"Portez de l'eau et un masque antipoussière à chaque intervention.",
    standing_outdoor_2:'Ayez un plan de communication pour les zones sans réseau.',
    standing_outdoor_3:'Connaissez la caserne de pompiers ou sortie de secours la plus proche.',
    incidents_loading:'Chargement des données mondiales…',
    incidents_count:'{n} incendie{s} suivi{s} dans le monde au cours des 30 derniers jours',
    incidents_none:'Aucun incendie mondial suivi au cours des 30 derniers jours',
    incidents_unavailable:'Données mondiales indisponibles',
    incidents_error:'Impossible de joindre NASA EONET — réessayez sous peu.',
    incidents_active:'Actif',incidents_past:'Passé',incidents_show_map:'🌍 Afficher sur la carte',
    map_expand:'⤢ Agrandir',map_your_location:'Votre position',
    map_fire_low:'Feu (faible)',map_fire_med:'Feu (moyen)',map_fire_intense:'Feu (intense)',
    map_click_spot:'Cliquez sur la carte pour analyser un point',global_fires_btn:'🔥 Feux mondiaux',
    w_temp:'Temp',w_wind:'Vent',w_humidity:'Humidité',w_rain:'Pluie 7 j',
    ready_sub:"Liste de préparation aux urgences",
    ready_gobag:"Sac d'urgence avec fournitures pour 3 jours",
    ready_docs:'Documents importants copiés ou sauvegardés',
    ready_meds:'Médicaments (7 jours)',
    ready_routes:"Connaître ses itinéraires d'évacuation",
    ready_alerts:"Inscrit aux alertes d'urgence locales",
    ready_masks:'Masques N95 disponibles contre la fumée',
    ready_battery:'Chargeur et batterie de secours pour le téléphone',
    ready_pets:'Transporteurs et fournitures pour animaux prêts',
    ready_contacts_title:"Contacts d'Urgence",
    tips_before_tab:'Avant',tips_during_tab:'Pendant',tips_after_tab:'Après',
    tips_before_title:'Avant un Incendie',
    tips_before_sub:"Ce qu'il faut faire maintenant, avant que la saison des feux s'installe.",
    tips_during_title:'Pendant un Incendie',
    tips_during_sub:'Décisions en temps réel qui sauvent des vies quand chaque minute compte.',
    tips_after_title:'Après un Incendie',
    tips_after_sub:'Retour sécurisé et mesures de rétablissement pour protéger votre santé.',
    report_sub:'Vous voyez de la fumée ou des flammes ? Générez un rapport partageable.',
    report_what_label:"Qu'avez-vous vu ?",
    report_smoke:'Colonne de fumée ou brume',report_flame:'Flammes actives visibles',
    report_glow:'Lueur orange inhabituelle la nuit',report_other:'Autre activité inhabituelle',
    report_notes_label:'Notes (facultatif)',
    report_notes_placeholder:'Direction, estimation de la distance, conditions de vent…',
    report_generate_btn:'Générer le rapport',report_copy_btn:'📋 Copier',report_to:'Signaler à :',
    heat_cat_4_label:'Danger extrême',heat_cat_4_desc:"Le coup de chaleur est probable — évitez toute exposition extérieure.",
    heat_cat_3_label:'Danger',heat_cat_3_desc:"Risque élevé de maladie liée à la chaleur — évitez l'activité physique intense en extérieur.",
    heat_cat_2_label:'Vigilance extrême',heat_cat_2_desc:"Vigilance — hydratez-vous et faites des pauses à l'ombre.",
    heat_cat_1_label:'Vigilance',heat_cat_1_desc:"La fatigue est possible avec une exposition ou une activité prolongée.",
    heat_cat_0_label:'Confortable',heat_cat_0_desc:"La chaleur n'est pas une préoccupation majeure pour le moment.",
    heat_source:'Réel {temp} · humidité {hum}% · source : Open-Meteo',
    aqi_us_0_label:'BON',aqi_us_0_short:'Bon',aqi_us_0_desc:"La qualité de l'air est satisfaisante.",
    aqi_us_1_label:'MODÉRÉ',aqi_us_1_short:'Modéré',aqi_us_1_desc:"Acceptable, mais préoccupant pour les personnes sensibles.",
    aqi_us_2_label:'MAUVAIS (SENSIBLES)',aqi_us_2_short:'Sensible',aqi_us_2_desc:"Les groupes sensibles peuvent ressentir des effets sur la santé.",
    aqi_us_3_label:'MAUVAIS',aqi_us_3_short:'Mauvais',aqi_us_3_desc:"Tout le monde peut commencer à ressentir des effets sur la santé.",
    aqi_us_4_label:'TRÈS MAUVAIS',aqi_us_4_short:'Très mauvais',aqi_us_4_desc:"Alerte santé — des effets graves possibles pour tous.",
    aqi_us_5_label:'DANGEREUX',aqi_us_5_short:'Dangereux',aqi_us_5_desc:"Conditions d'urgence — toute la population est à risque.",
    aqi_owm_1_label:'BON',aqi_owm_1_short:'Bon',aqi_owm_1_desc:"La qualité de l'air est bonne.",
    aqi_owm_2_label:'CORRECT',aqi_owm_2_short:'Correct',aqi_owm_2_desc:"La qualité de l'air est acceptable.",
    aqi_owm_3_label:'MODÉRÉ',aqi_owm_3_short:'Modéré',aqi_owm_3_desc:"Les groupes sensibles peuvent remarquer des effets.",
    aqi_owm_4_label:'MAUVAIS',aqi_owm_4_short:'Mauvais',aqi_owm_4_desc:"La plupart des gens peuvent ressentir des effets sur la santé.",
    aqi_owm_5_label:'TRÈS MAUVAIS',aqi_owm_5_short:'Très mauvais',aqi_owm_5_desc:"Alerte sanitaire d'urgence.",
    aqi_loading:"Chargement des données de qualité de l'air…",
    aqi_unavailable:"Données de qualité de l'air non disponibles.",
    aqi_foot_cams:'Polluant dominant : PM2.5 · source : Open-Meteo (CAMS)',
    aqi_foot_owm:'Polluant dominant : PM2.5 · source : OpenWeatherMap (échelle 1–5)',
    aqi_foot_unavail:'Source : indisponible',
    aqi_scale_note:'US EPA AQI · actuellement {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · données indisponibles',
    aqi_pm25:' PM2.5 est {val} µg/m³.',
    loc_no_geo:"Ce navigateur ne prend pas en charge les services de localisation.",
    loc_err_denied:"La permission de localisation a été refusée. Veuillez autoriser l'accès à la localisation.",
    loc_err_unavail:"Nous n'avons pas pu déterminer votre position. Vérifiez votre connexion et réessayez.",
    loc_err_timeout:"La demande de localisation a expiré. Réessayez.",
    loc_err_default:"Une erreur s'est produite lors de la récupération de votre position.",
    map_close:'✕ Fermer',
  },
  de:{
    risk_intelligence:'Risikoanalyse',satellite_title:'Satelliten-Feueranalyse',
    nearby_title:'Nahegelegene Feuer',map_title:'Karte',advice_title:'Was soll ich tun?',
    air_scale_title:'Luftqualitätsskala',incidents_title:'Globale Waldbrandereignisse',
    forecast_title:'5-Tage-Feuerwettervorhersage',weather_title:'Wetter',be_ready_title:'Vorbereitet sein',
    survival_title:'WALDBRAND-ÜBERLEBENSGUIDE',
    report_eyebrow:'HELFE DEINER GEMEINDE',report_title:'Feuerbeobachtung melden',
    profile_general:'Allgemein',profile_asthma:'Asthma',profile_elderly:'Senioren',profile_outdoor:'Außenarbeiter',
    sort_distance:'Entfernung',sort_size:'Größe',
    loading_msg:'Warte auf Standortberechtigung…',
    error_msg_default:'Wir benötigen Ihren Standort, um das Waldbrandrisiko zu beurteilen.',
    try_again:'Erneut versuchen',locating:'Ortung…',
    save_btn:'🔖 Speichern',saved_btn:'✓ Gespeichert',share_btn:'↗ Teilen',my_location_btn:'📡 Mein Standort',
    search_placeholder:'Stadt oder Ort suchen…',
    fire_card_label:'🔥 Waldbrand',air_card_label:'🌫️ Luftqualität',heat_card_label:'🌡️ Hitze',
    fire_detail_hint:'Tippen für FWI-Details ▾',air_detail_hint:'Tippen zum Ändern der Quelle ▾',
    hero_checking:'Aktuelle Bedingungen werden geprüft…',
    hero_sub:'Der Gesamtlevel ist der schlechteste Ihrer drei Risiken.',
    hero_good:'Die Bedingungen sind gut — genießen Sie die Natur.',
    hero_elevated:'{label} ist heute erhöht — bleiben Sie aufmerksam.',
    hero_unhealthy:'{label} ist heute ungesund — begrenzen Sie die Zeit im Freien.',
    hero_dangerous:'{label} hat gefährliche Werte — meiden Sie Außenaufenthalte.',
    status_good:'GUT',status_moderate:'MÄSSIG',status_unhealthy:'UNGESUND',status_severe:'SCHWER',
    sat_gathering:'Satellitendaten werden gesammelt…',
    sat_clear:'Keine satellitengestützte Feueraktivität in der Nähe erkannt',
    sat_stable_1:'{n} Feuerherd erkannt — Aktivität zwischen Überflügen stabil',
    sat_stable_pl:'{n} Feuerherde erkannt — Aktivität zwischen Überflügen stabil',
    sat_intensifying_1:'{n} Feuerherd erkannt — verstärkt sich zwischen Satellitenüberflügen',
    sat_intensifying_pl:'{n} Feuerherde erkannt — verstärken sich zwischen Satellitenüberflügen',
    sat_weakening_1:'{n} Feuerherd erkannt — Aktivität nimmt zwischen Überflügen ab',
    sat_weakening_pl:'{n} Feuerherde erkannt — Aktivität nimmt zwischen Überflügen ab',
    sat_unavailable:'Satellitenanalyse derzeit nicht verfügbar',sat_first_pass:'Erster Überflug',
    fire_no_detection:'Kein aktives Feuer in der Nähe erkannt. Bleiben Sie wachsam.',
    fire_no_detection_list:'Keine Feuererkennung innerhalb ~65km in den letzten 24h.',
    fire_close:'Ein aktives Feuer ist in der Nähe. Bleiben Sie wachsam und folgen Sie lokalen Anweisungen.',
    fire_moderate:'Das nächste aktive Feuer ist in mäßiger Entfernung. Bleiben Sie aufmerksam.',
    fire_far:'Die nächste Feuererkennung befindet sich in sicherer Entfernung.',
    fire_source:'Quelle: NASA FIRMS',
    fire_detections:'{n} Erkennung{s} in der Nähe',fire_brightest:'hellstes {k} K',
    fire_show_all:'Alle {n} anzeigen ▾',fire_show_less:'Weniger anzeigen ▴',
    detection_label:'Erkennung #{n}',detected_ago:'Erkannt',confidence_label:'Konfidenz',
    advice_waiting:'Warte auf aktuelle Bedingungen…',
    advice_right_now:'Jetzt gerade',advice_always:'Immer',advice_resources:'Ressourcen',
    advice_air_good:'Luftqualität ist gut — Outdoor-Aktivitäten sind unbedenklich.',
    advice_windows:'Halten Sie heute Fenster und Türen geschlossen.',
    advice_n95_outdoor:'Tragen Sie eine N95-Maske, wenn Sie längere Zeit im Freien arbeiten.',
    advice_inhaler:'Haben Sie Ihren Notfall-Inhalator bei sich, nicht nur in der Nähe.',
    advice_indoors:'Bleiben Sie drinnen und betreiben Sie einen Luftreiniger oder die Klimaanlage im Umluftmodus.',
    advice_heat_good:'Die Temperaturen sind angenehm — keine Hitzevorsichtsmaßnahmen nötig.',
    advice_exercise:'Verlegen Sie Sport nach drinnen — meiden Sie anstrengende Outdoor-Aktivitäten.',
    advice_hydrate:'Trinken Sie ausreichend und machen Sie Pausen im Schatten.',
    advice_peak_heat:'Meiden Sie Outdoor-Aktivitäten in der heißesten Tageszeit (12–16 Uhr).',
    advice_shade_breaks:'Machen Sie alle 20 Minuten eine Schattenpause und trinken Sie regelmäßig.',
    advice_check_neighbors:'Kümmern Sie sich um Nachbarn mit eingeschränkter Mobilität oder ohne Klimaanlage.',
    advice_fire_good:'Keine aktiven Feuer in der Nähe erkannt — ruhige Bedingungen.',
    advice_fire_aware:'Behalten Sie die Feueraktivität und Luftqualitätsveränderungen in der Nähe im Blick.',
    advice_evac_bag:'Halten Sie einen Evakuierungsrucksack bereit und verfolgen Sie offizielle Warnungen.',
    advice_evacuate_now:'Befolgen Sie alle offiziellen Evakuierungsanweisungen sofort — warten Sie nicht.',
    advice_wind:'Sichern Sie lose Gartenmöbel und Gegenstände — Wind kann Glut verbreiten.',
    standing_general_0:'Prüfen Sie lokale Waldbrandwarnungen vor Outdoor-Aktivitäten.',
    standing_general_1:'Halten Sie an rauchigen oder windigen Tagen die Fenster geschlossen.',
    standing_general_2:'Kennen Sie Ihre zwei nächsten Evakuierungsrouten.',
    standing_general_3:'Halten Sie mindestens 3 Tage Notvorräte zu Hause.',
    standing_asthma_0:'Halten Sie Ihren Notfall-Inhalator jederzeit griffbereit.',
    standing_asthma_1:'Überwachen Sie täglich den Luftqualitätsindex — die Atemwege reagieren früher als Sie es merken.',
    standing_asthma_2:'Verwenden Sie an rauchigen Tagen drinnen einen HEPA-Luftfilter.',
    standing_asthma_3:'Legen Sie einen schriftlichen Asthma-Aktionsplan an und teilen Sie ihn mit jemandem.',
    standing_elderly_0:'Trinken Sie ausreichend — das Durstgefühl nimmt mit dem Alter ab.',
    standing_elderly_1:'Halten Sie Medikamente für mindestens 2 Wochen vorrätig.',
    standing_elderly_2:'Ermitteln Sie einen kühlen Zufluchtsort (Bibliothek, Gemeinschaftszentrum) für den Notfall.',
    standing_elderly_3:'Stellen Sie sicher, dass sich täglich jemand nach Ihnen erkundigt.',
    standing_outdoor_0:'Prüfen Sie die Feuerwettervorhersage vor jeder Schicht.',
    standing_outdoor_1:'Führen Sie stets Wasser und eine Staubschutzmaske mit sich.',
    standing_outdoor_2:'Haben Sie einen Kommunikationsplan für Gebiete ohne Mobilfunkempfang.',
    standing_outdoor_3:'Kennen Sie den nächsten Feuerwehrstandort oder Notausgang.',
    incidents_loading:'Globale Vorfallsdaten werden geladen…',
    incidents_count:'{n} Waldbrand{s} weltweit in den letzten 30 Tagen verfolgt',
    incidents_none:'Keine globalen Waldbrände in den letzten 30 Tagen verfolgt',
    incidents_unavailable:'Globale Vorfallsdaten derzeit nicht verfügbar',
    incidents_error:'NASA EONET nicht erreichbar — bitte versuchen Sie es bald erneut.',
    incidents_active:'Aktiv',incidents_past:'Vergangen',incidents_show_map:'🌍 Auf Karte anzeigen',
    map_expand:'⤢ Vergrößern',map_your_location:'Ihr Standort',
    map_fire_low:'Feuer (gering)',map_fire_med:'Feuer (mittel)',map_fire_intense:'Feuer (intensiv)',
    map_click_spot:'Klicken Sie auf die Karte, um einen Punkt zu prüfen',global_fires_btn:'🔥 Globale Brände',
    w_temp:'Temp',w_wind:'Wind',w_humidity:'Luftfeuchte',w_rain:'Regen 7 Tage',
    ready_sub:'Notfallvorsorge-Checkliste',
    ready_gobag:'Notfallrucksack mit 3-Tage-Bedarf gepackt',
    ready_docs:'Wichtige Dokumente kopiert oder gesichert',
    ready_meds:'Medikamente (7-Tage-Vorrat)',
    ready_routes:'Evakuierungsrouten kennen',
    ready_alerts:'Für lokale Notfallwarnungen registriert',
    ready_masks:'N95-Masken gegen Rauch griffbereit',
    ready_battery:'Ladekabel und Powerbank für das Telefon',
    ready_pets:'Transportboxen und Zubehör für Haustiere bereit',
    ready_contacts_title:'Notfallkontakte',
    tips_before_tab:'Vorher',tips_during_tab:'Während',tips_after_tab:'Danach',
    tips_before_title:'Vor einem Waldbrand',
    tips_before_sub:'Was jetzt zu tun ist, bevor die Waldbrandsaison Sie unter Druck setzt.',
    tips_during_title:'Während eines Waldbrands',
    tips_during_sub:'Entscheidungen in Echtzeit, die Leben retten, wenn jede Minute zählt.',
    tips_after_title:'Nach einem Waldbrand',
    tips_after_sub:'Sichere Rückkehr und Erholungsschritte zum Schutz Ihrer Gesundheit.',
    report_sub:'Sehen Sie Rauch oder Flammen? Erstellen Sie einen teilbaren Bericht.',
    report_what_label:'Was haben Sie gesehen?',
    report_smoke:'Rauchsäule oder Dunst',report_flame:'Aktive Flammen sichtbar',
    report_glow:'Ungewöhnliches orangefarbenes Leuchten nachts',report_other:'Andere ungewöhnliche Aktivität',
    report_notes_label:'Notizen (optional)',
    report_notes_placeholder:'Richtung, Entfernungsschätzung, Windbedingungen…',
    report_generate_btn:'Bericht erstellen',report_copy_btn:'📋 Kopieren',report_to:'Melden an:',
    heat_cat_4_label:'Extreme Gefahr',heat_cat_4_desc:'Hitzschlag ist wahrscheinlich — meiden Sie den Außenbereich vollständig.',
    heat_cat_3_label:'Gefahr',heat_cat_3_desc:'Hohes Risiko für hitzebedingte Erkrankungen — vermeiden Sie anstrengende Außenaktivitäten.',
    heat_cat_2_label:'Äußerste Vorsicht',heat_cat_2_desc:'Vorsicht — trinken Sie viel und machen Sie Pausen im Schatten.',
    heat_cat_1_label:'Vorsicht',heat_cat_1_desc:'Ermüdung ist bei längerem Aufenthalt oder Aktivität möglich.',
    heat_cat_0_label:'Angenehm',heat_cat_0_desc:'Hitze ist derzeit kein wesentliches Problem.',
    heat_source:'Tatsächlich {temp} · Luftfeuchtigkeit {hum}% · Quelle: Open-Meteo',
    aqi_us_0_label:'GUT',aqi_us_0_short:'Gut',aqi_us_0_desc:'Die Luftqualität ist zufriedenstellend.',
    aqi_us_1_label:'MÄSSIG',aqi_us_1_short:'Mäßig',aqi_us_1_desc:'Akzeptabel, aber ein Problem für besonders empfindliche Personen.',
    aqi_us_2_label:'UNGESUND (EMPFINDLICH)',aqi_us_2_short:'Empfindlich',aqi_us_2_desc:'Empfindliche Gruppen können Gesundheitsauswirkungen erfahren.',
    aqi_us_3_label:'UNGESUND',aqi_us_3_short:'Ungesund',aqi_us_3_desc:'Alle können beginnen, Gesundheitsauswirkungen zu spüren.',
    aqi_us_4_label:'SEHR UNGESUND',aqi_us_4_short:'Sehr ungesund',aqi_us_4_desc:'Gesundheitswarnung — ernsthafte Auswirkungen für alle möglich.',
    aqi_us_5_label:'GEFÄHRLICH',aqi_us_5_short:'Gefährlich',aqi_us_5_desc:'Notfallbedingungen — gesamte Bevölkerung gefährdet.',
    aqi_owm_1_label:'GUT',aqi_owm_1_short:'Gut',aqi_owm_1_desc:'Die Luftqualität ist gut.',
    aqi_owm_2_label:'FAIR',aqi_owm_2_short:'Fair',aqi_owm_2_desc:'Die Luftqualität ist akzeptabel.',
    aqi_owm_3_label:'MÄSSIG',aqi_owm_3_short:'Mäßig',aqi_owm_3_desc:'Empfindliche Gruppen können Auswirkungen bemerken.',
    aqi_owm_4_label:'SCHLECHT',aqi_owm_4_short:'Schlecht',aqi_owm_4_desc:'Gesundheitliche Auswirkungen können bei den meisten Menschen auftreten.',
    aqi_owm_5_label:'SEHR SCHLECHT',aqi_owm_5_short:'Sehr schlecht',aqi_owm_5_desc:'Gesundheitswarnung wegen Notfallbedingungen.',
    aqi_loading:'Luftqualitätsdaten werden geladen…',
    aqi_unavailable:'Luftqualitätsdaten derzeit nicht verfügbar.',
    aqi_foot_cams:'Dominanter Schadstoff: PM2.5 · Quelle: Open-Meteo (CAMS)',
    aqi_foot_owm:'Dominanter Schadstoff: PM2.5 · Quelle: OpenWeatherMap (Skala 1–5)',
    aqi_foot_unavail:'Quelle: nicht verfügbar',
    aqi_scale_note:'US EPA AQI · aktuell {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · Daten nicht verfügbar',
    aqi_pm25:' PM2.5 beträgt {val} µg/m³.',
    loc_no_geo:'Dieser Browser unterstützt keine Standortdienste.',
    loc_err_denied:'Standortberechtigung wurde verweigert. Bitte erlauben Sie den Standortzugriff.',
    loc_err_unavail:'Wir konnten Ihren Standort nicht ermitteln. Überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    loc_err_timeout:'Die Standortanfrage ist abgelaufen. Versuchen Sie es erneut.',
    loc_err_default:'Beim Abrufen Ihres Standorts ist etwas schiefgelaufen.',
    map_close:'✕ Schließen',
  },
  zh:{
    risk_intelligence:'风险情报',satellite_title:'卫星火灾分析',
    nearby_title:'附近火灾',map_title:'地图',advice_title:'我该怎么做？',
    air_scale_title:'空气质量指数',incidents_title:'全球野火事件',
    forecast_title:'5日火险天气预报',weather_title:'天气',be_ready_title:'做好准备',
    survival_title:'野火求生指南',
    report_eyebrow:'帮助您的社区',report_title:'举报火情目击',
    profile_general:'一般',profile_asthma:'哮喘',profile_elderly:'老年人',profile_outdoor:'户外工作者',
    sort_distance:'距离',sort_size:'规模',
    loading_msg:'等待位置权限…',
    error_msg_default:'需要您的位置来评估野火风险。',
    try_again:'重试',locating:'定位中…',
    save_btn:'🔖 保存',saved_btn:'✓ 已保存',share_btn:'↗ 分享',my_location_btn:'📡 我的位置',
    search_placeholder:'搜索城市或地点…',
    fire_card_label:'🔥 野火',air_card_label:'🌫️ 空气质量',heat_card_label:'🌡️ 高温',
    fire_detail_hint:'点击查看FWI详情 ▾',air_detail_hint:'点击切换数据源 ▾',
    hero_checking:'正在检查当前状况…',
    hero_sub:'总体等级是三项风险中最差的。',
    hero_good:'条件良好 — 可以享受户外活动。',
    hero_elevated:'{label}今天有所升高 — 保持警惕。',
    hero_unhealthy:'{label}今天不健康 — 减少户外时间。',
    hero_dangerous:'{label}处于危险水平 — 避免户外暴露。',
    status_good:'良好',status_moderate:'中等',status_unhealthy:'不健康',status_severe:'严重',
    sat_gathering:'正在收集卫星过境数据…',
    sat_clear:'附近未检测到卫星火灾活动',
    sat_stable_1:'检测到{n}个火群 — 过境间活动水平稳定',
    sat_stable_pl:'检测到{n}个火群 — 过境间活动水平稳定',
    sat_intensifying_1:'检测到{n}个火群 — 卫星过境间正在增强',
    sat_intensifying_pl:'检测到{n}个火群 — 卫星过境间正在增强',
    sat_weakening_1:'检测到{n}个火群 — 过境间活动减弱',
    sat_weakening_pl:'检测到{n}个火群 — 过境间活动减弱',
    sat_unavailable:'卫星分析目前不可用',sat_first_pass:'首次过境',
    fire_no_detection:'附近未检测到活跃火灾。请关注当地状况。',
    fire_no_detection_list:'过去24小时内~65km范围内无火灾探测。',
    fire_close:'附近有活跃火灾。保持警惕并遵循当地疏散指引。',
    fire_moderate:'最近的活跃火灾在中等距离处。保持关注。',
    fire_far:'最近的火灾探测在安全距离处。',
    fire_source:'数据来源：NASA FIRMS',
    fire_detections:'附近{n}个探测点',fire_brightest:'最亮 {k} K',
    fire_show_all:'显示全部{n}个 ▾',fire_show_less:'显示更少 ▴',
    detection_label:'探测点 #{n}',detected_ago:'已探测',confidence_label:'置信度',
    advice_waiting:'等待当前状况数据…',
    advice_right_now:'当前',advice_always:'始终',advice_resources:'资源',
    advice_air_good:'空气质量良好 — 适合户外活动。',
    advice_windows:'今天保持门窗关闭。',
    advice_n95_outdoor:'如需长时间户外工作，请佩戴N95口罩。',
    advice_inhaler:'随身携带急救吸入器，不仅仅放在附近。',
    advice_indoors:'留在室内，使用空气净化器或空调内循环模式。',
    advice_heat_good:'温度舒适 — 无需采取防暑措施。',
    advice_exercise:'将运动转移到室内 — 避免剧烈户外活动。',
    advice_hydrate:'保持水分补充，在阴凉处休息。',
    advice_peak_heat:'避免在最热时段（12–16时）进行户外活动。',
    advice_shade_breaks:'每20分钟在阴凉处休息，并定期补水。',
    advice_check_neighbors:'关注行动不便或无空调的邻居。',
    advice_fire_good:'附近未检测到活跃火灾 — 状况平静。',
    advice_fire_aware:'关注附近火灾活动及空气质量突变。',
    advice_evac_bag:'备好疏散包并密切关注官方火灾预警。',
    advice_evacuate_now:'立即执行所有官方疏散命令 — 不要等待。',
    advice_wind:'固定户外松散家具和物品 — 风可能传播火星。',
    standing_general_0:'户外活动前检查当地消防部门预警。',
    standing_general_1:'烟雾或大风天气保持窗户关闭。',
    standing_general_2:'了解最近的两条疏散路线。',
    standing_general_3:'家中备有至少3天的应急物资。',
    standing_asthma_0:'随时保持急救吸入器可触及。',
    standing_asthma_1:'每日监测AQI — 呼吸道反应早于自我感知。',
    standing_asthma_2:'烟雾天在室内使用HEPA空气过滤器。',
    standing_asthma_3:'制定书面哮喘行动计划并与身边人分享。',
    standing_elderly_0:'保持水分补充 — 年龄增长会削弱渴感。',
    standing_elderly_1:'至少备用2周药品存量。',
    standing_elderly_2:'确定凉爽避难所（图书馆、社区中心）以备空调故障。',
    standing_elderly_3:'高风险期间确保每天有人探望。',
    standing_outdoor_0:'每班开始前检查火险天气预报。',
    standing_outdoor_1:'每次工作时携带水和防尘口罩。',
    standing_outdoor_2:'制定无信号地区的通讯计划。',
    standing_outdoor_3:'了解最近消防站或紧急出口的位置。',
    incidents_loading:'正在加载全球事件数据…',
    incidents_count:'过去30天全球共追踪到{n}起野火事件',
    incidents_none:'过去30天内无全球野火事件记录',
    incidents_unavailable:'全球事件数据目前不可用',
    incidents_error:'无法连接NASA EONET — 请稍后重试。',
    incidents_active:'活跃',incidents_past:'历史',incidents_show_map:'🌍 在地图上显示',
    map_expand:'⤢ 展开',map_your_location:'您的位置',
    map_fire_low:'火灾（低）',map_fire_med:'火灾（中）',map_fire_intense:'火灾（强）',
    map_click_spot:'点击地图检查某点',global_fires_btn:'🔥 全球火灾',
    w_temp:'温度',w_wind:'风速',w_humidity:'湿度',w_rain:'7日降水',
    ready_sub:'应急准备清单',
    ready_gobag:'备好3天物资的应急包',
    ready_docs:'重要文件已复印或备份',
    ready_meds:'药品（7天用量）',
    ready_routes:'了解疏散路线',
    ready_alerts:'已注册当地紧急警报',
    ready_masks:'备好N95口罩防烟雾',
    ready_battery:'手机充电器和备用电源',
    ready_pets:'宠物笼和用品已准备好',
    ready_contacts_title:'紧急联系人',
    tips_before_tab:'事前',tips_during_tab:'事中',tips_after_tab:'事后',
    tips_before_title:'火灾前',
    tips_before_sub:'现在就行动，在火灾季节施压之前做好准备。',
    tips_during_title:'火灾中',
    tips_during_sub:'火灾迫近或发生时的实时决策。',
    tips_after_title:'火灾后',
    tips_after_sub:'安全返回和恢复步骤以保护您的健康。',
    report_sub:'看到烟雾或火焰？生成可分享的报告并快速联系当局。',
    report_what_label:'您看到了什么？',
    report_smoke:'烟柱或烟雾',report_flame:'可见活跃火焰',
    report_glow:'夜间异常橙色光晕',report_other:'其他异常活动',
    report_notes_label:'备注（可选）',
    report_notes_placeholder:'方向、距离估计、风况…',
    report_generate_btn:'生成报告',report_copy_btn:'📋 复制',report_to:'报告给：',
    heat_cat_4_label:'极端危险',heat_cat_4_desc:'极可能中暑 — 完全避免户外暴露。',
    heat_cat_3_label:'危险',heat_cat_3_desc:'高度中暑风险 — 避免剧烈户外活动。',
    heat_cat_2_label:'极度谨慎',heat_cat_2_desc:'谨慎 — 多补水并在阴凉处休息。',
    heat_cat_1_label:'谨慎',heat_cat_1_desc:'长时间暴露或活动可能导致疲劳。',
    heat_cat_0_label:'舒适',heat_cat_0_desc:'目前热度不是主要问题。',
    heat_source:'实际 {temp} · 湿度 {hum}% · 来源：Open-Meteo',
    aqi_us_0_label:'优',aqi_us_0_short:'优',aqi_us_0_desc:'空气质量令人满意。',
    aqi_us_1_label:'良',aqi_us_1_short:'良',aqi_us_1_desc:'可接受，但对特别敏感人群有影响。',
    aqi_us_2_label:'轻度污染（敏感群体）',aqi_us_2_short:'敏感',aqi_us_2_desc:'敏感群体可能出现健康问题。',
    aqi_us_3_label:'中度污染',aqi_us_3_short:'中度',aqi_us_3_desc:'所有人可能开始出现健康影响。',
    aqi_us_4_label:'重度污染',aqi_us_4_short:'重度',aqi_us_4_desc:'健康警报 — 所有人可能出现严重影响。',
    aqi_us_5_label:'严重污染',aqi_us_5_short:'严重',aqi_us_5_desc:'紧急状态 — 全体人口面临风险。',
    aqi_owm_1_label:'优',aqi_owm_1_short:'优',aqi_owm_1_desc:'空气质量良好。',
    aqi_owm_2_label:'良',aqi_owm_2_short:'良',aqi_owm_2_desc:'空气质量可接受。',
    aqi_owm_3_label:'一般',aqi_owm_3_short:'一般',aqi_owm_3_desc:'敏感群体可能有所影响。',
    aqi_owm_4_label:'差',aqi_owm_4_short:'差',aqi_owm_4_desc:'大多数人可能感受到健康影响。',
    aqi_owm_5_label:'极差',aqi_owm_5_short:'极差',aqi_owm_5_desc:'紧急健康警报。',
    aqi_loading:'正在加载空气质量数据…',
    aqi_unavailable:'空气质量数据暂时不可用。',
    aqi_foot_cams:'主要污染物：PM2.5 · 来源：Open-Meteo (CAMS)',
    aqi_foot_owm:'主要污染物：PM2.5 · 来源：OpenWeatherMap（1–5级）',
    aqi_foot_unavail:'来源：不可用',
    aqi_scale_note:'美国EPA AQI · 当前 {aqi} ({short})',
    aqi_scale_unavail:'美国EPA AQI · 数据不可用',
    aqi_pm25:' PM2.5为 {val} µg/m³。',
    loc_no_geo:'此浏览器不支持位置服务。',
    loc_err_denied:'位置权限被拒绝。请允许访问位置以查看您的野火风险。',
    loc_err_unavail:'无法确定您的位置。请检查网络连接后重试。',
    loc_err_timeout:'位置请求超时。请重试。',
    loc_err_default:'获取位置时出现错误。',
    map_close:'✕ 关闭',
  },
  pt:{
    risk_intelligence:'Inteligência de Risco',satellite_title:'Análise Satelital de Incêndios',
    nearby_title:'Incêndios Próximos',map_title:'Mapa',advice_title:'O que devo fazer?',
    air_scale_title:'Escala de Qualidade do Ar',incidents_title:'Incêndios Florestais Globais',
    forecast_title:'Previsão de Risco de Incêndio (5 dias)',weather_title:'Clima',be_ready_title:'Esteja Pronto',
    survival_title:'GUIA DE SOBREVIVÊNCIA A INCÊNDIOS',
    report_eyebrow:'AJUDE SUA COMUNIDADE',report_title:'Reportar um Avistamento',
    profile_general:'Geral',profile_asthma:'Asma',profile_elderly:'Idosos',profile_outdoor:'Trabalhador ao ar livre',
    sort_distance:'Distância',sort_size:'Tamanho',
    loading_msg:'Aguardando permissão de localização…',
    error_msg_default:'Precisamos da sua localização para avaliar o risco de incêndio.',
    try_again:'Tentar novamente',locating:'Localizando…',
    save_btn:'🔖 Salvar',saved_btn:'✓ Salvo',share_btn:'↗ Compartilhar',my_location_btn:'📡 Minha localização',
    search_placeholder:'Buscar cidade ou local…',
    fire_card_label:'🔥 Incêndio Florestal',air_card_label:'🌫️ Qualidade do Ar',heat_card_label:'🌡️ Calor',
    fire_detail_hint:'Toque para detalhes FWI ▾',air_detail_hint:'Toque para mudar a fonte ▾',
    hero_checking:'Verificando condições atuais…',
    hero_sub:'O nível geral é o pior dos seus três riscos abaixo.',
    hero_good:'As condições estão boas — aproveite o ar livre.',
    hero_elevated:'{label} está elevado hoje — fique atento.',
    hero_unhealthy:'{label} está prejudicial hoje — limite o tempo ao ar livre.',
    hero_dangerous:'{label} está em níveis perigosos — evite exposição ao ar livre.',
    status_good:'BOM',status_moderate:'MODERADO',status_unhealthy:'PREJUDICIAL',status_severe:'GRAVE',
    sat_gathering:'Coletando passagens de satélite…',
    sat_clear:'Nenhuma atividade de incêndio detectada por satélite próxima',
    sat_stable_1:'{n} foco de incêndio detectado — atividade estável entre passagens',
    sat_stable_pl:'{n} focos de incêndio detectados — atividade estável entre passagens',
    sat_intensifying_1:'{n} foco detectado — intensificando entre passagens de satélite',
    sat_intensifying_pl:'{n} focos detectados — intensificando entre passagens de satélite',
    sat_weakening_1:'{n} foco detectado — atividade diminuindo entre passagens',
    sat_weakening_pl:'{n} focos detectados — atividade diminuindo entre passagens',
    sat_unavailable:'Análise de satélite indisponível no momento',sat_first_pass:'Primeira passagem',
    fire_no_detection:'Nenhum incêndio ativo detectado próximo. Fique atento às condições locais.',
    fire_no_detection_list:'Nenhuma detecção de incêndio em ~65km nas últimas 24h.',
    fire_close:'Há um incêndio ativo próximo. Fique alerta e siga as orientações de evacuação.',
    fire_moderate:'O incêndio ativo mais próximo está a distância moderada. Fique atento.',
    fire_far:'A detecção de incêndio mais próxima está a distância segura.',
    fire_source:'Fonte: NASA FIRMS',
    fire_detections:'{n} detecção{s} próxima{s}',fire_brightest:'mais brilhante {k} K',
    fire_show_all:'Mostrar todos {n} ▾',fire_show_less:'Mostrar menos ▴',
    detection_label:'Detecção #{n}',detected_ago:'Detectado',confidence_label:'confiança',
    advice_waiting:'Aguardando condições atuais…',
    advice_right_now:'Agora',advice_always:'Sempre',advice_resources:'Recursos',
    advice_air_good:'A qualidade do ar está boa — atividades ao ar livre sem restrições.',
    advice_windows:'Mantenha janelas e portas fechadas hoje.',
    advice_n95_outdoor:'Use máscara N95 se trabalhar ao ar livre por períodos prolongados.',
    advice_inhaler:'Tenha seu inalador de resgate com você, não apenas por perto.',
    advice_indoors:'Fique em ambiente fechado e use purificador de ar ou ar condicionado em recirculação.',
    advice_heat_good:'As temperaturas estão confortáveis — não há necessidade de precauções de calor.',
    advice_exercise:'Faça exercícios em ambiente fechado — evite atividade física intensa ao ar livre.',
    advice_hydrate:'Mantenha-se hidratado e descanse na sombra.',
    advice_peak_heat:'Evite atividade ao ar livre nos horários de maior calor (12–16h).',
    advice_shade_breaks:'Faça pausas na sombra a cada 20 min e beba água frequentemente.',
    advice_check_neighbors:'Verifique vizinhos com mobilidade reduzida ou sem ar condicionado.',
    advice_fire_good:'Nenhum incêndio ativo detectado próximo — condições calmas.',
    advice_fire_aware:'Fique atento à atividade de incêndios e mudanças na qualidade do ar.',
    advice_evac_bag:'Tenha uma mochila de evacuação pronta e acompanhe os alertas oficiais.',
    advice_evacuate_now:'Siga todas as ordens de evacuação imediatamente — não espere.',
    advice_wind:'Fixe móveis e objetos soltos ao ar livre — o vento pode espalhar brasas.',
    standing_general_0:'Consulte alertas da autoridade de incêndios antes de atividades ao ar livre.',
    standing_general_1:'Mantenha janelas fechadas em dias com fumaça ou vento forte.',
    standing_general_2:'Conheça suas duas rotas de evacuação mais próximas.',
    standing_general_3:'Mantenha pelo menos 3 dias de suprimentos de emergência em casa.',
    standing_asthma_0:'Mantenha o inalador de resgate acessível em todos os momentos.',
    standing_asthma_1:'Monitore o IQA diariamente — as vias respiratórias reagem antes que você sinta.',
    standing_asthma_2:'Use um filtro de ar HEPA em ambientes fechados em dias com fumaça.',
    standing_asthma_3:'Tenha um plano de ação para asma por escrito e compartilhe com alguém próximo.',
    standing_elderly_0:'Mantenha-se hidratado — a resposta à sede diminui com a idade.',
    standing_elderly_1:'Mantenha medicamentos estocados por pelo menos 2 semanas.',
    standing_elderly_2:'Identifique um refúgio fresco (biblioteca, centro comunitário) se o ar condicionado falhar.',
    standing_elderly_3:'Garanta que alguém verifique seu bem-estar diariamente em períodos de alto risco.',
    standing_outdoor_0:'Verifique a previsão de clima de incêndio antes de cada turno.',
    standing_outdoor_1:'Leve água e máscara antipoeira em cada trabalho.',
    standing_outdoor_2:'Tenha um plano de comunicação para áreas sem sinal de celular.',
    standing_outdoor_3:'Conheça o bombeiro ou saída de emergência mais próxima.',
    incidents_loading:'Carregando dados de incidentes globais…',
    incidents_count:'{n} incêndio{s} florestal{s} rastreado{s} mundialmente nos últimos 30 dias',
    incidents_none:'Nenhum incêndio florestal global rastreado nos últimos 30 dias',
    incidents_unavailable:'Dados de incidentes globais indisponíveis no momento',
    incidents_error:'Não foi possível acessar a NASA EONET — tente novamente em breve.',
    incidents_active:'Ativo',incidents_past:'Passado',incidents_show_map:'🌍 Mostrar no mapa',
    map_expand:'⤢ Expandir',map_your_location:'Sua localização',
    map_fire_low:'Fogo (baixo)',map_fire_med:'Fogo (médio)',map_fire_intense:'Fogo (intenso)',
    map_click_spot:'Clique no mapa para verificar um ponto',global_fires_btn:'🔥 Incêndios globais',
    w_temp:'Temp',w_wind:'Vento',w_humidity:'Umidade',w_rain:'Chuva 7 dias',
    ready_sub:'Lista de verificação de preparação para emergências',
    ready_gobag:'Mochila com suprimentos para 3 dias preparada',
    ready_docs:'Documentos importantes copiados ou com backup',
    ready_meds:'Medicamentos (7 dias de fornecimento)',
    ready_routes:'Conhecer as rotas de evacuação',
    ready_alerts:'Cadastrado em alertas de emergência locais',
    ready_masks:'Máscaras N95 disponíveis para fumaça',
    ready_battery:'Carregador e bateria reserva para celular',
    ready_pets:'Transportadores e suprimentos para animais prontos',
    ready_contacts_title:'Contatos de Emergência',
    tips_before_tab:'Antes',tips_during_tab:'Durante',tips_after_tab:'Depois',
    tips_before_title:'Antes de um Incêndio',
    tips_before_sub:'O que fazer agora, antes que a temporada de incêndios pressione.',
    tips_during_title:'Durante um Incêndio',
    tips_during_sub:'Decisões em tempo real que salvam vidas quando cada minuto conta.',
    tips_after_title:'Depois de um Incêndio',
    tips_after_sub:'Retorno seguro e etapas de recuperação para proteger sua saúde.',
    report_sub:'Viu fumaça ou chamas? Gere um relatório compartilhável e contate as autoridades.',
    report_what_label:'O que você viu?',
    report_smoke:'Coluna de fumaça ou névoa',report_flame:'Chamas ativas visíveis',
    report_glow:'Brilho laranja incomum à noite',report_other:'Outra atividade incomum',
    report_notes_label:'Notas (opcional)',
    report_notes_placeholder:'Direção, estimativa de distância, condições de vento…',
    report_generate_btn:'Gerar Relatório',report_copy_btn:'📋 Copiar',report_to:'Reportar para:',
    heat_cat_4_label:'Perigo Extremo',heat_cat_4_desc:'Insolação é provável — evite qualquer exposição ao exterior.',
    heat_cat_3_label:'Perigo',heat_cat_3_desc:'Alto risco de doenças relacionadas ao calor — evite atividades físicas intensas ao ar livre.',
    heat_cat_2_label:'Extrema Cautela',heat_cat_2_desc:'Cautela — hidrate-se e faça pausas à sombra.',
    heat_cat_1_label:'Cautela',heat_cat_1_desc:'A fadiga é possível com exposição prolongada ou atividade intensa.',
    heat_cat_0_label:'Confortável',heat_cat_0_desc:'O calor não é uma preocupação significativa no momento.',
    heat_source:'Real {temp} · umidade {hum}% · fonte: Open-Meteo',
    aqi_us_0_label:'BOM',aqi_us_0_short:'Bom',aqi_us_0_desc:'A qualidade do ar é satisfatória.',
    aqi_us_1_label:'MODERADO',aqi_us_1_short:'Moderado',aqi_us_1_desc:'Aceitável, mas preocupante para pessoas incomumente sensíveis.',
    aqi_us_2_label:'PREJUDICIAL (SENSÍVEIS)',aqi_us_2_short:'Sensível',aqi_us_2_desc:'Grupos sensíveis podem sofrer efeitos à saúde.',
    aqi_us_3_label:'PREJUDICIAL',aqi_us_3_short:'Prejudicial',aqi_us_3_desc:'Todos podem começar a sentir efeitos à saúde.',
    aqi_us_4_label:'MUITO PREJUDICIAL',aqi_us_4_short:'Muito prejudicial',aqi_us_4_desc:'Alerta de saúde — efeitos graves possíveis para todos.',
    aqi_us_5_label:'PERIGOSO',aqi_us_5_short:'Perigoso',aqi_us_5_desc:'Condições de emergência — toda a população em risco.',
    aqi_owm_1_label:'BOM',aqi_owm_1_short:'Bom',aqi_owm_1_desc:'A qualidade do ar é boa.',
    aqi_owm_2_label:'RAZOÁVEL',aqi_owm_2_short:'Razoável',aqi_owm_2_desc:'A qualidade do ar é aceitável.',
    aqi_owm_3_label:'MODERADO',aqi_owm_3_short:'Moderado',aqi_owm_3_desc:'Grupos sensíveis podem notar efeitos.',
    aqi_owm_4_label:'RUIM',aqi_owm_4_short:'Ruim',aqi_owm_4_desc:'A maioria das pessoas pode sentir efeitos à saúde.',
    aqi_owm_5_label:'MUITO RUIM',aqi_owm_5_short:'Muito ruim',aqi_owm_5_desc:'Alerta de saúde em condições de emergência.',
    aqi_loading:'Carregando dados de qualidade do ar…',
    aqi_unavailable:'Dados de qualidade do ar não disponíveis.',
    aqi_foot_cams:'Poluente dominante: PM2.5 · fonte: Open-Meteo (CAMS)',
    aqi_foot_owm:'Poluente dominante: PM2.5 · fonte: OpenWeatherMap (escala 1–5)',
    aqi_foot_unavail:'Fonte: indisponível',
    aqi_scale_note:'US EPA AQI · atualmente {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · dados indisponíveis',
    aqi_pm25:' PM2.5 é {val} µg/m³.',
    loc_no_geo:'Este navegador não suporta serviços de localização.',
    loc_err_denied:'Permissão de localização negada. Permita o acesso à localização para ver seu risco de incêndio.',
    loc_err_unavail:'Não conseguimos determinar sua posição. Verifique sua conexão e tente novamente.',
    loc_err_timeout:'A solicitação de localização expirou. Tente novamente.',
    loc_err_default:'Algo deu errado ao obter sua localização.',
    map_close:'✕ Fechar',
  },
  ja:{
    risk_intelligence:'リスク情報',satellite_title:'衛星火災解析',
    nearby_title:'近隣の火災',map_title:'地図',advice_title:'どうすべきか？',
    air_scale_title:'大気質スケール',incidents_title:'世界の山火事情報',
    forecast_title:'5日間の火災気象予報',weather_title:'天気',be_ready_title:'備える',
    survival_title:'山火事サバイバルガイド',
    report_eyebrow:'地域を助ける',report_title:'火災目撃を報告',
    profile_general:'一般',profile_asthma:'喘息',profile_elderly:'高齢者',profile_outdoor:'屋外作業者',
    sort_distance:'距離',sort_size:'規模',
    loading_msg:'位置情報の許可を待っています…',
    error_msg_default:'山火事リスクを評価するために位置情報が必要です。',
    try_again:'再試行',locating:'位置特定中…',
    save_btn:'🔖 保存',saved_btn:'✓ 保存済み',share_btn:'↗ 共有',my_location_btn:'📡 現在地',
    search_placeholder:'都市や場所を検索…',
    fire_card_label:'🔥 山火事',air_card_label:'🌫️ 大気質',heat_card_label:'🌡️ 熱中症',
    fire_detail_hint:'FWI詳細を表示 ▾',air_detail_hint:'データソースを変更 ▾',
    hero_checking:'現在の状況を確認中…',
    hero_sub:'総合レベルは下記3つのリスクの中で最悪のものです。',
    hero_good:'状況は良好です — アウトドアをお楽しみください。',
    hero_elevated:'{label}は本日上昇しています — 注意してください。',
    hero_unhealthy:'{label}は本日不健康なレベルです — 屋外活動を制限してください。',
    hero_dangerous:'{label}は危険なレベルです — 屋外への暴露を避けてください。',
    status_good:'良好',status_moderate:'中程度',status_unhealthy:'不健康',status_severe:'深刻',
    sat_gathering:'衛星データを収集中…',
    sat_clear:'近隣で衛星検知された火災活動なし',
    sat_stable_1:'{n}つの火災クラスター検出 — パス間で活動は安定',
    sat_stable_pl:'{n}つの火災クラスター検出 — パス間で活動は安定',
    sat_intensifying_1:'{n}つの火災クラスター検出 — 衛星パス間で強化中',
    sat_intensifying_pl:'{n}つの火災クラスター検出 — 衛星パス間で強化中',
    sat_weakening_1:'{n}つの火災クラスター検出 — パス間で活動が低下',
    sat_weakening_pl:'{n}つの火災クラスター検出 — パス間で活動が低下',
    sat_unavailable:'衛星解析は現在利用できません',sat_first_pass:'初回パス',
    fire_no_detection:'近隣で活動中の火災は検出されていません。地域の状況に注意してください。',
    fire_no_detection_list:'過去24時間以内に~65km以内での火災検出なし。',
    fire_close:'近くで活動中の火災があります。警戒を怠らず、地域の避難指示に従ってください。',
    fire_moderate:'最寄りの活動中の火災は適度な距離にあります。引き続き注意してください。',
    fire_far:'最寄りの火災検出は安全な距離にあります。',
    fire_source:'出典：NASA FIRMS',
    fire_detections:'近隣{n}件の検出',fire_brightest:'最も明るい {k} K',
    fire_show_all:'全{n}件を表示 ▾',fire_show_less:'表示を減らす ▴',
    detection_label:'検出 #{n}',detected_ago:'検出',confidence_label:'信頼度',
    advice_waiting:'現在の状況データを待っています…',
    advice_right_now:'今すぐ',advice_always:'常に',advice_resources:'リソース',
    advice_air_good:'大気質は良好です — 屋外活動に適しています。',
    advice_windows:'本日は窓とドアを閉めておいてください。',
    advice_n95_outdoor:'長時間屋外で作業する場合はN95マスクを着用してください。',
    advice_inhaler:'救急用吸入器は近くに置くだけでなく、常に携帯してください。',
    advice_indoors:'室内に留まり、空気清浄機またはエアコンの内部循環モードを使用してください。',
    advice_heat_good:'気温は快適です — 熱中症対策は不要です。',
    advice_exercise:'運動は室内に移してください — 屋外での激しい活動を避けてください。',
    advice_hydrate:'水分補給をして、日陰で休憩を取ってください。',
    advice_peak_heat:'最も暑い時間帯（12〜16時）の屋外活動を避けてください。',
    advice_shade_breaks:'20分ごとに日陰で休憩し、定期的に水分を補給してください。',
    advice_check_neighbors:'移動が困難な方やエアコンのない隣人を気にかけてください。',
    advice_fire_good:'近隣で活動中の火災は検出されていません — 状況は落ち着いています。',
    advice_fire_aware:'近隣の火災活動と大気質の急変に注意してください。',
    advice_evac_bag:'避難バッグを準備し、公式の火災警報を注視してください。',
    advice_evacuate_now:'公式の避難命令にただちに従ってください — 待たないでください。',
    advice_wind:'屋外の家具や物をしっかり固定してください — 風が火の粉を広げる恐れがあります。',
    standing_general_0:'屋外活動前に地域の消防警報を確認してください。',
    standing_general_1:'煙や強風の日は窓を閉めておいてください。',
    standing_general_2:'最寄りの2つの避難経路を把握してください。',
    standing_general_3:'少なくとも3日分の緊急物資を自宅に備えておいてください。',
    standing_asthma_0:'救急用吸入器を常に手の届く場所に置いておいてください。',
    standing_asthma_1:'AQIを毎日確認してください — 気道は感じる前に反応します。',
    standing_asthma_2:'煙の多い日は室内でHEPAエアフィルターを使用してください。',
    standing_asthma_3:'喘息行動計画を書面で作成し、近くにいる人と共有してください。',
    standing_elderly_0:'水分補給を怠らないでください — 加齢とともに口渇感が弱まります。',
    standing_elderly_1:'少なくとも2週間分の薬を備蓄しておいてください。',
    standing_elderly_2:'エアコンが故障した場合の涼しい避難場所（図書館、コミュニティセンター）を確認しておいてください。',
    standing_elderly_3:'高リスク期間中は毎日誰かが様子を確認するようにしてください。',
    standing_outdoor_0:'各シフト開始前に火災気象予報を確認してください。',
    standing_outdoor_1:'毎回の作業に水と防塵マスクを携帯してください。',
    standing_outdoor_2:'圏外エリア用の通信計画を持ってください。',
    standing_outdoor_3:'最寄りの消防署または非常口の場所を把握してください。',
    incidents_loading:'グローバルインシデントデータを読み込み中…',
    incidents_count:'過去30日間に世界で{n}件の山火事が追跡されました',
    incidents_none:'過去30日間に追跡されたグローバルな山火事はありません',
    incidents_unavailable:'グローバルインシデントデータは現在利用できません',
    incidents_error:'NASA EONETに接続できません — しばらくしてから再試行してください。',
    incidents_active:'活動中',incidents_past:'過去',incidents_show_map:'🌍 地図で表示',
    map_expand:'⤢ 拡大',map_your_location:'現在地',
    map_fire_low:'火災（低）',map_fire_med:'火災（中）',map_fire_intense:'火災（強）',
    map_click_spot:'地図をクリックして地点を確認',global_fires_btn:'🔥 世界の火災',
    w_temp:'気温',w_wind:'風速',w_humidity:'湿度',w_rain:'7日間降水量',
    ready_sub:'緊急事態への備えチェックリスト',
    ready_gobag:'3日分の物資が入った避難袋の準備',
    ready_docs:'重要書類のコピーまたはバックアップ',
    ready_meds:'薬（7日分）',
    ready_routes:'避難経路の把握',
    ready_alerts:'地域の緊急警報への登録',
    ready_masks:'煙対策のN95マスクを手元に',
    ready_battery:'スマートフォン充電器とモバイルバッテリー',
    ready_pets:'ペットキャリーとペット用品の準備',
    ready_contacts_title:'緊急連絡先',
    tips_before_tab:'事前',tips_during_tab:'発生中',tips_after_tab:'事後',
    tips_before_title:'火災前',
    tips_before_sub:'シーズンのプレッシャーがかかる前に、今やるべきこと。',
    tips_during_title:'火災中',
    tips_during_sub:'一分一秒が命に関わるときのリアルタイムの判断。',
    tips_after_title:'火災後',
    tips_after_sub:'健康を守るための安全な帰還と回復ステップ。',
    report_sub:'煙や炎を見ましたか？共有可能なレポートを作成し、当局に素早く連絡してください。',
    report_what_label:'何を見ましたか？',
    report_smoke:'煙の柱や霞',report_flame:'活発な炎が見える',
    report_glow:'夜間の異常なオレンジ色の輝き',report_other:'その他の異常な活動',
    report_notes_label:'メモ（任意）',
    report_notes_placeholder:'方向、距離の目安、風の状況…',
    report_generate_btn:'レポートを生成',report_copy_btn:'📋 コピー',report_to:'報告先：',
    heat_cat_4_label:'極度の危険',heat_cat_4_desc:'熱中症の危険性が高い — 屋外への露出を完全に避けてください。',
    heat_cat_3_label:'危険',heat_cat_3_desc:'熱関連疾患のリスクが高い — 激しい屋外活動を避けてください。',
    heat_cat_2_label:'厳重注意',heat_cat_2_desc:'注意 — 水分補給し、日陰で休憩してください。',
    heat_cat_1_label:'注意',heat_cat_1_desc:'長時間の露出や活動で疲労する可能性があります。',
    heat_cat_0_label:'快適',heat_cat_0_desc:'現在、熱中症の心配はありません。',
    heat_source:'実際 {temp} · 湿度 {hum}% · ソース：Open-Meteo',
    aqi_us_0_label:'良好',aqi_us_0_short:'良好',aqi_us_0_desc:'大気質は満足のいくものです。',
    aqi_us_1_label:'普通',aqi_us_1_short:'普通',aqi_us_1_desc:'許容範囲内ですが、特に敏感な人には問題になる場合があります。',
    aqi_us_2_label:'敏感なグループに悪い',aqi_us_2_short:'敏感',aqi_us_2_desc:'敏感なグループは健康に影響を受ける可能性があります。',
    aqi_us_3_label:'悪い',aqi_us_3_short:'悪い',aqi_us_3_desc:'誰もが健康への影響を感じ始める可能性があります。',
    aqi_us_4_label:'非常に悪い',aqi_us_4_short:'非常に悪い',aqi_us_4_desc:'健康警報 — 全員が深刻な影響を受ける可能性があります。',
    aqi_us_5_label:'危険',aqi_us_5_short:'危険',aqi_us_5_desc:'緊急事態 — 全人口が危険にさらされています。',
    aqi_owm_1_label:'良好',aqi_owm_1_short:'良好',aqi_owm_1_desc:'大気質は良好です。',
    aqi_owm_2_label:'まあまあ',aqi_owm_2_short:'まあまあ',aqi_owm_2_desc:'大気質は許容範囲内です。',
    aqi_owm_3_label:'普通',aqi_owm_3_short:'普通',aqi_owm_3_desc:'敏感なグループは影響を感じる可能性があります。',
    aqi_owm_4_label:'悪い',aqi_owm_4_short:'悪い',aqi_owm_4_desc:'大多数の人が健康への影響を感じる可能性があります。',
    aqi_owm_5_label:'非常に悪い',aqi_owm_5_short:'非常に悪い',aqi_owm_5_desc:'緊急事態の健康警報。',
    aqi_loading:'大気質データを読み込み中…',
    aqi_unavailable:'大気質データを現在利用できません。',
    aqi_foot_cams:'主要汚染物質：PM2.5 · ソース：Open-Meteo (CAMS)',
    aqi_foot_owm:'主要汚染物質：PM2.5 · ソース：OpenWeatherMap（1–5スケール）',
    aqi_foot_unavail:'ソース：利用不可',
    aqi_scale_note:'US EPA AQI · 現在 {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · データ利用不可',
    aqi_pm25:'PM2.5は {val} µg/m³です。',
    loc_no_geo:'このブラウザは位置情報サービスに対応していません。',
    loc_err_denied:'位置情報の許可が拒否されました。山火事リスクを確認するには位置情報へのアクセスを許可してください。',
    loc_err_unavail:'位置を特定できませんでした。接続を確認して再試行してください。',
    loc_err_timeout:'位置情報リクエストがタイムアウトしました。再試行してください。',
    loc_err_default:'位置情報の取得中にエラーが発生しました。',
    map_close:'✕ 閉じる',
  },
  it:{
    risk_intelligence:'Intelligence del Rischio',satellite_title:'Analisi Satellitare Incendi',
    nearby_title:'Incendi nelle Vicinanze',map_title:'Mappa',advice_title:'Cosa devo fare?',
    air_scale_title:"Scala della Qualità dell'Aria",incidents_title:'Incendi Boschivi Globali',
    forecast_title:'Previsione Meteo-Incendi 5 Giorni',weather_title:'Meteo',be_ready_title:'Sii Pronto',
    survival_title:'GUIDA DI SOPRAVVIVENZA INCENDI',
    report_eyebrow:'AIUTA LA TUA COMUNITÀ',report_title:'Segnala un Avvistamento',
    profile_general:'Generale',profile_asthma:'Asma',profile_elderly:'Anziani',profile_outdoor:'Lavoratore esterno',
    sort_distance:'Distanza',sort_size:'Dimensione',
    loading_msg:'In attesa del permesso di localizzazione…',
    error_msg_default:'Abbiamo bisogno della tua posizione per valutare il rischio incendi.',
    try_again:'Riprova',locating:'Localizzazione…',
    save_btn:'🔖 Salva',saved_btn:'✓ Salvato',share_btn:'↗ Condividi',my_location_btn:'📡 La mia posizione',
    search_placeholder:'Cerca una città o un luogo…',
    fire_card_label:'🔥 Incendio Boschivo',air_card_label:"🌫️ Qualità dell'Aria",heat_card_label:'🌡️ Calore',
    fire_detail_hint:'Tocca per i dettagli FWI ▾',air_detail_hint:'Tocca per cambiare fonte ▾',
    hero_checking:'Verifica delle condizioni attuali…',
    hero_sub:'Il livello complessivo è il peggiore dei tuoi tre rischi.',
    hero_good:"Le condizioni sono buone — goditi l'aria aperta.",
    hero_elevated:"{label} è elevato oggi — rimani vigile.",
    hero_unhealthy:"{label} è dannoso oggi — limita il tempo all'aperto.",
    hero_dangerous:"{label} è a livelli pericolosi — evita l'esposizione all'esterno.",
    status_good:'BUONO',status_moderate:'MODERATO',status_unhealthy:'DANNOSO',status_severe:'GRAVE',
    sat_gathering:'Raccolta passaggi satellite…',
    sat_clear:'Nessuna attività di fuoco rilevata dal satellite nelle vicinanze',
    sat_stable_1:'{n} cluster di fuoco rilevato — attività stabile tra i passaggi',
    sat_stable_pl:'{n} cluster di fuoco rilevati — attività stabile tra i passaggi',
    sat_intensifying_1:'{n} cluster di fuoco rilevato — in intensificazione tra i passaggi satellite',
    sat_intensifying_pl:'{n} cluster di fuoco rilevati — in intensificazione tra i passaggi satellite',
    sat_weakening_1:'{n} cluster di fuoco rilevato — attività in calo tra i passaggi',
    sat_weakening_pl:'{n} cluster di fuoco rilevati — attività in calo tra i passaggi',
    sat_unavailable:'Analisi satellite non disponibile al momento',sat_first_pass:'Primo passaggio',
    fire_no_detection:'Nessun incendio attivo rilevato nelle vicinanze. Rimani attento.',
    fire_no_detection_list:'Nessun rilevamento di incendio entro ~65km nelle ultime 24h.',
    fire_close:"Un incendio attivo è vicino. Rimani allerta e segui le indicazioni locali.",
    fire_moderate:"L'incendio attivo più vicino è a distanza moderata. Rimani attento.",
    fire_far:'Il rilevamento di incendio più vicino è a distanza sicura.',
    fire_source:'Fonte: NASA FIRMS',
    fire_detections:'{n} rilevamento{s} nelle vicinanze',fire_brightest:'più luminoso {k} K',
    fire_show_all:'Mostra tutti {n} ▾',fire_show_less:'Mostra meno ▴',
    detection_label:'Rilevamento #{n}',detected_ago:'Rilevato',confidence_label:'confidenza',
    advice_waiting:'In attesa delle condizioni attuali…',
    advice_right_now:'Adesso',advice_always:'Sempre',advice_resources:'Risorse',
    advice_air_good:"La qualità dell'aria è buona — attività all'aperto senza limitazioni.",
    advice_windows:'Tieni finestre e porte chiuse oggi.',
    advice_n95_outdoor:"Indossa una maschera N95 se lavori all'esterno per periodi prolungati.",
    advice_inhaler:"Tieni il tuo inalatore di emergenza con te, non solo a portata di mano.",
    advice_indoors:"Rimani in casa e usa un purificatore d'aria o l'AC in ricircolo.",
    advice_heat_good:'Le temperature sono confortevoli — nessuna precauzione termica necessaria.',
    advice_exercise:"Fai esercizio in casa — evita attività fisica intensa all'esterno.",
    advice_hydrate:"Mantieniti idratato e fai pause all'ombra.",
    advice_peak_heat:"Evita l'attività all'aperto nelle ore più calde (12–16).",
    advice_shade_breaks:"Fai pause all'ombra ogni 20 minuti e bevi acqua regolarmente.",
    advice_check_neighbors:'Controlla i vicini con mobilità ridotta o senza aria condizionata.',
    advice_fire_good:'Nessun incendio attivo rilevato nelle vicinanze — condizioni calme.',
    advice_fire_aware:"Rimani attento all'attività di incendio nelle vicinanze e ai cambiamenti della qualità dell'aria.",
    advice_evac_bag:"Tieni pronta una borsa di evacuazione e monitora da vicino gli avvisi ufficiali.",
    advice_evacuate_now:"Segui immediatamente tutti gli ordini di evacuazione ufficiali — non aspettare.",
    advice_wind:"Metti al sicuro mobili e oggetti all'esterno — il vento può diffondere braci.",
    standing_general_0:"Controlla gli avvisi locali antincendio prima di attività all'aperto.",
    standing_general_1:'Tieni le finestre chiuse nei giorni di fumo o vento forte.',
    standing_general_2:'Conosci i tuoi due percorsi di evacuazione più vicini.',
    standing_general_3:"Tieni almeno 3 giorni di forniture d'emergenza in casa.",
    standing_asthma_0:"Tieni il tuo inalatore di emergenza sempre accessibile.",
    standing_asthma_1:"Monitora l'IQA ogni giorno — le vie respiratorie reagiscono prima che tu lo senta.",
    standing_asthma_2:"Usa un filtro HEPA in casa nei giorni di fumo.",
    standing_asthma_3:"Redigi un piano di azione per l'asma e condividilo con qualcuno vicino.",
    standing_elderly_0:"Mantieniti idratato — il senso della sete si indebolisce con l'età.",
    standing_elderly_1:"Tieni farmaci per almeno 2 settimane.",
    standing_elderly_2:"Individua un rifugio fresco (biblioteca, centro comunitario) in caso di guasto all'AC.",
    standing_elderly_3:"Assicurati che qualcuno ti controlli quotidianamente nei periodi ad alto rischio.",
    standing_outdoor_0:'Controlla le previsioni meteo-incendi prima di ogni turno.',
    standing_outdoor_1:"Porta acqua e una mascherina antipolvere ad ogni intervento.",
    standing_outdoor_2:'Disponi di un piano di comunicazione per zone senza copertura.',
    standing_outdoor_3:"Conosci la stazione dei pompieri o l'uscita di emergenza più vicina.",
    incidents_loading:'Caricamento dati incidenti globali…',
    incidents_count:'{n} incendio{s} boschivo{s} monitorato{s} nel mondo negli ultimi 30 giorni',
    incidents_none:'Nessun incendio boschivo globale monitorato negli ultimi 30 giorni',
    incidents_unavailable:'Dati incidenti globali non disponibili al momento',
    incidents_error:'Impossibile raggiungere NASA EONET — riprova tra poco.',
    incidents_active:'Attivo',incidents_past:'Passato',incidents_show_map:'🌍 Mostra sulla mappa',
    map_expand:'⤢ Espandi',map_your_location:'La tua posizione',
    map_fire_low:'Fuoco (basso)',map_fire_med:'Fuoco (medio)',map_fire_intense:'Fuoco (intenso)',
    map_click_spot:'Clicca sulla mappa per analizzare un punto',global_fires_btn:'🔥 Incendi globali',
    w_temp:'Temp',w_wind:'Vento',w_humidity:'Umidità',w_rain:'Pioggia 7 giorni',
    ready_sub:"Lista di controllo per la preparazione all'emergenza",
    ready_gobag:'Borsa di emergenza con forniture per 3 giorni',
    ready_docs:'Documenti importanti copiati o salvati',
    ready_meds:'Farmaci (scorta per 7 giorni)',
    ready_routes:'Conoscere i percorsi di evacuazione',
    ready_alerts:"Iscritto agli avvisi d'emergenza locali",
    ready_masks:'Maschere N95 a portata di mano contro il fumo',
    ready_battery:'Caricabatterie e power bank per il telefono',
    ready_pets:'Trasportini e forniture per animali pronti',
    ready_contacts_title:'Contatti di Emergenza',
    tips_before_tab:'Prima',tips_during_tab:'Durante',tips_after_tab:'Dopo',
    tips_before_title:'Prima di un Incendio',
    tips_before_sub:'Cosa fare ora, prima che la stagione degli incendi ti metta sotto pressione.',
    tips_during_title:'Durante un Incendio',
    tips_during_sub:'Decisioni in tempo reale che salvano vite quando ogni minuto conta.',
    tips_after_title:'Dopo un Incendio',
    tips_after_sub:'Rientro sicuro e misure di recupero per proteggere la tua salute.',
    report_sub:'Vedi fumo o fiamme? Genera un report condivisibile e contatta le autorità.',
    report_what_label:'Cosa hai visto?',
    report_smoke:'Colonna di fumo o nebbia',report_flame:'Fiamme attive visibili',
    report_glow:'Bagliore arancione insolito di notte',report_other:'Altra attività insolita',
    report_notes_label:'Note (facoltativo)',
    report_notes_placeholder:'Direzione, distanza stimata, condizioni del vento…',
    report_generate_btn:'Genera Report',report_copy_btn:'📋 Copia',report_to:'Segnala a:',
    heat_cat_4_label:'Pericolo estremo',heat_cat_4_desc:"Il colpo di calore è probabile — evitare completamente l'esposizione esterna.",
    heat_cat_3_label:'Pericolo',heat_cat_3_desc:"Alto rischio di malattie da calore — evitare attività fisiche intense all'aperto.",
    heat_cat_2_label:'Estrema cautela',heat_cat_2_desc:"Cautela — idratarsi e fare pause all'ombra.",
    heat_cat_1_label:'Cautela',heat_cat_1_desc:'La stanchezza è possibile con esposizione prolungata o attività intensa.',
    heat_cat_0_label:'Confortevole',heat_cat_0_desc:'Il calore non è un problema significativo al momento.',
    heat_source:'Reale {temp} · umidità {hum}% · fonte: Open-Meteo',
    aqi_us_0_label:'BUONA',aqi_us_0_short:'Buona',aqi_us_0_desc:"La qualità dell'aria è soddisfacente.",
    aqi_us_1_label:'MODERATA',aqi_us_1_short:'Moderata',aqi_us_1_desc:"Accettabile, ma preoccupante per persone particolarmente sensibili.",
    aqi_us_2_label:'NON SALUBRE (SENSIBILI)',aqi_us_2_short:'Sensibile',aqi_us_2_desc:"I gruppi sensibili possono avvertire effetti sulla salute.",
    aqi_us_3_label:'NON SALUBRE',aqi_us_3_short:'Non salubre',aqi_us_3_desc:"Tutti possono iniziare ad avvertire effetti sulla salute.",
    aqi_us_4_label:'MOLTO INSALUBRE',aqi_us_4_short:'Molto insalubre',aqi_us_4_desc:"Allerta salute — effetti gravi possibili per tutti.",
    aqi_us_5_label:'PERICOLOSA',aqi_us_5_short:'Pericolosa',aqi_us_5_desc:"Condizioni di emergenza — tutta la popolazione a rischio.",
    aqi_owm_1_label:'BUONA',aqi_owm_1_short:'Buona',aqi_owm_1_desc:"La qualità dell'aria è buona.",
    aqi_owm_2_label:'DISCRETA',aqi_owm_2_short:'Discreta',aqi_owm_2_desc:"La qualità dell'aria è accettabile.",
    aqi_owm_3_label:'MODERATA',aqi_owm_3_short:'Moderata',aqi_owm_3_desc:"I gruppi sensibili possono notare effetti.",
    aqi_owm_4_label:'SCARSA',aqi_owm_4_short:'Scarsa',aqi_owm_4_desc:"La maggior parte delle persone può avvertire effetti sulla salute.",
    aqi_owm_5_label:'MOLTO SCARSA',aqi_owm_5_short:'Molto scarsa',aqi_owm_5_desc:"Allerta sanitaria per condizioni di emergenza.",
    aqi_loading:"Caricamento dati qualità dell'aria…",
    aqi_unavailable:"Dati sulla qualità dell'aria non disponibili al momento.",
    aqi_foot_cams:'Inquinante dominante: PM2.5 · fonte: Open-Meteo (CAMS)',
    aqi_foot_owm:'Inquinante dominante: PM2.5 · fonte: OpenWeatherMap (scala 1–5)',
    aqi_foot_unavail:'Fonte: non disponibile',
    aqi_scale_note:'US EPA AQI · attualmente {aqi} ({short})',
    aqi_scale_unavail:'US EPA AQI · dati non disponibili',
    aqi_pm25:' PM2.5 è {val} µg/m³.',
    loc_no_geo:'Questo browser non supporta i servizi di localizzazione.',
    loc_err_denied:"Il permesso di localizzazione è stato negato. Consenti l'accesso alla posizione per vedere il tuo rischio incendi.",
    loc_err_unavail:'Non è stato possibile determinare la tua posizione. Controlla la connessione e riprova.',
    loc_err_timeout:'La richiesta di posizione è scaduta. Riprova.',
    loc_err_default:'Si è verificato un errore durante il recupero della tua posizione.',
    map_close:'✕ Chiudi',
  },
  ko:{
    risk_intelligence:'위험 정보',satellite_title:'위성 화재 분석',
    nearby_title:'인근 화재',map_title:'지도',advice_title:'무엇을 해야 하나요?',
    air_scale_title:'대기질 척도',incidents_title:'전 세계 산불 사건',
    forecast_title:'5일 화재 날씨 예보',weather_title:'날씨',be_ready_title:'대비하기',
    survival_title:'산불 생존 가이드',
    report_eyebrow:'지역 사회 돕기',report_title:'화재 목격 신고',
    profile_general:'일반',profile_asthma:'천식',profile_elderly:'노인',profile_outdoor:'야외 근무자',
    sort_distance:'거리',sort_size:'규모',
    loading_msg:'위치 권한을 기다리는 중…',
    error_msg_default:'산불 위험을 평가하려면 위치 정보가 필요합니다.',
    try_again:'다시 시도',locating:'위치 확인 중…',
    save_btn:'🔖 저장',saved_btn:'✓ 저장됨',share_btn:'↗ 공유',my_location_btn:'📡 내 위치',
    search_placeholder:'도시나 장소 검색…',
    fire_card_label:'🔥 산불',air_card_label:'🌫️ 대기질',heat_card_label:'🌡️ 열',
    fire_detail_hint:'FWI 세부 정보 보기 ▾',air_detail_hint:'데이터 출처 변경 ▾',
    hero_checking:'현재 상황 확인 중…',
    hero_sub:'전체 레벨은 아래 세 가지 위험 중 최악입니다.',
    hero_good:'상황이 양호합니다 — 야외 활동을 즐기세요.',
    hero_elevated:'{label}이(가) 오늘 상승했습니다 — 주의하세요.',
    hero_unhealthy:'{label}이(가) 오늘 나쁩니다 — 야외 시간을 제한하세요.',
    hero_dangerous:'{label}이(가) 위험 수준입니다 — 야외 노출을 피하세요.',
    status_good:'좋음',status_moderate:'보통',status_unhealthy:'나쁨',status_severe:'심각',
    sat_gathering:'위성 데이터 수집 중…',
    sat_clear:'인근에서 위성으로 감지된 화재 활동 없음',
    sat_stable_1:'{n}개 화재 클러스터 감지 — 패스 간 활동 수준 안정',
    sat_stable_pl:'{n}개 화재 클러스터 감지 — 패스 간 활동 수준 안정',
    sat_intensifying_1:'{n}개 화재 클러스터 감지 — 위성 패스 간 강화 중',
    sat_intensifying_pl:'{n}개 화재 클러스터 감지 — 위성 패스 간 강화 중',
    sat_weakening_1:'{n}개 화재 클러스터 감지 — 패스 간 활동 감소 중',
    sat_weakening_pl:'{n}개 화재 클러스터 감지 — 패스 간 활동 감소 중',
    sat_unavailable:'위성 분석을 현재 사용할 수 없습니다',sat_first_pass:'첫 번째 패스',
    fire_no_detection:'인근에서 활성 화재가 감지되지 않았습니다. 지역 상황에 주의하세요.',
    fire_no_detection_list:'최근 24시간 내 ~65km 이내 화재 감지 없음.',
    fire_close:'근처에 활성 화재가 있습니다. 경계를 유지하고 현지 대피 지침을 따르세요.',
    fire_moderate:'가장 가까운 활성 화재는 적당한 거리에 있습니다. 주의를 유지하세요.',
    fire_far:'가장 가까운 화재 감지는 안전한 거리에 있습니다.',
    fire_source:'출처: NASA FIRMS',
    fire_detections:'인근 {n}건 감지',fire_brightest:'가장 밝음 {k} K',
    fire_show_all:'전체 {n}개 보기 ▾',fire_show_less:'덜 보기 ▴',
    detection_label:'감지 #{n}',detected_ago:'감지됨',confidence_label:'신뢰도',
    advice_waiting:'현재 상황 데이터를 기다리는 중…',
    advice_right_now:'지금',advice_always:'항상',advice_resources:'리소스',
    advice_air_good:'대기질이 좋습니다 — 야외 활동에 적합합니다.',
    advice_windows:'오늘은 창문과 문을 닫아 두세요.',
    advice_n95_outdoor:'장시간 야외에서 작업할 경우 N95 마스크를 착용하세요.',
    advice_inhaler:'구급 흡입기를 근처에 두지 말고 항상 소지하세요.',
    advice_indoors:'실내에 머물며 공기 청정기 또는 에어컨을 내부 순환 모드로 사용하세요.',
    advice_heat_good:'온도가 쾌적합니다 — 더위 예방 조치가 필요하지 않습니다.',
    advice_exercise:'운동은 실내로 옮기세요 — 격렬한 야외 활동을 피하세요.',
    advice_hydrate:'수분을 충분히 섭취하고 그늘에서 휴식을 취하세요.',
    advice_peak_heat:'가장 더운 시간대(12~16시) 야외 활동을 피하세요.',
    advice_shade_breaks:'20분마다 그늘에서 휴식을 취하고 규칙적으로 수분을 보충하세요.',
    advice_check_neighbors:'이동에 불편함이 있거나 에어컨이 없는 이웃을 확인하세요.',
    advice_fire_good:'인근에서 활성 화재가 감지되지 않았습니다 — 상황이 안정적입니다.',
    advice_fire_aware:'인근 화재 활동과 대기질 급변에 주의하세요.',
    advice_evac_bag:'대피 가방을 준비하고 공식 화재 경보를 주의 깊게 모니터링하세요.',
    advice_evacuate_now:'모든 공식 대피 명령을 즉시 따르세요 — 기다리지 마세요.',
    advice_wind:'야외 가구와 물건을 고정하세요 — 바람이 불씨를 퍼뜨릴 수 있습니다.',
    standing_general_0:'야외 활동 전 지역 소방 당국 경보를 확인하세요.',
    standing_general_1:'연기나 강풍이 있는 날 창문을 닫아 두세요.',
    standing_general_2:'가장 가까운 두 개의 대피 경로를 파악하세요.',
    standing_general_3:'최소 3일분의 비상 물품을 집에 비축하세요.',
    standing_asthma_0:'구급 흡입기를 항상 손이 닿는 곳에 두세요.',
    standing_asthma_1:'매일 대기질 지수를 확인하세요 — 기도는 느끼기 전에 반응합니다.',
    standing_asthma_2:'연기 많은 날 실내에서 HEPA 공기 필터를 사용하세요.',
    standing_asthma_3:'천식 행동 계획을 서면으로 작성하고 가까운 사람과 공유하세요.',
    standing_elderly_0:'수분을 충분히 섭취하세요 — 나이가 들면 갈증 반응이 약해집니다.',
    standing_elderly_1:'약을 최소 2주분 비축해 두세요.',
    standing_elderly_2:'에어컨 고장 시를 대비해 시원한 피난처(도서관, 커뮤니티 센터)를 파악하세요.',
    standing_elderly_3:'고위험 기간 동안 누군가가 매일 확인해 주도록 하세요.',
    standing_outdoor_0:'각 교대 근무 전 화재 날씨 예보를 확인하세요.',
    standing_outdoor_1:'매 작업마다 물과 방진 마스크를 지참하세요.',
    standing_outdoor_2:'신호가 없는 지역을 위한 통신 계획을 세우세요.',
    standing_outdoor_3:'가장 가까운 소방서 또는 비상구 위치를 파악하세요.',
    incidents_loading:'전 세계 사건 데이터를 로드하는 중…',
    incidents_count:'지난 30일간 전 세계 {n}건의 산불 추적됨',
    incidents_none:'지난 30일간 전 세계 산불 없음',
    incidents_unavailable:'전 세계 사건 데이터를 현재 사용할 수 없습니다',
    incidents_error:'NASA EONET에 연결할 수 없습니다 — 잠시 후 다시 시도하세요.',
    incidents_active:'활성',incidents_past:'과거',incidents_show_map:'🌍 지도에 표시',
    map_expand:'⤢ 확대',map_your_location:'내 위치',
    map_fire_low:'화재 (낮음)',map_fire_med:'화재 (중간)',map_fire_intense:'화재 (강함)',
    map_click_spot:'지도를 클릭하여 지점 확인',global_fires_btn:'🔥 전 세계 화재',
    w_temp:'기온',w_wind:'바람',w_humidity:'습도',w_rain:'7일 강수량',
    ready_sub:'비상 대비 체크리스트',
    ready_gobag:'3일분 물품이 담긴 대피 가방 준비',
    ready_docs:'중요 서류 복사 또는 백업',
    ready_meds:'약품 (7일분)',
    ready_routes:'대피 경로 파악',
    ready_alerts:'지역 비상 경보 등록',
    ready_masks:'연기 대비 N95 마스크 준비',
    ready_battery:'스마트폰 충전기 및 보조 배터리',
    ready_pets:'반려동물 이동장 및 용품 준비',
    ready_contacts_title:'비상 연락처',
    tips_before_tab:'사전',tips_during_tab:'발생 중',tips_after_tab:'사후',
    tips_before_title:'화재 전',
    tips_before_sub:'화재 시즌이 압박을 가하기 전에 지금 해야 할 일.',
    tips_during_title:'화재 중',
    tips_during_sub:'매 순간이 중요할 때 생명을 구하는 실시간 결정.',
    tips_after_title:'화재 후',
    tips_after_sub:'건강을 보호하기 위한 안전한 귀환 및 복구 단계.',
    report_sub:'연기나 불꽃을 보셨나요? 공유 가능한 보고서를 생성하고 당국에 빠르게 연락하세요.',
    report_what_label:'무엇을 보셨나요?',
    report_smoke:'연기 기둥 또는 연무',report_flame:'활성 불꽃이 보임',
    report_glow:'밤에 이상한 주황색 빛',report_other:'기타 이상한 활동',
    report_notes_label:'메모 (선택)',
    report_notes_placeholder:'방향, 거리 추정, 바람 조건…',
    report_generate_btn:'보고서 생성',report_copy_btn:'📋 복사',report_to:'신고처:',
    heat_cat_4_label:'극도의 위험',heat_cat_4_desc:'열사병 가능성이 높습니다 — 야외 노출을 완전히 피하세요.',
    heat_cat_3_label:'위험',heat_cat_3_desc:'열 관련 질환의 위험이 높습니다 — 격렬한 야외 활동을 피하세요.',
    heat_cat_2_label:'극도의 주의',heat_cat_2_desc:'주의 — 수분을 충분히 섭취하고 그늘에서 쉬세요.',
    heat_cat_1_label:'주의',heat_cat_1_desc:'장시간 노출이나 활동으로 피로감이 생길 수 있습니다.',
    heat_cat_0_label:'쾌적',heat_cat_0_desc:'현재 더위는 중요한 우려 사항이 아닙니다.',
    heat_source:'실제 {temp} · 습도 {hum}% · 출처: Open-Meteo',
    aqi_us_0_label:'좋음',aqi_us_0_short:'좋음',aqi_us_0_desc:'대기질이 만족스럽습니다.',
    aqi_us_1_label:'보통',aqi_us_1_short:'보통',aqi_us_1_desc:'허용 가능하나 특히 민감한 사람에게는 문제가 될 수 있습니다.',
    aqi_us_2_label:'민감군에 나쁨',aqi_us_2_short:'민감',aqi_us_2_desc:'민감한 그룹은 건강에 영향을 받을 수 있습니다.',
    aqi_us_3_label:'나쁨',aqi_us_3_short:'나쁨',aqi_us_3_desc:'모든 사람이 건강 영향을 받기 시작할 수 있습니다.',
    aqi_us_4_label:'매우 나쁨',aqi_us_4_short:'매우 나쁨',aqi_us_4_desc:'건강 경보 — 모든 사람에게 심각한 영향이 나타날 수 있습니다.',
    aqi_us_5_label:'위험',aqi_us_5_short:'위험',aqi_us_5_desc:'비상 상황 — 전체 인구가 위험에 처해 있습니다.',
    aqi_owm_1_label:'좋음',aqi_owm_1_short:'좋음',aqi_owm_1_desc:'대기질이 좋습니다.',
    aqi_owm_2_label:'보통',aqi_owm_2_short:'보통',aqi_owm_2_desc:'대기질이 허용 가능합니다.',
    aqi_owm_3_label:'보통',aqi_owm_3_short:'보통',aqi_owm_3_desc:'민감한 그룹은 영향을 느낄 수 있습니다.',
    aqi_owm_4_label:'나쁨',aqi_owm_4_short:'나쁨',aqi_owm_4_desc:'대부분의 사람들이 건강 영향을 느낄 수 있습니다.',
    aqi_owm_5_label:'매우 나쁨',aqi_owm_5_short:'매우 나쁨',aqi_owm_5_desc:'긴급 건강 경보.',
    aqi_loading:'대기질 데이터를 불러오는 중…',
    aqi_unavailable:'대기질 데이터를 현재 이용할 수 없습니다.',
    aqi_foot_cams:'주요 오염 물질: PM2.5 · 출처: Open-Meteo (CAMS)',
    aqi_foot_owm:'주요 오염 물질: PM2.5 · 출처: OpenWeatherMap (1–5 척도)',
    aqi_foot_unavail:'출처: 이용 불가',
    aqi_scale_note:'미국 EPA AQI · 현재 {aqi} ({short})',
    aqi_scale_unavail:'미국 EPA AQI · 데이터 이용 불가',
    aqi_pm25:' PM2.5는 {val} µg/m³입니다.',
    loc_no_geo:'이 브라우저는 위치 서비스를 지원하지 않습니다.',
    loc_err_denied:'위치 권한이 거부되었습니다. 산불 위험을 확인하려면 위치 접근을 허용하세요.',
    loc_err_unavail:'위치를 확인할 수 없습니다. 연결 상태를 확인하고 다시 시도하세요.',
    loc_err_timeout:'위치 요청이 시간 초과되었습니다. 다시 시도하세요.',
    loc_err_default:'위치를 가져오는 중 오류가 발생했습니다.',
    map_close:'✕ 닫기',
  },
};

function t(key){ return (TRANSLATIONS[currentLang]||TRANSLATIONS.en)[key] || TRANSLATIONS.en[key] || key; }

/** Template substitution: tf('hero_elevated', {label:'Wildfire'}) → translated string with {label} replaced. */
function tf(key, vars){
  let s = t(key);
  if(vars) Object.entries(vars).forEach(([k,v]) => { s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)); });
  return s;
}

function applyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.dataset.i18n);
    if(v) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const v = t(el.dataset.i18nPlaceholder);
    if(v) el.placeholder = v;
  });
  document.documentElement.lang = currentLang;
  const d = document.getElementById('lang-current');
  if(d) d.textContent = currentLang.toUpperCase();
}

function initLang(){
  const saved = localStorage.getItem(LANG_KEY);
  if(saved && TRANSLATIONS[saved]) currentLang = saved;
  else {
    const browser = (navigator.language || 'en').slice(0,2).toLowerCase();
    if(TRANSLATIONS[browser]) currentLang = browser;
  }
  applyI18n();
}

function setLang(lang){
  if(!TRANSLATIONS[lang]) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyI18n();
  // Re-render dynamic sections so their text updates immediately.
  if(lastWeather) renderHeat(lastWeather);
  rerenderAqi();
  updateHero();
  renderAdvice();
  renderSatelliteCard();
  renderFiresCard();
  updateSaveBtn();
  // Re-apply the active tips phase title/sub.
  const activeTab = document.querySelector('.tips-tab.active');
  if(activeTab){
    const phase = ['before','during','after'][Array.from(document.querySelectorAll('.tips-tab')).indexOf(activeTab)];
    if(phase) setTipsPhase(phase);
  }
  closeLangMenu();
}

function toggleLangMenu(){
  const menu = document.getElementById('lang-menu');
  if(!menu) return;
  const open = menu.classList.toggle('hidden');
  document.getElementById('lang-toggle-btn')?.setAttribute('aria-expanded', String(!open));
}

function closeLangMenu(){
  document.getElementById('lang-menu')?.classList.add('hidden');
  document.getElementById('lang-toggle-btn')?.setAttribute('aria-expanded','false');
}

document.addEventListener('click', e => {
  if(!document.getElementById('lang-picker')?.contains(e.target)) closeLangMenu();
});

/* ================================================================
 * SURVIVAL GUIDE TABS (Before / During / After)
 * ================================================================ */

function setTipsPhase(phase){
  ['before','during','after'].forEach(p => {
    const list = document.getElementById(`tips-${p}`);
    if(list) list.classList.toggle('hidden', p !== phase);
  });
  document.querySelectorAll('.tips-tab').forEach((btn, i) => {
    btn.classList.toggle('active', ['before','during','after'][i] === phase);
  });
  const titleEl = document.getElementById('tips-phase-title');
  const subEl   = document.getElementById('tips-phase-sub');
  if(titleEl) titleEl.textContent = t(`tips_${phase}_title`);
  if(subEl)   subEl.textContent   = t(`tips_${phase}_sub`);
}

/* ================================================================
 * FIRE SIGHTING REPORT
 * ================================================================ */

const REPORTS_KEY = 'firewatch_reports';

function submitReport(e){
  e.preventDefault();
  const type  = document.getElementById('report-type')?.value || 'other';
  const notes = (document.getElementById('report-notes')?.value || '').trim();
  const loc   = document.getElementById('place-name')?.textContent?.trim() ||
                (userLat != null ? `${userLat.toFixed(4)}, ${userLon.toFixed(4)}` : 'Unknown location');
  const timestamp = new Date().toLocaleString();

  const TYPE_LABELS = { smoke:'Smoke column or haze', flame:'Active flames visible', glow:'Unusual orange glow at night', other:'Other unusual activity' };
  const lines = [
    '🔥 FIRE SIGHTING REPORT',
    `Location : ${loc}`,
    `Time     : ${timestamp}`,
    `Observed : ${TYPE_LABELS[type] || type}`,
  ];
  if(notes) lines.push(`Notes    : ${notes}`);
  lines.push('Reported via Firewatch');
  const text = lines.join('\n');

  const outputEl = document.getElementById('report-output');
  const textEl   = document.getElementById('report-output-text');
  if(outputEl && textEl){
    textEl.textContent = text;
    outputEl.classList.remove('hidden');
    outputEl.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }

  let reports = [];
  try { reports = JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]'); } catch {}
  reports.unshift({ type, loc, notes, timestamp });
  localStorage.setItem(REPORTS_KEY, JSON.stringify(reports.slice(0, 10)));
  renderReportHistory();

  const notesEl = document.getElementById('report-notes');
  if(notesEl) notesEl.value = '';
}

function copyReport(){
  const text = document.getElementById('report-output-text')?.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('.report-copy-btn');
    if(btn){ const o = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(()=>{ btn.textContent = o; }, 2000); }
  }).catch(() => window.prompt('Copy this report:', text));
}

function renderReportHistory(){
  const el = document.getElementById('report-history');
  if(!el) return;
  let reports = [];
  try { reports = JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]'); } catch {}
  if(!reports.length){ el.innerHTML = ''; return; }
  const LABELS = { smoke:'Smoke', flame:'Flames', glow:'Glow', other:'Other' };
  el.innerHTML = `<div class="report-history-head">Your past reports (${reports.length})</div>` +
    reports.map(r =>
      `<div class="report-history-item">
        <span class="report-history-badge">${LABELS[r.type]||r.type}</span>
        <span class="report-history-loc">${r.loc}</span>
        <span class="report-history-time">${r.timestamp}</span>
      </div>`
    ).join('');
}

/* ---------------- Tooltip system ---------------- */
(function initTooltips(){
  const tip = document.getElementById('tip');
  if(!tip) return;
  let active = null;
  const GAP = 12;

  function pos(cx, cy){
    const { innerWidth: vw, innerHeight: vh } = window;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = cx + GAP, y = cy + GAP;
    if(x + tw > vw - 8) x = cx - tw - GAP;
    if(y + th > vh - 8) y = cy - th - GAP;
    tip.style.left = `${x}px`;
    tip.style.top  = `${y}px`;
  }

  function show(target, cx, cy){
    if(active === target) return;
    active = target;
    tip.textContent = target.dataset.tip;
    tip.classList.add('visible');
    pos(cx, cy);
  }

  function hide(){
    active = null;
    tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if(t) show(t, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => {
    if(active) pos(e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', e => {
    const t = e.target.closest('[data-tip]');
    if(t && !t.contains(e.relatedTarget)) hide();
  });
  // Touch: tap once to show, tap elsewhere or same target again to dismiss
  document.addEventListener('touchstart', e => {
    const t = e.target.closest('[data-tip]');
    if(t){
      e.preventDefault();
      if(active === t){ hide(); return; }
      const touch = e.touches[0];
      show(t, touch.clientX, touch.clientY);
    } else {
      hide();
    }
  }, { passive: false });
})();

/* ---------------- Init ---------------- */
(function initFromUrlOrGeolocate(){
  // Apply theme and language first so all UI text is correct before data loads.
  initTheme();
  initLang();
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

// Report history rendered after DOM is ready
renderReportHistory();
