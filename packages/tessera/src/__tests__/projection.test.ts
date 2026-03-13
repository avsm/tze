import { describe, it, expect } from 'vitest';
import { UtmProjection } from '../projection.js';

describe('UtmProjection', () => {
  it('creates projection for northern hemisphere UTM zone', () => {
    const proj = new UtmProjection(32630); // Zone 30N
    expect(proj.zone).toBe(30);
    expect(proj.isSouth).toBe(false);
  });

  it('creates projection for southern hemisphere UTM zone', () => {
    const proj = new UtmProjection(32730); // Zone 30S
    expect(proj.zone).toBe(30);
    expect(proj.isSouth).toBe(true);
  });

  it('converts WGS84 to UTM and back (round-trip)', () => {
    const proj = new UtmProjection(32630);
    const [e, n] = proj.forward(-0.5, 51.5); // London area
    const [lng, lat] = proj.inverse(e, n);
    expect(lng).toBeCloseTo(-0.5, 4);
    expect(lat).toBeCloseTo(51.5, 4);
  });

  it('computes chunk LngLat corners from pixel bounds', () => {
    const proj = new UtmProjection(32630);
    const corners = proj.chunkCornersToLngLat(
      { minE: 500000, maxE: 510240, minN: 5989760, maxN: 6000000 }
    );
    // Should return [TL, TR, BR, BL] as [lng, lat] pairs
    expect(corners).toHaveLength(4);
    for (const [lng, lat] of corners) {
      expect(lng).toBeGreaterThan(-10);
      expect(lng).toBeLessThan(10);
      expect(lat).toBeGreaterThan(50);
      expect(lat).toBeLessThan(60);
    }
  });

  it('caches transformer per EPSG', () => {
    const proj1 = new UtmProjection(32630);
    const proj2 = new UtmProjection(32630);
    // Both should produce identical results
    const [e1, n1] = proj1.forward(0, 51);
    const [e2, n2] = proj2.forward(0, 51);
    expect(e1).toBe(e2);
    expect(n1).toBe(n2);
  });
});
