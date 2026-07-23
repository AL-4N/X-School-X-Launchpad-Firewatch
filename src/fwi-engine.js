/**
 * fwi-engine.js
 * ------------------------------------------------------------------
 * Canadian Forest Fire Weather Index (FWI) System
 * Reference: Van Wagner, C.E. (1987). "Development and Structure of the
 * Canadian Forest Fire Weather Index System." Canadian Forestry Service,
 * Forestry Technical Report 35.
 *
 * This is the same fire danger rating methodology used operationally by
 * the Canadian Wildland Fire Information System and adapted by fire
 * agencies worldwide (e.g. EFFIS in Europe). It is a genuine physical
 * model of fuel moisture over time, NOT a simple weighted score — each
 * code represents moisture in a different depth/timescale of forest
 * floor fuel, carried forward day to day.
 *
 * SIX OUTPUTS, in dependency order:
 *   FFMC (Fine Fuel Moisture Code)  — moisture in top ~2cm litter, most
 *                                      responsive to weather (hours)
 *   DMC  (Duff Moisture Code)       — moisture in loosely compacted
 *                                      organic layer 5-10cm deep (~weeks)
 *   DC   (Drought Code)             — deep, slow-drying organic layers
 *                                      10-20cm deep (~months)
 *   ISI  (Initial Spread Index)     — from FFMC + wind: rate of spread
 *   BUI  (Buildup Index)            — from DMC + DC: fuel available
 *   FWI  (Fire Weather Index)       — from ISI + BUI: overall intensity
 *
 * LIMITATIONS (be upfront about these, this is a public-facing tool):
 *  - The real system runs on a continuous daily chain: each day's codes
 *    depend on yesterday's. A cold-start (as here, using only today's
 *    weather) uses the standard reference start values recommended for
 *    spring green-up (FFMC=85, DMC=6, DC=15) rather than true carried-
 *    forward drought memory. DC in particular is a 52-day-memory index,
 *    so a cold start meaningfully understates long-term drought effects.
 *  - Noon local standard time inputs are assumed, per the standard.
 *  - This is a weather-only estimate: it does not account for actual
 *    fuel type, terrain slope/aspect, or vegetation state — those
 *    require the companion Fire Behaviour Prediction (FBP) system.
 * ------------------------------------------------------------------
 */

const FWI_DEFAULTS = {
  // Standard spring start-up values (Van Wagner 1987, Table Annex)
  ffmc0: 85.0,
  dmc0: 6.0,
  dc0: 15.0,
};

/** Fine Fuel Moisture Code
 * @param {number} ffmcPrev - previous day's FFMC (or default start value)
 * @param {number} temp - noon temperature, °C
 * @param {number} rh - noon relative humidity, %
 * @param {number} wind - noon wind speed, km/h
 * @param {number} rain24h - 24h precipitation, mm
 */
function calcFFMC(ffmcPrev, temp, rh, wind, rain24h) {
  rh = Math.min(rh, 100);
  let mo = 147.2 * (101 - ffmcPrev) / (59.5 + ffmcPrev);

  if (rain24h > 0.5) {
    const rf = rain24h - 0.5;
    let mr;
    if (mo <= 150) {
      mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    } else {
      mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf))
             + 0.0015 * Math.pow(mo - 150, 2) * Math.sqrt(rf);
    }
    mo = Math.min(mr, 250);
  }

  const ed = 0.942 * Math.pow(rh, 0.679) + 11 * Math.exp((rh - 100) / 10)
             + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
  const ew = 0.618 * Math.pow(rh, 0.753) + 10 * Math.exp((rh - 100) / 10)
             + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));

  let m;
  if (mo > ed) {
    const ko = 0.424 * (1 - Math.pow(rh / 100, 1.7))
             + 0.0694 * Math.sqrt(wind) * (1 - Math.pow(rh / 100, 8));
    const kd = ko * 0.581 * Math.exp(0.0365 * temp);
    m = ed + (mo - ed) * Math.pow(10, -kd);
  } else if (mo < ew) {
    const k1 = 0.424 * (1 - Math.pow((100 - rh) / 100, 1.7))
             + 0.0694 * Math.sqrt(wind) * (1 - Math.pow((100 - rh) / 100, 8));
    const kw = k1 * 0.581 * Math.exp(0.0365 * temp);
    m = ew - (ew - mo) * Math.pow(10, -kw);
  } else {
    m = mo;
  }

  const ffmc = 59.5 * (250 - m) / (147.2 + m);
  return clamp(ffmc, 0, 101);
}

