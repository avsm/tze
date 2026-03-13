import type { Map as MaplibreMap } from 'maplibre-gl';
import { TesseraSource } from '@ucam-eo/tessera';
import type { StoreMetadata } from '@ucam-eo/tessera';
import type { MaplibreDisplayOptions, PreviewMode } from './types.js';

/**
 * MapLibre display wrapper around a {@link TesseraSource}.
 *
 * @remarks
 * Provides a composition-based interface where data-access methods
 * live on {@link source} (the core {@link TesseraSource}) and display
 * operations (layers, overlays, animations) are on this wrapper.
 *
 * During the transition period the full display logic (worker pools,
 * canvas management, layer management) still lives in
 * `ZarrTesseraSource`. This class establishes the new composition
 * API surface so that consumers can start migrating to `.source`
 * without waiting for the full extraction to complete.
 */
export class MaplibreTesseraSource {
  /** The core data-access source — use for embedding queries, coordinate conversions, etc. */
  readonly source: TesseraSource;

  private displayOpts: MaplibreDisplayOptions;
  private map: MaplibreMap | null = null;

  constructor(source: TesseraSource, options?: MaplibreDisplayOptions) {
    this.source = source;
    this.displayOpts = options ?? {};
  }

  // -------------------------------------------------------------------------
  // Map lifecycle
  // -------------------------------------------------------------------------

  /**
   * Attach to a MapLibre map, creating raster sources/layers for tile display.
   *
   * @remarks TODO: Extract display layer setup from ZarrTesseraSource.addTo()
   */
  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
  }

  /**
   * Remove all layers from the map and release resources.
   *
   * @remarks TODO: Extract cleanup from ZarrTesseraSource.remove()
   */
  remove(): void {
    this.map = null;
  }

  // -------------------------------------------------------------------------
  // Display properties
  // -------------------------------------------------------------------------

  /** Set the opacity of all tile layers (0–1). */
  setOpacity(opacity: number): void {
    this.displayOpts.opacity = opacity;
    // TODO: propagate to live map layers once display logic is extracted
  }

  /** Choose which three embedding bands to map to R/G/B. */
  setBands(bands: [number, number, number]): void {
    this.displayOpts.bands = bands;
    // TODO: propagate to live map layers once display logic is extracted
  }

  /** Switch the preview rendering mode (rgb | pca | bands). */
  setPreview(mode: PreviewMode): void {
    this.displayOpts.preview = mode;
    // TODO: propagate to live map layers once display logic is extracted
  }

  // -------------------------------------------------------------------------
  // Layer management (stubs — filled in when display logic is extracted)
  // -------------------------------------------------------------------------

  /** Set the opacity of the classification overlay (0–1). */
  setClassificationOpacity(_opacity: number): void { /* TODO */ }

  /** Move all tile layers to the top of the MapLibre layer stack. */
  raiseAllLayers(): void { /* TODO */ }

  /** Remove and re-add all tile layers (forces correct z-order after panel changes). */
  reAddAllLayers(): void { /* TODO */ }

  /** Re-render all loaded chunks with the current colour mapping. */
  recolorAllChunks(): void { /* TODO */ }

  // -------------------------------------------------------------------------
  // Overlay operations (stubs)
  // -------------------------------------------------------------------------

  /** Render a cosine-similarity heatmap over all loaded chunks. */
  setSimilarityOverlay(_scores: Float32Array): void { /* TODO */ }

  /** Clear the similarity heatmap overlay. */
  clearSimilarityOverlay(): void { /* TODO */ }

  /** Render a per-pixel classification map with the given colour palette. */
  addClassificationOverlay(_classMap: Uint8Array, _palette: string[]): void { /* TODO */ }

  /** Remove all classification overlay layers. */
  clearClassificationOverlays(): void { /* TODO */ }

  /** Remove the RGB preview overlay. */
  clearRgbOverlay(): void { /* TODO */ }

  // -------------------------------------------------------------------------
  // Region loading animation (stubs)
  // -------------------------------------------------------------------------

  /** Begin an animated border around a loading region. */
  startRegionAnimation(
    _polygon: GeoJSON.Polygon,
    _chunks: { ci: number; cj: number }[],
  ): void { /* TODO */ }

  /** Update the animation progress. */
  updateRegionAnimation(
    _loaded: number,
    _total: number,
    _ci?: number,
    _cj?: number,
  ): void { /* TODO */ }

  /** Stop the animation and remove the overlay. */
  stopRegionAnimation(): void { /* TODO */ }

  // -------------------------------------------------------------------------
  // Convenience accessors
  // -------------------------------------------------------------------------

  /**
   * The store metadata for this source.
   * Convenience alias for `source.metadata`.
   */
  getMetadata(): StoreMetadata | null {
    return this.source.metadata;
  }
}
