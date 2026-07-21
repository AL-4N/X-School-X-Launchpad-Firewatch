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

let map, userMarker, fireLayer, quakeLayer, firmsTileLayer, incidentLayer;
let userLat, userLon;
let aqiSource = 'openmeteo'; // 'openmeteo' | 'openweathermap' — both proxied server-side now
let globalIncidents = [];
let incidentsShownOnMap = false;
let searchDebounceTimer = null;
let lastSearchResults = [];

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

  if(map){ map.remove(); map = null; }
  firmsTileLayer = null;
  incidentLayer = null;
  incidentsShownOnMap = false;
  const incidentsBtn = document.getElementById('incidents-map-btn');
  if(incidentsBtn) incidentsBtn.classList.remove('active');

  initMap();
  if(knownDisplayName){
    document.getElementById('place-name').textContent = knownDisplayName;
  } else {
    loadPlaceName();
  }
  loadWeatherAndRisk();
  loadAirQuality();
  loadFires();
  loadEarthquakes();
  loadFloodRisk();
  loadGlobalIncidents();
  addFirmsTileLayer();
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

function setAqiSource(source){
  aqiSource = source;
  document.querySelectorAll('.aqi-source-toggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.source === source);
  });
  loadAirQuality();
}

/* ---------------- Map ---------------- */

function initMap(){
  map = L.map('map', { zoomControl:true, attributionControl:true }).setView([userLat, userLon], 10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18
  }).addTo(map);

  const userIcon = L.divIcon({
    className:'',
    html:'<div style="width:16px;height:16px;border-radius:50%;background:#4A90D9;border:3px solid #fff;box-shadow:0 0 0 4px rgba(74,144,217,0.3);"></div>',
    iconSize:[16,16], iconAnchor:[8,8]
  });
  userMarker = L.marker([userLat, userLon], {icon:userIcon}).addTo(map);
  fireLayer = L.layerGroup().addTo(map);
  quakeLayer = L.layerGroup().addTo(map);
}

/** FIRMS thermal tile overlay, proxied through the Worker so the key
 * never appears in a tile URL the browser makes directly. */
function addFirmsTileLayer(){
  if(!map || firmsTileLayer) return;
  firmsTileLayer = L.tileLayer(`${WORKER_BASE_URL}/api/fires/tiles/{z}/{x}/{y}`, {
    opacity: 0.85,
    attribution: 'NASA FIRMS',
  });
  firmsTileLayer.addTo(map);
  document.getElementById('firms-tile-toggle-wrap').classList.remove('hidden');
}

let firmsTilesOn = true;
function toggleFirmsTileBtn(){
  firmsTilesOn = !firmsTilesOn;
  const btn = document.getElementById('firms-tile-btn');
  btn.classList.toggle('active', firmsTilesOn);
  if(!firmsTileLayer) return;
  if(firmsTilesOn){ firmsTileLayer.addTo(map); } else { map.removeLayer(firmsTileLayer); }
}

/* ---------------- Location name ---------------- */

async function loadPlaceName(){
  try{
    const data = await api(`/api/geocode?lat=${userLat}&lon=${userLon}`);
    document.getElementById('place-name').textContent = data.displayName;
  }catch(e){
    document.getElementById('place-name').textContent = `${userLat.toFixed(3)}, ${userLon.toFixed(3)}`;
  }
}

/* ---------------- Weather + FWI risk ---------------- */

async function loadWeatherAndRisk(){
  try{
    const data = await api(`/api/risk?lat=${userLat}&lon=${userLon}`);
    const { weather, fwi } = data;

    document.getElementById('w-temp').textContent = `${Math.round(weather.temp)}°C`;
    document.getElementById('w-wind').textContent = `${Math.round(weather.wind)}`;
    document.getElementById('w-humidity').textContent = `${Math.round(weather.humidity)}%`;
    document.getElementById('w-rain').textContent = `${weather.rain7d.toFixed(0)}mm`;

    renderRisk(fwi, weather);
    checkSevereWeather(weather);
  }catch(e){
    console.error(e);
    document.getElementById('place-name').textContent += ' (weather unavailable)';
  }
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
  drawSummaryChip();
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

function drawSummaryChip(){
  const chip = document.getElementById('summary-chip');
  const severeCount = hazardAlertsState.filter(a=>a.level==='severe').length;
  const warnCount = hazardAlertsState.filter(a=>a.level==='warn').length;
  const dot = chip.querySelector('.dot');
  const text = chip.querySelector('.text');

  if(severeCount > 0){
    dot.style.background = 'var(--vhigh)';
    text.textContent = `${severeCount} active severe alert${severeCount>1?'s':''} in your area`;
  } else if(warnCount > 0){
    dot.style.background = 'var(--mod)';
    text.textContent = `${warnCount} advisory in effect — see details below`;
  } else {
    dot.style.background = 'var(--vlow)';
    text.textContent = 'No active hazard alerts for your area right now';
  }
}

/* ---------------- Risk rendering (FWI-driven) ---------------- */

function renderRisk(fwiResult, weather){
  const { codes, indices, danger, isColdStart } = fwiResult;

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
  }
}

