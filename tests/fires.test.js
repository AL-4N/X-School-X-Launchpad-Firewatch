import { describe, it, expect } from 'vitest';
import { haversineKm, parseFirmsCsv, tileToBBox } from '../src/fires.js';

// ---------------------------------------------------------------------------
// haversineKm
// ---------------------------------------------------------------------------
describe('haversineKm', () => {
  it('returns ~559 km between San Francisco and Los Angeles', () => {
    const km = haversineKm(37.7749, -122.4194, 34.0522, -118.2437);
    expect(km).toBeGreaterThan(559 * 0.99);
    expect(km).toBeLessThan(559 * 1.01);
  });

  it('returns ~5570 km between New York and London', () => {
    const km = haversineKm(40.7128, -74.0060, 51.5074, -0.1278);
    expect(km).toBeGreaterThan(5570 * 0.99);
    expect(km).toBeLessThan(5570 * 1.01);
  });

  it('returns 0 km for the same point', () => {
    const km = haversineKm(37.7749, -122.4194, 37.7749, -122.4194);
    expect(km).toBeCloseTo(0, 6);
  });

  it('returns 0.3–0.5 km for two points 0.004° apart in latitude', () => {
    const km = haversineKm(0, 0, 0.004, 0);
    expect(km).toBeGreaterThan(0.3);
    expect(km).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// parseFirmsCsv
// ---------------------------------------------------------------------------
describe('parseFirmsCsv', () => {
  const HEADER = 'latitude,longitude,confidence,frp';
  const ROW1   = '37.77,-122.42,high,12.5';
  const ROW2   = '34.05,-118.24,nominal,8.1';

  it('parses a normal CSV and returns correct rows', () => {
    const csv = [HEADER, ROW1, ROW2].join('\n');
    const rows = parseFirmsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].latitude).toBe('37.77');
    expect(rows[0].longitude).toBe('-122.42');
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].frp).toBe('12.5');
    expect(rows[1].latitude).toBe('34.05');
  });

  it('handles Windows-style line endings (CRLF)', () => {
    const csv = [HEADER, ROW1, ROW2].join('\r\n');
    const rows = parseFirmsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].latitude).toBe('37.77');
  });

  it('throws when the latitude header column is missing', () => {
    const csv = 'brightness,confidence,frp\n350,high,12.5';
    expect(() => parseFirmsCsv(csv)).toThrow();
  });

  it('throws when the longitude header column is missing', () => {
    const csv = 'latitude,confidence,frp\n37.77,high,12.5';
    expect(() => parseFirmsCsv(csv)).toThrow();
  });

  it('returns an empty array for an empty string', () => {
    expect(parseFirmsCsv('')).toEqual([]);
  });

  it('returns an empty array for a header-only CSV (no data rows)', () => {
    expect(parseFirmsCsv(HEADER)).toEqual([]);
  });

  it('returns the row with the raw string when a latitude value is non-numeric', () => {
    const csv = [HEADER, 'not-a-number,-122.42,high,5.0'].join('\n');
    const rows = parseFirmsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBe('not-a-number');
  });

  it('throws for a FIRMS plain-text error response (no latitude header)', () => {
    expect(() => parseFirmsCsv('Invalid MAP_KEY')).toThrow(/FIRMS returned unexpected response/);
  });
});

// ---------------------------------------------------------------------------
// tileToBBox
// ---------------------------------------------------------------------------
describe('tileToBBox', () => {
  it('produces approximately 1-degree offsets in each direction at the equator', () => {
    const bbox = tileToBBox(0, 0, 111);
    // dLat = 111/111 = 1; dLon = 111/(111*cos(0)) ≈ 1
    expect(bbox.north).toBeCloseTo(1, 1);
    expect(bbox.south).toBeCloseTo(-1, 1);
    expect(bbox.east).toBeCloseTo(1, 1);
    expect(bbox.west).toBeCloseTo(-1, 1);
  });

  it('produces a wider longitude spread at 60°N than at the equator', () => {
    const equator = tileToBBox(0, 0, 111);
    const highLat  = tileToBBox(60, 0, 111);
    // dLon grows as cos(lat) shrinks
    const dLonEquator = equator.east - 0;
    const dLonHigh    = highLat.east  - 0;
    expect(dLonHigh).toBeGreaterThan(dLonEquator * 1.5);
  });

  it('always produces south < north', () => {
    for (const lat of [-60, 0, 60]) {
      const bbox = tileToBBox(lat, 0, 50);
      expect(bbox.south).toBeLessThan(bbox.north);
    }
  });

  it('always produces west < east', () => {
    for (const lon of [-100, 0, 100]) {
      const bbox = tileToBBox(0, lon, 50);
      expect(bbox.west).toBeLessThan(bbox.east);
    }
  });

  it('clamps longitude expansion near poles (cos floor at 0.15)', () => {
    // At lat=89° cos is tiny; the clamp prevents runaway dLon
    const bbox = tileToBBox(89, 0, 111);
    const dLon = bbox.east - 0;
    // With cos clamped to 0.15: dLon = 111/(111*0.15) ≈ 6.67
    expect(dLon).toBeCloseTo(111 / (111 * 0.15), 1);
  });
});
