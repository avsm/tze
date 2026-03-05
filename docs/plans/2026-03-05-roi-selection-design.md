# ROI Selection Design

## Goal

Replace the per-tile double-click embedding loading with an explicit region-of-interest workflow. Users draw polygons/rectangles on the map to define regions, embeddings load progressively, and analysis tools operate on the loaded tiles.

## Architecture

A persistent ROI strip sits above the tool tabs in the sidebar. It controls drawing mode and shows loading progress. The "Draw" tool tab is removed — drawing is activated from the ROI strip. Tools (Similar, Classify, Segment) operate on all tiles loaded across all drawn regions.

## ROI Strip States

**Idle** (no regions): "Draw region" button with polygon/rectangle toggle.

**Drawing**: Instruction text ("Click to draw polygon" / "Drag rectangle"), Cancel button. Terra-draw is active.

**Loading**: Progress bar (loaded/total chunks). Summary: "N regions, M tiles loaded". "+" button to add another region.

**Loaded**: Compact summary "N regions - M tiles". "+" button. "Clear all" button. Each region shown as a small badge with x to delete individually.

## Data Flow

1. User clicks "Draw region" -> terra-draw activates (polygon mode by default, rectangle toggle available)
2. User completes shape -> `drawnFeatures` store updated
3. System computes which chunks intersect the polygon bounds
4. Queue `loadFullChunk()` for each intersecting chunk
5. Tiles load progressively, tools can use partial results immediately
6. Tools iterate `embeddingCache` as before (no changes to similarity/classify/segment)

## Multiple Regions

Users can draw multiple regions. Each adds to the embedding cache. The "+" button enters drawing mode for an additional region. Deleting a region (x badge) removes that region's tiles from the cache.

## Tool Tabs

Three tabs: Similar | Classify | Segment (Draw tab removed). Tools are disabled/greyed until at least one embedding tile is loaded.

## Embedding Loading

- Remove double-click/long-press trigger from zarr-source
- Add `getChunksIntersecting(polygon: GeoJSON.Polygon): {ci, cj}[]` to zarr-source
- Add `loadChunkBatch(chunks: {ci,cj}[], onProgress?)` that loads sequentially or with concurrency control
- Loading starts immediately when a region is drawn (progressive, no confirmation dialog)

## Clearing

- "Clear all" removes all regions, clears embedding cache, resets tool overlays
- Individual region x removes that region and its exclusive tiles (tiles shared with other regions stay)

## Mobile

Same strip, compact layout. Draw button activates terra-draw. No change to touch interaction model.

## Files to Change

- `apps/viewer/src/stores/drawing.ts` - rename/expand to ROI store with region management
- `apps/viewer/src/stores/tools.ts` - remove 'draw' from ToolId
- `apps/viewer/src/components/DrawPanel.svelte` - delete, replaced by RoiStrip
- `apps/viewer/src/components/RoiStrip.svelte` - new component above tool tabs
- `apps/viewer/src/components/ToolSwitcher.svelte` - remove Draw tab, integrate RoiStrip above tabs
- `apps/viewer/src/App.svelte` - move terra-draw management, remove draw tool cursor/effects
- `packages/maplibre-zarr-tessera/src/zarr-source.ts` - add getChunksIntersecting, loadChunkBatch, remove dblclick/longpress triggers
