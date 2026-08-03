import { describe, it, expect } from 'vitest';
import { requireLatLon } from '../src/index.js';

/**
 * requireLatLon(url) expects a WHATWG URL object (url.searchParams).
 * We build minimal URL objects from a base string so we don't need a
 * real Cloudflare Worker runtime — the built-in Node URL class is
 * identical to the Web API URL used by Workers.
 */
function makeUrl(params) {
  const base = new URL('https://example.com/api/risk');
  for (const [k, v] of Object.entries(params)) {
    base.searchParams.set(k, v);
  }
  return base;
}

describe('requireLatLon', () => {
  // ---- valid inputs ----
  it('returns {lat, lon} for a valid coordinate pair', () => {
    const result = requireLatLon(makeUrl({ lat: '37.7749', lon: '-122.4194' }));
    expect(result.lat).toBeCloseTo(37.7749);
    expect(result.lon).toBeCloseTo(-122.4194);
  });

  it('accepts boundary value lat=90, lon=180', () => {
    const result = requireLatLon(makeUrl({ lat: '90', lon: '180' }));
    expect(result.lat).toBe(90);
    expect(result.lon).toBe(180);
  });

  it('accepts boundary value lat=-90, lon=-180', () => {
    const result = requireLatLon(makeUrl({ lat: '-90', lon: '-180' }));
    expect(result.lat).toBe(-90);
    expect(result.lon).toBe(-180);
  });

  // ---- missing params ----
  it('throws when lat is missing', () => {
    expect(() => requireLatLon(makeUrl({ lon: '-122.4194' }))).toThrow();
  });

  it('throws a status-400 error when lat is missing', () => {
    try {
      requireLatLon(makeUrl({ lon: '-122.4194' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  it('throws when lon is missing', () => {
    expect(() => requireLatLon(makeUrl({ lat: '37.7749' }))).toThrow();
  });

  // ---- non-numeric values ----
  it('throws for non-numeric lat (status 400)', () => {
    try {
      requireLatLon(makeUrl({ lat: 'abc', lon: '0' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  it('throws for non-numeric lon (status 400)', () => {
    try {
      requireLatLon(makeUrl({ lat: '0', lon: 'xyz' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  // ---- out-of-range values ----
  it('throws for lat=91 (out of range)', () => {
    expect(() => requireLatLon(makeUrl({ lat: '91', lon: '0' }))).toThrow();
  });

  it('throws for lat=-91 (out of range)', () => {
    expect(() => requireLatLon(makeUrl({ lat: '-91', lon: '0' }))).toThrow();
  });

  it('throws for lon=181 (out of range)', () => {
    expect(() => requireLatLon(makeUrl({ lat: '0', lon: '181' }))).toThrow();
  });

  it('throws for lon=-181 (out of range)', () => {
    expect(() => requireLatLon(makeUrl({ lat: '0', lon: '-181' }))).toThrow();
  });

  it('throws with status 400 for out-of-range coordinates', () => {
    try {
      requireLatLon(makeUrl({ lat: '91', lon: '0' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });
});
