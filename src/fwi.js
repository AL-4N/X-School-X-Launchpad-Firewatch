/**
 * fwi.js — Canadian Forest Fire Weather Index (FWI) System
 * Van Wagner, C.E. (1987). "Development and Structure of the Canadian
 * Forest Fire Weather Index System." Canadian Forestry Service, Forestry
 * Technical Report 35.
 *
 * This is a real implementation of the operational equations (the same
 * ones used by Canadian/European fire agencies), not an approximation.
 * It's a "cold start" implementation: without multi-day carried-forward
 * moisture codes from the previous day, FFMC/DMC/DC start from standard
 * summer startup values each time rather than true day-over-day
 * persistence. That's flagged to the frontend via `isColdStart` so the
 * UI can be honest about the limitation (deep-drought DC effects in
 * particular are understated without carried-forward history).
 *
 * Inputs (noon local standard time observations, per the spec):
 *   temp      — temperature, °C
 *   rh        — relative humidity, %
 *   wind      — wind speed, km/h
 *   rain24h   — 24h rainfall, mm
 *
 * Standard summer startup values (per the Canadian FWI System
 * documentation, used when no previous day's codes are available):
 *   FFMC0 = 85, DMC0 = 6, DC0 = 15
 */

const FFMC0 = 85;
const DMC0 = 6;
const DC0 = 15;

/** Fine Fuel Moisture Code — moisture of litter/fine fuels, ~day-lag. */
function computeFFMC(ffmcPrev, temp, rh, wind, rain){
  let mo = 147.2 * (101 - ffmcPrev) / (59.5 + ffmcPrev);

  if(rain > 0.5){
    const rf = rain - 0.5;
    let mr;
    if(mo <= 150){
      mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    } else {
      mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf))
        + 0.0015 * Math.pow(mo - 150, 2) * Math.sqrt(rf);
    }
    mo = Math.min(mr, 250);
  }

  const ed = 0.942 * Math.pow(rh, 0.679) + 11 * Math.exp((rh - 100) / 10)
    + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));

  let m;
  if(mo > ed){
    const ko = 0.424 * (1 - Math.pow(rh / 100, 1.7)) + 0.0694 * Math.sqrt(wind) * (1 - Math.pow(rh / 100, 8));
    const kd = ko * 0.581 * Math.exp(0.0365 * temp);
    m = ed + (mo - ed) * Math.pow(10, -kd);
  } else {
    const ew = 0.618 * Math.pow(rh, 0.753) + 10 * Math.exp((rh - 100) / 10)
      + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
    if(mo < ew){
      const kw = 0.424 * (1 - Math.pow((100 - rh) / 100, 1.7)) + 0.0694 * Math.sqrt(wind) * (1 - Math.pow((100 - rh) / 100, 8));
      const kw2 = kw * 0.581 * Math.exp(0.0365 * temp);
      m = ew - (ew - mo) * Math.pow(10, -kw2);
    } else {
      m = mo;
    }
  }

  const ffmc = 59.5 * (250 - m) / (147.2 + m);
  return clamp(ffmc, 0, 101);
}

/** Duff Moisture Code — moisture of loosely-compacted organic layers, ~week-lag. */
function computeDMC(dmcPrev, temp, rh, rain, month){
  const el = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0]; // day-length factor by month (northern-hemisphere default)
  let pr = dmcPrev;

  if(rain > 1.5){
    const re = 0.92 * rain - 1.27;
    const mo = 20 + Math.exp(5.6348 - dmcPrev / 43.43);
    let b;
    if(dmcPrev <= 33) b = 100 / (0.5 + 0.3 * dmcPrev);
    else if(dmcPrev <= 65) b = 14 - 1.3 * Math.log(dmcPrev);
    else b = 6.2 * Math.log(dmcPrev) - 17.2;
    const mr = mo + 1000 * re / (48.77 + b * re);
    pr = Math.max(0, 43.43 * (5.6348 - Math.log(mr - 20)));
  }

  const t = Math.max(temp, -1.1);
  const k = 1.894 * (t + 1.1) * (100 - rh) * el[month] * 1e-4;
  const dmc = pr + k;
  return Math.max(0, dmc);
}

