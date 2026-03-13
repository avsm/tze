import { describe, it, expect, vi } from 'vitest';
import { TesseraSource } from '../tessera-source.js';

describe('TesseraSource', () => {
  it('constructor sets defaults (metadata null, embeddingRegion null, tileCount 0)', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.metadata).toBeNull();
    expect(source.embeddingRegion).toBeNull();
    expect(source.tileCount).toBe(0);
  });

  it('regionHasTile returns false when no region exists', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.regionHasTile(0, 0)).toBe(false);
    expect(source.regionHasTile(5, 10)).toBe(false);
  });

  it('clearRegion is safe to call with no region', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(() => source.clearRegion()).not.toThrow();
    expect(source.embeddingRegion).toBeNull();
  });

  it('event system is wired up (can on/off without error)', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    const cb = vi.fn();

    // on/off should not throw
    expect(() => source.on('metadata-loaded', cb)).not.toThrow();
    expect(() => source.off('metadata-loaded', cb)).not.toThrow();

    // Multiple event types
    expect(() => source.on('chunk-loaded', cb)).not.toThrow();
    expect(() => source.on('embedding-progress', cb)).not.toThrow();
    expect(() => source.on('error', cb)).not.toThrow();
    expect(() => source.on('loading', cb)).not.toThrow();
    expect(() => source.on('debug', cb)).not.toThrow();
    expect(() => source.on('embeddings-loaded', cb)).not.toThrow();

    // Clean up
    source.off('chunk-loaded', cb);
    source.off('embedding-progress', cb);
    source.off('error', cb);
    source.off('loading', cb);
    source.off('debug', cb);
    source.off('embeddings-loaded', cb);
  });

  it('close is safe to call before open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(() => source.close()).not.toThrow();
    expect(source.metadata).toBeNull();
    expect(source.embeddingRegion).toBeNull();
  });

  it('getEmbeddingAt returns null when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.getEmbeddingAt(13.4, 52.5)).toBeNull();
  });

  it('getEmbeddingsInKernel returns empty array when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.getEmbeddingsInKernel(13.4, 52.5, 3)).toEqual([]);
  });

  it('getChunkAtLngLat returns null when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.getChunkAtLngLat(13.4, 52.5)).toBeNull();
  });

  it('getChunkBoundsLngLat returns null when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.getChunkBoundsLngLat(0, 0)).toBeNull();
  });

  it('getPixelBoundsLngLat returns null when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.getPixelBoundsLngLat(0, 0, 0, 0)).toBeNull();
  });

  it('embeddingBoundsLngLat returns null when no tiles are loaded', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.embeddingBoundsLngLat()).toBeNull();
  });

  it('evictTile is safe to call with no region', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(() => source.evictTile(0, 0)).not.toThrow();
  });

  it('getChunksInRegion returns empty array when store is not open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    };
    expect(source.getChunksInRegion(polygon)).toEqual([]);
  });

  it('projection is null before open', () => {
    const source = new TesseraSource({ url: 'https://example.com/zarr' });
    expect(source.projection).toBeNull();
  });
});