/** Duff Moisture Code */
function calcDMC(dmcPrev, temp, rh, rain24h, month, latitude) {
  rh = Math.min(rh, 100);
  const t = Math.max(temp, -1.1);
  let pr = dmcPrev;

  if (rain24h > 1.5) {
    const re = 0.92 * rain24h - 1.27;
    const mo = 20 + Math.exp(5.6348 - dmcPrev / 43.43);
    let b;
    if (dmcPrev <= 33) {
      b = 100 / (0.5 + 0.3 * dmcPrev);
    } else if (dmcPrev <= 65) {
      b = 14 - 1.3 * Math.log(dmcPrev);
    } else {
      b = 6.2 * Math.log(dmcPrev) - 17.2;
    }
    const mr = mo + 1000 * re / (48.77 + b * re);
    pr = Math.max(43.43 * (5.6348 - Math.log(mr - 20)), 0);
  }

  const el = dayLengthFactorDMC(month, latitude);
  // Van Wagner 1987 standard drying-rate equation for DMC:
  // K = 1.894 * (temp + 1.1) * (100 - rh) * Le * 1e-6
  const k = 1.894 * (t + 1.1) * (100 - rh) * el * 1e-6;
  const dmc = pr + 100 * k;
  return Math.max(dmc, 0);
}

/** Drought Code */
function calcDC(dcPrev, temp, rain24h, month, latitude) {
  const t = Math.max(temp, -2.8);
  let dr = dcPrev;

  if (rain24h > 2.8) {
    const rd = 0.83 * rain24h - 1.27;
    const Qo = 800 * Math.exp(-dcPrev / 400);
    const Qr = Qo + 3.937 * rd;
    const Dr = 400 * Math.log(800 / Qr);
    dr = Math.max(Dr, 0);
  }

  const lf = dayLengthFactorDC(month, latitude);
  const v = 0.36 * (t + 2.8) + lf;
  const dc = dr + 0.5 * Math.max(v, 0);
  return Math.max(dc, 0);
}

/** Initial Spread Index (from FFMC + wind) */
function calcISI(ffmc, wind) {
  const m = 147.2 * (101 - ffmc) / (59.5 + ffmc);
  const fWind = Math.exp(0.05039 * wind);
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + Math.pow(m, 5.31) / 4.93e7);
  return 0.208 * fWind * fF;
}

/** Buildup Index (from DMC + DC) */
function calcBUI(dmc, dc) {
  let bui;
  if (dmc <= 0.4 * dc) {
    bui = 0.8 * dmc * dc / (dmc + 0.4 * dc);
  } else {
    bui = dmc - (1 - 0.8 * dc / (dmc + 0.4 * dc)) * (0.92 + Math.pow(0.0114 * dmc, 1.7));
  }
  return Math.max(bui, 0);
}

/** Fire Weather Index (from ISI + BUI) — final combined index */
function calcFWI(isi, bui) {
  let fd;
  if (bui <= 80) {
    fd = 0.626 * Math.pow(bui, 0.809) + 2;
  } else {
    fd = 1000 / (25 + 108.64 * Math.exp(-0.023 * bui));
  }
  const b = 0.1 * isi * fd;
  let fwi;
  if (b > 1) {
    fwi = Math.exp(2.72 * Math.pow(0.434 * Math.log(b), 0.647));
  } else {
    fwi = b;
  }
  return fwi;
}