/** Drought Code — deep soil moisture, ~seasonal-lag. Tracks long-term drought. */
function computeDC(dcPrev, temp, rain, month){
  const fl = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6]; // day-length factor by month
  let dr = dcPrev;

  if(rain > 2.8){
    const rd = 0.83 * rain - 1.27;
    const qo = 800 * Math.exp(-dcPrev / 400);
    const qr = qo + 3.937 * rd;
    dr = Math.max(0, 400 * Math.log(800 / qr));
  }

  const t = Math.max(temp, -2.8);
  const v = Math.max(0, 0.36 * (t + 2.8) + fl[month]);
  const dc = dr + 0.5 * v;
  return Math.max(0, dc);
}

/** Initial Spread Index — combines wind + FFMC into early fire-spread rate. */
function computeISI(ffmc, wind){
  const m = 147.2 * (101 - ffmc) / (59.5 + ffmc);
  const fWind = Math.exp(0.05039 * wind);
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + Math.pow(m, 5.31) / 4.93e7);
  return 0.208 * fWind * fF;
}

/** Buildup Index — combines DMC + DC into total fuel available to burn. */
function computeBUI(dmc, dc){
  if(dmc === 0 && dc === 0) return 0;
  if(dmc <= 0.4 * dc){
    return (0.8 * dmc * dc) / (dmc + 0.4 * dc);
  }
  return dmc - (1 - 0.8 * dc / (dmc + 0.4 * dc)) * (0.92 + Math.pow(0.0114 * dmc, 1.7));
}

/** Fire Weather Index — combines ISI + BUI into overall fire intensity potential. */
function computeFWI(isi, bui){
  let fD;
  if(bui <= 80){
    fD = 0.626 * Math.pow(bui, 0.809) + 2;
  } else {
    fD = 1000 / (25 + 108.64 * Math.exp(-0.023 * bui));
  }
  const b = 0.1 * isi * fD;
  if(b <= 1) return b;
  return Math.exp(2.72 * Math.pow(0.434 * Math.log(b), 0.647));
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/** Danger-class lookup used consistently across the UI (level 0-5, hex, label). */
function dangerClass(fwi){
  if(fwi < 5) return { level: 0, hex: '#3B7A57', class: 'Very Low' };
  if(fwi < 9) return { level: 1, hex: '#5C9C5C', class: 'Low' };
  if(fwi < 15) return { level: 2, hex: '#C9A227', class: 'Moderate' };
  if(fwi < 21) return { level: 3, hex: '#D2691E', class: 'High' };
  if(fwi < 34) return { level: 4, hex: '#B23A2E', class: 'Very High' };
  return { level: 5, hex: '#7A1F1F', class: 'Extreme' };
}

/**
 * Computes the full FWI System output for a single day.
 *
 * `prevCodes` (optional) is yesterday's { ffmc, dmc, dc } for this same
 * location — when supplied (via the Worker's KV-backed carry-forward
 * cache), DMC and DC accumulate realistically across days the way real
 * fire agencies compute them, instead of resetting from standard
 * startup values every request. `isColdStart` in the response tells the
 * frontend which mode was actually used.
 *
 * `rain24h` should be the most recent 24h rainfall total, and `month` is
 * 0-indexed (0=Jan) to select the correct day-length factors for DMC/DC.
 */
export function computeFwiSystem({ temp, rh, wind, rain24h, month, prevCodes }){
  const isColdStart = !prevCodes;
  const ffmcPrev = prevCodes?.ffmc ?? FFMC0;
  const dmcPrev = prevCodes?.dmc ?? DMC0;
  const dcPrev = prevCodes?.dc ?? DC0;

  const ffmc = computeFFMC(ffmcPrev, temp, rh, wind, rain24h);
  const dmc = computeDMC(dmcPrev, temp, rh, rain24h, month);
  const dc = computeDC(dcPrev, temp, rain24h, month);
  const isi = computeISI(ffmc, wind);
  const bui = computeBUI(dmc, dc);
  const fwi = computeFWI(isi, bui);

  const danger = dangerClass(fwi);

  return {
    codes: {
      ffmc: Math.round(ffmc * 10) / 10,
      dmc: Math.round(dmc * 10) / 10,
      dc: Math.round(dc * 10) / 10,
    },
    indices: {
      isi: Math.round(isi * 10) / 10,
      bui: Math.round(bui * 10) / 10,
      fwi: Math.round(fwi * 10) / 10,
    },
    danger,
    isColdStart,
  };
}