function usAqiCategory(aqi){
  if(aqi <= 50) return { label:'GOOD', hex:'#3B7A57', desc:'Air quality is satisfactory.' };
  if(aqi <= 100) return { label:'MODERATE', hex:'#C9A227', desc:'Acceptable, but a concern for unusually sensitive people.' };
  if(aqi <= 150) return { label:'UNHEALTHY (SENSITIVE)', hex:'#D2691E', desc:'Sensitive groups may experience health effects.' };
  if(aqi <= 200) return { label:'UNHEALTHY', hex:'#B23A2E', desc:'Everyone may begin to experience health effects.' };
  if(aqi <= 300) return { label:'VERY UNHEALTHY', hex:'#8B2942', desc:'Health alert — everyone may experience serious effects.' };
  return { label:'HAZARDOUS', hex:'#5C1A2E', desc:'Emergency conditions — entire population at risk.' };
}

function owmAqiCategory(level){
  const map = {
    1: { label:'GOOD', hex:'#3B7A57', desc:'Air quality is good.' },
    2: { label:'FAIR', hex:'#5C9C5C', desc:'Air quality is acceptable.' },
    3: { label:'MODERATE', hex:'#C9A227', desc:'Sensitive groups may notice effects.' },
    4: { label:'POOR', hex:'#D2691E', desc:'Health effects may be experienced by most people.' },
    5: { label:'VERY POOR', hex:'#7A1F1F', desc:'Health warning of emergency conditions.' },
  };
  return map[level] || map[1];
}

function renderAQI_US(aqi, pm25, sourceLabel){
  const cat = usAqiCategory(aqi);
  document.getElementById('aqi-num').textContent = aqi;
  document.getElementById('aqi-num').style.color = cat.hex;
  const label = document.getElementById('aqi-label');
  label.textContent = cat.label;
  label.style.background = cat.hex;
  const pmText = pm25 != null ? ` PM2.5 is ${Math.round(pm25)} µg/m³.` : '';
  document.getElementById('aqi-desc').textContent = `${cat.desc}${pmText} Source: ${sourceLabel}, US AQI scale.`;
  updateHazards('aqi', aqi > 150 ? [{
    level: aqi > 200 ? 'severe' : 'warn', icon:'😷',
    title: aqi > 200 ? 'Unhealthy Air Quality' : 'Air Quality Advisory',
    text: 'Poor air quality may indicate nearby smoke or pollution — consider limiting outdoor exposure.'
  }] : []);
}

function renderAQI_OWM(level, components){
  const cat = owmAqiCategory(level);
  document.getElementById('aqi-num').textContent = level;
  document.getElementById('aqi-num').style.color = cat.hex;
  const label = document.getElementById('aqi-label');
  label.textContent = cat.label;
  label.style.background = cat.hex;
  const pm25 = components?.pm2_5;
  const pmText = pm25 != null ? ` PM2.5 is ${pm25.toFixed(1)} µg/m³.` : '';
  document.getElementById('aqi-desc').textContent = `${cat.desc}${pmText} Source: OpenWeatherMap, 1–5 scale.`;
  updateHazards('aqi', level >= 4 ? [{
    level: level === 5 ? 'severe' : 'warn', icon:'😷',
    title: level === 5 ? 'Unhealthy Air Quality' : 'Air Quality Advisory',
    text: 'Poor air quality may indicate nearby smoke or pollution — consider limiting outdoor exposure.'
  }] : []);
}

/* ---------------- Fires (NASA FIRMS, via Worker) ---------------- */