// Day-length adjustment factors by month (Northern Hemisphere defaults;
// mirrored for Southern Hemisphere by 6-month offset), per Van Wagner 1987 Table 4.
function dayLengthFactorDMC(month, latitude) {
  const table = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0];
  const idx = latitude >= 0 ? month : (month + 6) % 12;
  return table[idx];
}
function dayLengthFactorDC(month, latitude) {
  const table = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6];
  const idx = latitude >= 0 ? month : (month + 6) % 12;
  return table[idx];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Danger class per the standard 6-class FWI scale (harmonized internationally,
 * e.g. EFFIS). Thresholds vary slightly by region; these are the commonly
 * cited generalized breakpoints.
 */
function fwiDangerClass(fwi) {
  // NaN fails every numeric comparison below, so without this guard a
  // broken/missing upstream weather value would silently fall through to
  // the final `return` and get reported as "Extreme" — the single worst
  // class — instead of an explicit "unknown." Fail loud, not falsely severe.
  if (!Number.isFinite(fwi)) return { class: 'Unknown', level: 0, hex: '#6B6659' };
  if (fwi < 5.2)  return { class: 'Very Low',  level: 1, hex: '#3B7A57' };
  if (fwi < 11.2) return { class: 'Low',       level: 2, hex: '#5C9C5C' };
  if (fwi < 21.3) return { class: 'Moderate',  level: 3, hex: '#C9A227' };
  if (fwi < 38.0) return { class: 'High',      level: 4, hex: '#D2691E' };
  if (fwi < 50.0) return { class: 'Very High', level: 5, hex: '#B23A2E' };
  return               { class: 'Extreme',   level: 6, hex: '#7A1F1F' };
}

/**
 * Main entry point: compute a full FWI System estimate from a single
 * day's noon weather. Because this is a cold-start (no prior-day carry
 * forward available client-side), it uses standard start-up defaults for
 * the moisture codes' "previous day" inputs. This is explicitly an
 * approximation — see LIMITATIONS above — and is labeled as such in the UI.
 *
 * @param {Object} weather
 * @param {number} weather.temp   - °C, noon
 * @param {number} weather.rh     - %, noon
 * @param {number} weather.wind   - km/h, noon
 * @param {number} weather.rain24h - mm, last 24h
 * @param {number} latitude
 * @param {Date} date
 * @param {Object} [priorCodes] - optional {ffmc, dmc, dc} from a previous
 *   session/day to chain the calculation more accurately over time.
 */
function computeFWI({ temp, rh, wind, rain24h }, latitude, date, priorCodes) {
  const month = date.getMonth(); // 0-11
  const prev = priorCodes || {
    ffmc: FWI_DEFAULTS.ffmc0,
    dmc: FWI_DEFAULTS.dmc0,
    dc: FWI_DEFAULTS.dc0,
  };

  const ffmc = calcFFMC(prev.ffmc, temp, rh, wind, rain24h);
  const dmc = calcDMC(prev.dmc, temp, rh, rain24h, month, latitude);
  const dc = calcDC(prev.dc, temp, rain24h, month, latitude);
  const isi = calcISI(ffmc, wind);
  const bui = calcBUI(dmc, dc);
  const fwi = calcFWI(isi, bui);
  const danger = fwiDangerClass(fwi);

  return {
    codes: { ffmc: round1(ffmc), dmc: round1(dmc), dc: round1(dc) },
    indices: { isi: round1(isi), bui: round1(bui), fwi: round1(fwi) },
    danger,
    isColdStart: !priorCodes,
  };
}

function round1(v) { return Math.round(v * 10) / 10; }

// ES module export for use inside the Cloudflare Worker (import { computeFWI } ...)
export { computeFWI, fwiDangerClass, FWI_DEFAULTS };