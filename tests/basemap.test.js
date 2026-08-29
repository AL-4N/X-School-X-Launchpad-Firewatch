import { describe, it, expect } from 'vitest';
import { basemapProvider, fetchBasemapTile } from '../src/basemap.js';

/**
 * The basemap provider is chosen from the environment: CARTO when a key
 * is configured (proxied so the key stays server-side), Esri otherwise.
 */
describe('basemapProvider', () => {
  it('uses carto when a key is configured', () => {
    expect(basemapProvider({ CARTO_API_KEY: 'abc123' })).toBe('carto');
  });

  it('falls back to esri with no key', () => {
    expect(basemapProvider({})).toBe('esri');
  });

  it('falls back to esri when the key is empty', () => {
    expect(basemapProvider({ CARTO_API_KEY: '' })).toBe('esri');
  });
});

describe('fetchBasemapTile', () => {
  const url = p => new URL(`https://example.com${p}`);

  it('404s when no key is configured — the proxy is carto-only', async () => {
    await expect(fetchBasemapTile(url('/api/basemap/dark/9/87/204'), {}))
      .rejects.toMatchObject({ status: 404 });
  });

  it('rejects an unknown theme', async () => {
    await expect(fetchBasemapTile(url('/api/basemap/purple/9/87/204'), { CARTO_API_KEY: 'k' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects non-numeric tile coordinates', async () => {
    await expect(fetchBasemapTile(url('/api/basemap/dark/a/b/c'), { CARTO_API_KEY: 'k' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects an out-of-range zoom', async () => {
    await expect(fetchBasemapTile(url('/api/basemap/dark/99/87/204'), { CARTO_API_KEY: 'k' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