async function loadFires(){
  if(!map) return;
  try{
    const data = await api(`/api/fires?lat=${userLat}&lon=${userLon}`);
    fireLayer.clearLayers();
    data.fires.forEach(f=>{
      L.circleMarker([f.lat, f.lon], {
        radius:6, color:'#FF5A36', fillColor:'#FF5A36', fillOpacity:0.7, weight:1
      }).addTo(fireLayer);
    });
    const note = document.getElementById('fires-count-note');
    note.textContent = data.count > 0
      ? `${data.count} fire detection${data.count>1?'s':''} within ~65km (last 24h)`
      : 'No fire detections within ~65km in the last 24h';
    note.classList.remove('hidden');
  }catch(e){
    console.error('Fire data load failed', e);
    const note = document.getElementById('fires-count-note');
    note.textContent = 'Fire detection data temporarily unavailable';
    note.classList.remove('hidden');
  }
}

/* ---------------- Earthquakes (USGS, via Worker) ---------------- */

async function loadEarthquakes(){
  try{
    const data = await api(`/api/earthquakes?lat=${userLat}&lon=${userLon}`);
    renderQuakes(data.earthquakes.slice(0, 5));
  }catch(e){
    console.error(e);
    document.getElementById('quake-list').innerHTML = '<div class="empty-note">Earthquake data unavailable right now.</div>';
  }
}

function quakeColor(mag){
  if(mag >= 6) return '#7A1F1F';
  if(mag >= 4.5) return '#D2691E';
  return '#B8860B';
}

function renderQuakes(quakes){
  const list = document.getElementById('quake-list');
  if(!quakes.length){
    list.innerHTML = '<div class="empty-note">No earthquakes above magnitude 2.5 within 500km in the past 7 days.</div>';
    if(quakeLayer) quakeLayer.clearLayers();
    return;
  }
  list.innerHTML = '';
  if(quakeLayer) quakeLayer.clearLayers();

  quakes.forEach(q=>{
    const mag = q.mag?.toFixed(1) ?? '?';
    const place = q.place || 'Unknown location';
    const time = new Date(q.time);
    const timeStr = time.toLocaleDateString([], {month:'short', day:'numeric'}) + ' · ' + time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const color = quakeColor(q.mag || 0);

    const row = document.createElement('div');
    row.className = 'quake-row';
    row.innerHTML = `
      <div class="quake-mag" style="background:${color}">${mag}</div>
      <div class="quake-info">
        <div class="quake-place">${place}</div>
        <div class="quake-time">${timeStr} · ${q.distKm}km away</div>
      </div>`;
    list.appendChild(row);

    if(map && quakeLayer){
      L.circleMarker([q.lat, q.lon], {
        radius: 5 + (q.mag || 2), color, fillColor: color, fillOpacity:0.5, weight:1.5
      }).addTo(quakeLayer);
    }
  });

  const big = quakes.find(q => q.mag >= 5 && q.distKm <= 200);
  updateHazards('quake', big ? [{
    level:'severe', icon:'🌍',
    title:'Recent Significant Earthquake',
    text: `Magnitude ${big.mag.toFixed(1)} within ${big.distKm}km — check local advisories for aftershock risk.`
  }] : []);
}

/* ---------------- River flood risk (via Worker) ---------------- */

async function loadFloodRisk(){
  try{
    const data = await api(`/api/flood?lat=${userLat}&lon=${userLon}`);
    if(!data.hasData){
      document.getElementById('flood-card').innerHTML = 'No river gauge data is available for this exact location — this typically means you\'re not near a major waterway tracked by the model.';
      return;
    }
    const { discharge, mean } = data;
    const ratio = discharge / (mean || 1);
    let status, desc;
    if(ratio >= 2){ status = 'Elevated'; desc = 'Current river discharge is well above the historical average — a sign of possible flood risk downstream.'; }
    else if(ratio >= 1.3){ status = 'Slightly elevated'; desc = 'River discharge is somewhat above the historical average.'; }
    else { status = 'Normal'; desc = 'River discharge near this location is within its typical historical range.'; }

    document.getElementById('flood-card').innerHTML =
      `<b>${status}</b> — ${desc} Current discharge: ${discharge.toFixed(1)} m³/s (average: ${mean.toFixed(1)} m³/s).`;

    updateHazards('flood', ratio >= 2 ? [{
      level:'warn', icon:'🌊',
      title:'Elevated River Discharge',
      text:'Nearby river levels are significantly above average — monitor local flood advisories.'
    }] : []);
  }catch(e){
    console.error(e);
    document.getElementById('flood-card').textContent = 'River flood data unavailable for this location.';
  }
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
      <div class="quake-mag" style="background:${inc.isClosed ? '#6B6659' : '#D2691E'}">🔥</div>
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
        radius: 5, color: inc.isClosed ? '#9C978A' : '#FF5A36',
        fillColor: inc.isClosed ? '#9C978A' : '#FF5A36', fillOpacity:0.75, weight:1
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
requestLocation();
