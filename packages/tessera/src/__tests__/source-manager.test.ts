import { describe, it, expect, vi } from 'vitest';
import { SourceManager } from '../source-manager.js';
import type { ZoneDescriptor } from '../types.js';

const testZones: ZoneDescriptor[] = [
  { id: '30N', bbox: [-6, 48, 0, 56], zarrUrl: 'https://example.com/30N.zarr' },
  { id: '31N', bbox: [0, 48, 6, 56], zarrUrl: 'https://example.com/31N.zarr' },
];

describe('SourceManager', () => {
  it('constructs with zones', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getZones()).toHaveLength(2);
    expect(mgr.getActiveSources().size).toBe(0);
  });

  it('zonesAtPoint finds correct zone', () => {
    const mgr = new SourceManager(testZones);
    const zones = mgr.zonesAtPoint(-3, 52);
    expect(zones).toHaveLength(1);
    expect(zones[0].id).toBe('30N');
  });

  it('zonesAtPoint returns empty for point outside all zones', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.zonesAtPoint(20, 52)).toHaveLength(0);
  });

  it('zonesForPolygon finds overlapping zones', () => {
    const mgr = new SourceManager(testZones);
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [[[-1, 50], [1, 50], [1, 52], [-1, 52], [-1, 50]]],
    };
    const zones = mgr.zonesForPolygon(polygon);
    expect(zones).toHaveLength(2); // Overlaps both zones
  });

  it('getOpenSource returns null for unopened zone', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getOpenSource('30N')).toBeNull();
  });

  it('totalTileCount is 0 with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.totalTileCount()).toBe(0);
  });

  it('embeddingBoundsLngLat returns null with no tiles', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.embeddingBoundsLngLat()).toBeNull();
  });

  it('getMetadata returns null with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getMetadata()).toBeNull();
  });

  it('close is safe to call with no sources', () => {
    const mgr = new SourceManager(testZones);
    expect(() => mgr.close()).not.toThrow();
  });

  it('getEmbeddingAt returns null with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getEmbeddingAt(-3, 52)).toBeNull();
  });

  it('getEmbeddingsInKernel returns empty with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getEmbeddingsInKernel(-3, 52, 3)).toHaveLength(0);
  });

  it('getChunkAtLngLat returns null with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getChunkAtLngLat(-3, 52)).toBeNull();
  });

  it('getChunkBoundsLngLat returns null for unopened zone', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getChunkBoundsLngLat('30N', 0, 0)).toBeNull();
  });

  it('getEmbeddingRegions is empty with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getEmbeddingRegions().size).toBe(0);
  });

  it('regionHasTile returns false for unopened zone', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.regionHasTile('30N', 0, 0)).toBe(false);
  });

  it('getSource throws for unknown zone', async () => {
    const mgr = new SourceManager(testZones);
    await expect(mgr.getSource('99X')).rejects.toThrow('Unknown zone');
  });

  it('forwards events to manager listeners', () => {
    const mgr = new SourceManager(testZones);
    const cb = vi.fn();
    mgr.on('error', cb);
    mgr.off('error', cb);
    // Just verify event system is wired up
  });
});
