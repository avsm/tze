import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  SourceManager,
  TesseraSource,
  type ZoneDescriptor,
  type StoreMetadata,
} from '@ucam-eo/tessera';
import { MaplibreTesseraSource } from './maplibre-source.js';
import type { MaplibreDisplayOptions, PreviewMode } from './types.js';

/**
 * MapLibre display wrapper around a {@link SourceManager}.
 *
 * @remarks
 * Manages per-zone {@link MaplibreTesseraSource} display instances,
 * routing display operations to the correct zone(s).  Data-access
 * operations (chunk loading, embedding queries, zone routing) are
 * available on {@link manager}.
 *
 * During the transition period the full display logic still lives in
 * `ZarrSourceManager`/`ZarrTesseraSource`.  This class establishes
 * the new composition API surface so that consumers can start
 * migrating to `.manager` without waiting for the full extraction
 * to complete.
 */
export class MaplibreTesseraManager {
  /** The core data manager — use for zone routing, embedding queries, etc. */
  readonly manager: SourceManager;

  private displayOpts: MaplibreDisplayOptions;
  private map: MaplibreMap | null = null;
  private readonly displaySources = new Map<string, MaplibreTesseraSource>();

  constructor(manager: SourceManager, options?: MaplibreDisplayOptions) {
    this.manager = manager;
    this.displayOpts = options ?? {};
  }

  // -------------------------------------------------------------------------
  // Map lifecycle
  // -------------------------------------------------------------------------

  /** Attach to a MapLibre map. Per-zone display sources are created lazily. */
  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
  }

  /**
   * Remove all display sources, close all open zone sources, and release
   * resources.
   */
  remove(): void {
    for (const ds of this.displaySources.values()) ds.remove();
    this.displaySources.clear();
    this.manager.close();
    this.map = null;
  }

  // -------------------------------------------------------------------------
  // Per-zone display source access
  // -------------------------------------------------------------------------

  /**
   * Get (or lazily create) the {@link MaplibreTesseraSource} for a zone.
   *
   * Opens the underlying {@link TesseraSource} via the core
   * {@link SourceManager} if it has not been opened yet.
   */
  async getDisplaySource(zoneId: string): Promise<MaplibreTesseraSource> {
    let ds = this.displaySources.get(zoneId);
    if (ds) return ds;

    const source: TesseraSource = await this.manager.getSource(zoneId);
    ds = new MaplibreTesseraSource(source, { ...this.displayOpts });
    if (this.map) await ds.addTo(this.map);
    this.displaySources.set(zoneId, ds);
    return ds;
  }

  /**
   * Return the display source for a zone only if it is already open
   * (synchronous — no I/O).
   */
  getOpenDisplaySource(zoneId: string): MaplibreTesseraSource | null {
    return this.displaySources.get(zoneId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Broadcast display operations
  // -------------------------------------------------------------------------

  /** Set the tile-layer opacity across all open zone display sources (0–1). */
  setOpacity(opacity: number): void {
    this.displayOpts.opacity = opacity;
    for (const ds of this.displaySources.values()) ds.setOpacity(opacity);
  }

  /** Choose which three embedding bands to map to R/G/B across all zones. */
  setBands(bands: [number, number, number]): void {
    this.displayOpts.bands = bands;
    for (const ds of this.displaySources.values()) ds.setBands(bands);
  }

  /** Switch the preview rendering mode (rgb | pca | bands) across all zones. */
  setPreview(mode: PreviewMode): void {
    this.displayOpts.preview = mode;
    for (const ds of this.displaySources.values()) ds.setPreview(mode);
  }

  /** Set the classification overlay opacity across all zones. */
  setClassificationOpacity(opacity: number): void {
    for (const ds of this.displaySources.values()) ds.setClassificationOpacity(opacity);
  }

  /** Move all tile layers to the top of the MapLibre layer stack. */
  raiseAllLayers(): void {
    for (const ds of this.displaySources.values()) ds.raiseAllLayers();
  }

  /** Remove and re-add all tile layers (forces correct z-order). */
  reAddAllLayers(): void {
    for (const ds of this.displaySources.values()) ds.reAddAllLayers();
  }

  /** Re-render all loaded chunks with the current colour mapping. */
  recolorAllChunks(): void {
    for (const ds of this.displaySources.values()) ds.recolorAllChunks();
  }

  // -------------------------------------------------------------------------
  // Overlay operations (broadcast to all open zones)
  // -------------------------------------------------------------------------

  /** Clear the similarity heatmap overlay across all zones. */
  clearSimilarityOverlay(): void {
    for (const ds of this.displaySources.values()) ds.clearSimilarityOverlay();
  }

  /** Remove all classification overlay layers across all zones. */
  clearClassificationOverlays(): void {
    for (const ds of this.displaySources.values()) ds.clearClassificationOverlays();
  }

  /** Remove the RGB preview overlay across all zones. */
  clearRgbOverlay(): void {
    for (const ds of this.displaySources.values()) ds.clearRgbOverlay();
  }

  // -------------------------------------------------------------------------
  // Region loading animation (routed to a specific zone)
  // -------------------------------------------------------------------------

  /** Begin an animated border on the named zone. */
  startRegionAnimation(
    zoneId: string,
    polygon: GeoJSON.Polygon,
    chunks: { ci: number; cj: number }[],
  ): void {
    this.displaySources.get(zoneId)?.startRegionAnimation(polygon, chunks);
  }

  /** Update animation progress on the named zone. */
  updateRegionAnimation(
    zoneId: string,
    loaded: number,
    total: number,
    ci?: number,
    cj?: number,
  ): void {
    this.displaySources.get(zoneId)?.updateRegionAnimation(loaded, total, ci, cj);
  }

  /**
   * Stop the region animation.
   *
   * @param zoneId - Stop only the named zone; omit to stop all zones.
   */
  stopRegionAnimation(zoneId?: string): void {
    if (zoneId) {
      this.displaySources.get(zoneId)?.stopRegionAnimation();
    } else {
      for (const ds of this.displaySources.values()) ds.stopRegionAnimation();
    }
  }

  // -------------------------------------------------------------------------
  // Convenience data accessors (delegate to core manager)
  // -------------------------------------------------------------------------

  /**
   * The store metadata (same as `manager.getMetadata()`).
   * Returns `null` until at least one zone has been opened.
   */
  getMetadata(): StoreMetadata | null {
    return this.manager.getMetadata();
  }

  /** All zone descriptors known to this manager. */
  getZones(): readonly ZoneDescriptor[] {
    return this.manager.getZones();
  }
}
