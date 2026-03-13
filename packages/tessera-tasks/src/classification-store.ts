import type { SourceManager, TesseraSource } from '@ucam-eo/tessera';

/**
 * Stores per-tile classification results and provides
 * geographic lookup across zones.
 *
 * @remarks
 * This is the analysis-side counterpart to the k-NN classifier.
 * Display overlays are managed separately by the map plugin.
 */
export class ClassificationStore {
  private maps = new Map<string, { width: number; height: number; classMap: Int16Array }>();

  /**
   * Store a per-pixel class ID map for a classified chunk.
   *
   * @param zoneId - Zone identifier (keys are zone-scoped to avoid collisions).
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param classMap - Per-pixel class IDs (-2 nodata, -1 uncertain, ≥0 class).
   * @param width - Tile width in pixels.
   * @param height - Tile height in pixels.
   */
  set(zoneId: string, ci: number, cj: number, classMap: Int16Array, width: number, height: number): void {
    this.maps.set(`${zoneId}:${ci}_${cj}`, { width, height, classMap });
  }

  /**
   * Look up the class ID at a pixel position within a chunk.
   *
   * @returns Class ID (≥0), -1 for uncertain, -2 for nodata, or `null` if
   *   no classification exists for that chunk.
   */
  getAtPixel(zoneId: string, ci: number, cj: number, row: number, col: number): number | null {
    const entry = this.maps.get(`${zoneId}:${ci}_${cj}`);
    if (!entry) return null;
    if (row < 0 || row >= entry.height || col < 0 || col >= entry.width) return null;
    return entry.classMap[row * entry.width + col];
  }

  /**
   * Look up the class ID at a WGS84 coordinate.
   *
   * @remarks
   * Searches all open zones in the manager for a classification result
   * at the given coordinate. Uses the zone's projection and metadata
   * for coordinate conversion.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @param manager - The data manager (for coordinate conversion).
   * @returns Class ID (≥0), -1 for uncertain, -2 for nodata, or `null`.
   */
  getAt(lng: number, lat: number, manager: SourceManager): number | null {
    for (const [zoneId, source] of manager.getActiveSources()) {
      const result = this.getAtSource(zoneId, lng, lat, source);
      if (result !== null) return result;
    }
    return null;
  }

  /** Look up using a single source's coordinate system. */
  private getAtSource(zoneId: string, lng: number, lat: number, source: TesseraSource): number | null {
    const meta = source.metadata;
    const proj = source.projection;
    if (!meta || !proj) return null;

    const [e, n] = proj.forward(lng, lat);
    const t = meta.transform;
    const cs = meta.chunkShape;
    const s = meta.shape;

    const globalCol = Math.floor((e - t[2]) / t[0]);
    const globalRow = Math.floor((t[5] - n) / t[0]);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;

    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];

    return this.getAtPixel(zoneId, ci, cj, row, col);
  }

  /** Clear all stored classification maps. */
  clear(): void {
    this.maps.clear();
  }

  /** Number of classified chunks stored. */
  get size(): number {
    return this.maps.size;
  }
}
