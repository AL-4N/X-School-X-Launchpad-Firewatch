import { describe, it, expect } from 'vitest';
import { tileToBBox } from '../src/tiles.js';

/**
 * tileToBBox converts an XYZ tile coordinate to the WGS84 bbox that the
 * FIRMS WMS endpoint expects. Zoom 0 is the whole world; Web Mercator
 * clips latitude at ±85.051°.
 */
describe('tileToBBox', () => {
  it('maps the zoom-0 tile to the whole world', () => {
    const [lonMin, latMin, lonMax, latMax] = tileToBBox(0, 0, 0);
    expect(lonMin).toBe(-180);
    expect(lonMax).toBe(180);
    expect(latMin).toBeCloseTo(-85.0511, 3);
    expect(latMax).toBeCloseTo(85.0511, 3);
  });

  it('splits zoom 1 into four quadrants covering the world', () => {
    expect(tileToBBox(0, 0, 1).slice(0, 1)).toEqual([-180]); // NW starts at -180
    expect(tileToBBox(1, 0, 1)[0]).toBe(0);                  // NE starts at the meridian
    expect(tileToBBox(1, 0, 1)[2]).toBe(180);                // ...and ends at +180
  });

  it('puts latMin below latMax and lonMin below lonMax', () => {
    const [lonMin, latMin, lonMax, latMax] = tileToBBox(3, 5, 4);
    expect(lonMin).toBeLessThan(lonMax);
    expect(latMin).toBeLessThan(latMax);
  });

  // The map wraps horizontally, so Leaflet can request x values outside
  // [0, 2^z). Those must fold back onto the real world copy rather than
  // producing an out-of-range bbox that FIRMS rejects.
  it('normalizes x from wrapped world copies', () => {
    expect(tileToBBox(5, 1, 2)).toEqual(tileToBBox(1, 1, 2));
    expect(tileToBBox(-1, 1, 2)).toEqual(tileToBBox(3, 1, 2));
  });
});
