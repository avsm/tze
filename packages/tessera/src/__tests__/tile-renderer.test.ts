import { describe, it, expect } from 'vitest';
import { tileBounds, selectLevel } from '../tile-renderer.js';

describe('tileBounds', () => {
  it('computes correct bounds for tile 0/0/0', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.south).toBeCloseTo(-85.05, 0);
    expect(b.east).toBeCloseTo(180, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('computes correct bounds for tile 1/0/0', () => {
    const b = tileBounds(1, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.east).toBeCloseTo(0, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('tile 1/1/0 is the NE quadrant', () => {
    const b = tileBounds(1, 1, 0);
    expect(b.west).toBeCloseTo(0, 0);
    expect(b.east).toBeCloseTo(180, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('tile 1/0/1 is the SW quadrant', () => {
    const b = tileBounds(1, 0, 1);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.east).toBeCloseTo(0, 0);
    expect(b.south).toBeCloseTo(-85.05, 0);
  });
});

describe('selectLevel', () => {
  // Shape convention: [lat_pixels, lon_pixels, bands]
  // Levels are ordered coarsest (index 0) to finest (index N-1).

  it('selects coarsest level with sufficient resolution', () => {
    // At zoom 0: neededPxPerDeg = 256/360 ≈ 0.711, threshold = 0.356
    // Level 0 (coarsest): 360px wide → 1.0 px/deg ≥ 0.356 → sufficient → return 0
    const levels = [
      { shape: [180, 360, 3] as [number, number, number] },  // coarsest
      { shape: [360, 720, 3] as [number, number, number] },  // finer
    ];
    const idx = selectLevel(levels, 0);
    expect(idx).toBe(0);
  });

  it('selects finer level at higher zoom when coarse level is insufficient', () => {
    // At zoom 4: neededPxPerDeg = 256*16/360 ≈ 11.38, threshold ≈ 5.69
    // Level 0 (coarsest): 1024px wide → 2.84 px/deg < 5.69 → NOT sufficient
    // Level 1 (finer):    4096px wide → 11.38 px/deg ≥ 5.69 → sufficient → return 1
    const levels = [
      { shape: [512, 1024, 3] as [number, number, number] },   // coarsest
      { shape: [2048, 4096, 3] as [number, number, number] },  // finer
    ];
    const idx = selectLevel(levels, 4);
    expect(idx).toBe(1);
  });

  it('falls back to finest level (last index) when no level suffices', () => {
    const levels = [
      { shape: [10, 20, 3] as [number, number, number] },  // very coarse
    ];
    const idx = selectLevel(levels, 10);
    expect(idx).toBe(0); // only level available
  });
});
