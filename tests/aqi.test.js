import { describe, it, expect } from 'vitest';
import { usAqiLevel, owmAqiLevel } from '../src/aqi-categories.js';

describe('usAqiLevel', () => {
  // ---- boundary values (off-by-one coverage) ----
  it('returns level 0 at the top of the Good band (aqi=50)', () => {
    expect(usAqiLevel(50).level).toBe(0);
  });

  it('returns level 1 at the start of the Moderate band (aqi=51)', () => {
    expect(usAqiLevel(51).level).toBe(1);
  });

  it('returns level 1 at the top of the Moderate band (aqi=100)', () => {
    expect(usAqiLevel(100).level).toBe(1);
  });

  it('returns level 2 at the start of the USG band (aqi=101)', () => {
    expect(usAqiLevel(101).level).toBe(2);
  });

  it('returns level 2 at the top of the USG band (aqi=150)', () => {
    expect(usAqiLevel(150).level).toBe(2);
  });

  it('returns level 3 at the start of the Unhealthy band (aqi=151)', () => {
    expect(usAqiLevel(151).level).toBe(3);
  });

  it('returns level 3 at the top of the Unhealthy band (aqi=200)', () => {
    expect(usAqiLevel(200).level).toBe(3);
  });

  it('returns level 4 at the start of the Very Unhealthy band (aqi=201)', () => {
    expect(usAqiLevel(201).level).toBe(4);
  });

  it('returns level 4 at the top of the Very Unhealthy band (aqi=300)', () => {
    expect(usAqiLevel(300).level).toBe(4);
  });

  it('returns level 5 for Hazardous (aqi=301)', () => {
    expect(usAqiLevel(301).level).toBe(5);
  });

  it('returns level 5 for very high Hazardous values (aqi=500)', () => {
    expect(usAqiLevel(500).level).toBe(5);
  });

  // ---- hex colour spot-checks ----
  it('returns #2ecc71 (green) for Good air quality (aqi=25)', () => {
    expect(usAqiLevel(25).hex).toBe('#2ecc71');
  });

  it('returns #c0392b (dark red) for Hazardous air quality (aqi=400)', () => {
    expect(usAqiLevel(400).hex).toBe('#c0392b');
  });

  // ---- zero / negative (treat as Good) ----
  it('returns level 0 for aqi=0', () => {
    expect(usAqiLevel(0).level).toBe(0);
  });
});

describe('owmAqiLevel', () => {
  it('returns level 0 for OWM scale 1 (Good)', () => {
    const r = owmAqiLevel(1);
    expect(r.level).toBe(0);
    expect(r.hex).toBe('#2ecc71');
  });

  it('returns level 1 for OWM scale 2 (Fair)', () => {
    const r = owmAqiLevel(2);
    expect(r.level).toBe(1);
    expect(r.hex).toBe('#f1c40f');
  });

  it('returns level 2 for OWM scale 3 (Moderate)', () => {
    const r = owmAqiLevel(3);
    expect(r.level).toBe(2);
    expect(r.hex).toBe('#e67e22');
  });

  it('returns level 3 for OWM scale 4 (Poor)', () => {
    const r = owmAqiLevel(4);
    expect(r.level).toBe(3);
    expect(r.hex).toBe('#e74c3c');
  });

  it('returns level 4 for OWM scale 5 (Very Poor)', () => {
    const r = owmAqiLevel(5);
    expect(r.level).toBe(4);
    expect(r.hex).toBe('#8e44ad');
  });

  it('falls back to #aaa hex for an out-of-range OWM level', () => {
    const r = owmAqiLevel(99);
    expect(r.hex).toBe('#aaa');
  });
});
