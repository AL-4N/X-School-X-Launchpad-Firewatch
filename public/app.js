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

/* ---------------- Wind direction ---------------- */

function degreesToCompass(deg){
  if(deg == null) return '—';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// Levels are 0=green(good) 1=yellow(moderate) 2=orange(unhealthy) 3=red(severe),
// shared across the hero verdict and each risk card so the "worst of three" logic is one source of truth.
const LEVEL_COLORS = ['#2ecc71', '#f1c40f', '#e67e22', '#e74c3c'];
const LEVEL_NAMES = ['GREEN', 'YELLOW', 'ORANGE', 'RED'];

const current = {
  nearestFireMiles: null, nearestFireDir: null, fireCount: 0, fwiDangerLevel: null, fwiDangerHex: null,
  fireLevel: null,
  aqiLevel: null, aqiValue: null, aqiScale: null,
  heatLevel: null, heatFeelsC: null, actualTempC: null, humidity: null, windKmh: null,
};

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
    L.circleMarker([f.lat, f.lon], {
      renderer,
      radius: 3, weight: 0,
      fillColor: '#ff5e2a', fillOpacity: 0.8,
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

    document.getElementById('w-temp').textContent = `${Math.round(weather.temp)}°C`;
    document.getElementById('w-wind').textContent = `${Math.round(weather.wind)}`;
    document.getElementById('w-winddir').textContent = degreesToCompass(weather.windDir);
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

  document.getElementById('heat-big').textContent = Math.round(weather.feelsLike);
  document.getElementById('heat-desc').textContent = cat.desc;
  document.getElementById('heat-foot').textContent =
    `Actual ${Math.round(weather.temp)}°C · humidity ${Math.round(weather.humidity)}% · source: Open-Meteo`;

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

/* ---------------- Hero verdict (worst of the three risk cards) ---------------- */

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

function renderAdvice(){
  const items = [];
  const { fireLevel, aqiLevel, heatLevel, windKmh } = current;

  if(aqiLevel != null){
    const aqiThreshold = profile === 'asthma' ? 1 : 2;
    if(aqiLevel >= aqiThreshold) items.push('Keep windows and doors closed today.');
    if(aqiLevel >= 1 && (profile === 'outdoor')) items.push('Wear an N95 mask if working outdoors for long periods.');
    if(aqiLevel >= 1 && profile === 'asthma') items.push('Keep a rescue inhaler accessible.');
  }

  if(heatLevel != null){
    if(heatLevel >= 2) items.push('Move exercise indoors — skip strenuous outdoor activity.');
    else if(heatLevel >= 1) items.push('Stay hydrated and take breaks in the shade.');
    if(heatLevel >= 1 && profile === 'elderly') items.push('Avoid outdoor activity during peak heat hours (12–4pm).');
    if(heatLevel >= 1 && profile === 'outdoor') items.push('Take shade breaks every 20 minutes and drink water regularly.');
  }

  if(fireLevel != null){
    if(fireLevel >= 2) items.push('Have an evacuation bag ready and monitor CAL FIRE alerts.');
    else if(fireLevel >= 1) items.push('Stay aware of nearby fire activity and air quality shifts.');
  }

  if(windKmh != null && windKmh >= 35) items.push('Secure loose outdoor items — winds are strong enough to cause damage.');

  if((profile === 'elderly') && [fireLevel, aqiLevel, heatLevel].some(l => l >= 2)) {
    items.push('Check on elderly neighbors and anyone with limited mobility.');
  }

  const list = document.getElementById('advice-list');
  if(!items.length){
    const anyData = fireLevel != null || aqiLevel != null || heatLevel != null;
    list.innerHTML = `<div class="advice-item"><span class="chk">✓</span>${
      anyData ? 'Conditions are good — no special precautions needed today.' : 'Waiting for current conditions…'
    }</div>`;
    return;
  }
  list.innerHTML = items.map(t => `<div class="advice-item"><span class="chk">✓</span>${t}</div>`).join('');
}

/* ---------------- Risk rendering (FWI-driven) ---------------- */

function renderRisk(fwiResult, weather){
  const { codes, indices, danger, isColdStart } = fwiResult;

  current.fwiDangerLevel = danger.level;
  current.fwiDangerHex = danger.hex;

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
  if(weather.wind >= 30) factors.push({icon:'💨', text:`Wind at ${Math.round(weather.wind)} km/h is a major driver of the Initial Spread Index`});
  else if(weather.wind >= 15) factors.push({icon:'💨', text:`Moderate wind (${Math.round(weather.wind)} km/h) is contributing to spread potential`});
  else factors.push({icon:'✓', text:'Low wind speeds are limiting spread potential'});

  if(weather.humidity <= 30) factors.push({icon:'🏜', text:`Low humidity (${Math.round(weather.humidity)}%) is drying fine surface fuels quickly`});
  else if(weather.humidity >= 60) factors.push({icon:'✓', text:'Higher humidity is slowing fine fuel drying'});

  if(weather.rain7d <= 2) factors.push({icon:'☀️', text:'Little rain in the past week is allowing deeper fuel layers to dry out (reflected in DMC/DC)'});
  else if(weather.rain7d >= 15) factors.push({icon:'✓', text:'Recent rainfall is keeping deeper fuel layers moist'});

  if(weather.temp >= 30) factors.push({icon:'🌡', text:`High temperature (${Math.round(weather.temp)}°C) is accelerating fuel drying`});

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

/** Combines real-time fire proximity (FIRMS) with the weather-driven FWI
 * danger level so the wildfire card reflects both "is a fire near me" and
 * "are conditions primed for one to spread." */
function recomputeFireLevel(){
  const miles = current.nearestFireMiles;
  const fwiLvl = current.fwiDangerLevel;
  let level = 0;
  if(miles != null && miles <= 10) level = 3;
  else if(miles != null && miles <= 25) level = 2;
  else if(fwiLvl >= 5) level = Math.max(level, 3);
  else if(fwiLvl >= 4) level = Math.max(level, 2);
  else if(fwiLvl >= 2) level = Math.max(level, 1);
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
    recomputeFireLevel();
    updateHero();
    renderAdvice();
  }
}

function renderFiresCard(){
  const big = document.getElementById('fire-big');
  const unit = document.getElementById('fire-big-unit');
  const desc = document.getElementById('fire-desc');
  const foot = document.getElementById('fire-foot');
  const list = document.getElementById('fires-detail-list');

  if(!lastFires.length){
    big.textContent = '—';
    unit.textContent = '';
    desc.textContent = 'No active fire detected nearby. Stay aware of local conditions.';
    foot.textContent = 'Source: NASA FIRMS';
    list.innerHTML = '<div class="empty-note">No fire detections within ~65km in the last 24h.</div>';
    return;
  }

  const nearest = lastFires[0];
  const miles = Math.round(nearest.distKm * 0.621371);
  big.textContent = miles;
  unit.textContent = ` mi ${nearest.dir}`;
  desc.textContent = miles <= 10
    ? 'An active fire is close by. Stay alert and follow local evacuation guidance.'
    : miles <= 25
      ? 'Nearest active fire is a moderate distance away. Stay aware.'
      : 'Nearest active fire detection is a safe distance away.';

  const brightest = lastFires.reduce((m, f) => f.brightness != null && f.brightness > m ? f.brightness : m, 0);
  foot.textContent = `${lastFires.length} detection${lastFires.length>1?'s':''} nearby` +
    (brightest ? ` · brightest ${Math.round(brightest)} K` : '') + ' · source: NASA FIRMS';

  list.innerHTML = '';
  lastFires.slice(0, 5).forEach((f, i) => {
    const miles = Math.round(f.distKm * 0.621371);
    const distColor = miles <= 10 ? '#e67e22' : miles <= 25 ? '#f1c40f' : '#2ecc71';
    const row = document.createElement('div');
    row.className = 'quake-row';
    row.innerHTML = `
      <div class="quake-mag" style="background:#ff5e2a">🔥</div>
      <div class="quake-info">
        <div class="quake-place">Detection #${i+1}</div>
        <div class="quake-time">Detected ${timeAgoFromFirms(f.date, f.time)} · confidence ${confidenceLabel(f.confidence)}${f.frp != null ? ` · FRP ${Math.round(f.frp)} MW` : ''}</div>
      </div>
      <div class="quake-dist" style="color:${distColor}">${miles} mi<span class="sub">${f.dir}</span></div>`;
    list.appendChild(row);
  });
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

/* ---------------- Init ---------------- */
(function initFromUrlOrGeolocate(){
  renderSavedPlaces();
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
