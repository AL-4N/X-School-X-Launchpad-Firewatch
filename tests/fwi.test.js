import { describe, it, expect } from 'vitest';
import { computeFwiSystem } from '../src/fwi.js';

describe('computeFwiSystem', () => {
  // ---- output shape ----
  it('returns the expected output shape with all required keys', () => {
    const result = computeFwiSystem({ temp: 20, rh: 50, wind: 20, rain24h: 0, month: 5 });
    expect(result).toHaveProperty('codes');
    expect(result).toHaveProperty('indices');
    expect(result).toHaveProperty('danger');
    expect(result).toHaveProperty('isColdStart');

    expect(result.codes).toHaveProperty('ffmc');
    expect(result.codes).toHaveProperty('dmc');
    expect(result.codes).toHaveProperty('dc');

    expect(result.indices).toHaveProperty('isi');
    expect(result.indices).toHaveProperty('bui');
    expect(result.indices).toHaveProperty('fwi');

    expect(result.danger).toHaveProperty('level');
    expect(result.danger).toHaveProperty('hex');
    expect(result.danger).toHaveProperty('class');
  });

  // ---- isColdStart flag ----
  it('sets isColdStart:true when prevCodes is not supplied', () => {
    const result = computeFwiSystem({ temp: 25, rh: 40, wind: 15, rain24h: 0, month: 5 });
    expect(result.isColdStart).toBe(true);
  });

  it('sets isColdStart:false when prevCodes is supplied', () => {
    const result = computeFwiSystem({
      temp: 35, rh: 20, wind: 50, rain24h: 0, month: 5,
      prevCodes: { ffmc: 92, dmc: 40, dc: 200 },
    });
    expect(result.isColdStart).toBe(false);
  });

  // ---- fire-danger thresholds ----
  it('produces a high FWI (>15) for hot, dry, and windy conditions', () => {
    const result = computeFwiSystem({ temp: 35, rh: 20, wind: 50, rain24h: 0, month: 6 });
    expect(result.indices.fwi).toBeGreaterThan(15);
  });

  it('produces a low FWI (<5) for cool, wet conditions', () => {
    const result = computeFwiSystem({ temp: 10, rh: 90, wind: 5, rain24h: 20, month: 3 });
    expect(result.indices.fwi).toBeLessThan(5);
  });

  it('produces a very high FWI (>20) for extreme conditions', () => {
    const result = computeFwiSystem({ temp: 40, rh: 5, wind: 80, rain24h: 0, month: 7 });
    expect(result.indices.fwi).toBeGreaterThan(20);
  });

  // ---- zero-wind case ----
  it('returns a valid non-null output when wind is zero', () => {
    const result = computeFwiSystem({ temp: 30, rh: 30, wind: 0, rain24h: 0, month: 7 });
    expect(result).not.toBeNull();
    expect(Number.isFinite(result.indices.fwi)).toBe(true);
    expect(result.indices.fwi).toBeGreaterThanOrEqual(0);
  });

  // ---- prevCodes carry-forward ----
  it('uses supplied prevCodes instead of cold-start defaults', () => {
    const coldStart = computeFwiSystem({ temp: 35, rh: 20, wind: 50, rain24h: 0, month: 6 });
    const withPrev = computeFwiSystem({
      temp: 35, rh: 20, wind: 50, rain24h: 0, month: 6,
      prevCodes: { ffmc: 92, dmc: 40, dc: 200 },
    });
    // With elevated prevCodes the FWI should be at least as high (typically higher)
    // and the codes should differ from the cold-start run.
    expect(withPrev.codes.dc).toBeGreaterThan(coldStart.codes.dc);
  });

  // ---- numeric output sanity ----
  it('rounds outputs to one decimal place', () => {
    const result = computeFwiSystem({ temp: 25, rh: 45, wind: 20, rain24h: 0, month: 5 });
    const oneDecimal = (v) => /^\d+(\.\d)?$/.test(String(v));
    expect(oneDecimal(result.codes.ffmc)).toBe(true);
    expect(oneDecimal(result.indices.fwi)).toBe(true);
  });

  // ---- danger.class matches fwi level ----
  it('labels cool-wet result as Very Low danger class', () => {
    const result = computeFwiSystem({ temp: 10, rh: 90, wind: 5, rain24h: 20, month: 3 });
    expect(result.danger.class).toBe('Very Low');
    expect(result.danger.level).toBe(0);
  });

  it('labels extreme conditions with High or higher danger class', () => {
    const result = computeFwiSystem({ temp: 40, rh: 5, wind: 80, rain24h: 0, month: 7 });
    expect(result.danger.level).toBeGreaterThanOrEqual(3);
  });
});
