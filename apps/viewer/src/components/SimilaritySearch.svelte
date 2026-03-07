<script lang="ts">
  import { get } from 'svelte/store';
  import { sourceManager } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { computeSimilarityScores, renderSimilarityCanvas } from '../lib/similarity';

  let isComputing = $state(false);
  let pendingRecompute = false;
  let overlayCanvases = new Map<string, HTMLCanvasElement>();

  // Track embedding loads via events
  $effect(() => {
    const mgr = $sourceManager;
    if (!mgr) { $simEmbeddingTileCount = 0; return; }
    $simEmbeddingTileCount = mgr.totalTileCount();
    const handler = () => {
      $simEmbeddingTileCount = mgr.totalTileCount();
    };
    mgr.on('embeddings-loaded', handler);
    return () => mgr.off('embeddings-loaded', handler);
  });

  // Recompute similarity when ROI loading finishes (transitions from loading to idle)
  let wasLoading = false;
  $effect(() => {
    const loading = $roiLoading;
    if (loading) {
      wasLoading = true;
    } else if (wasLoading) {
      wasLoading = false;
      if ($simRefEmbedding && $simSelectedPixel) runCompute();
    }
  });

  /** Re-render similarity overlays from existing scores (e.g. when switching back to this tab). */
  export function restoreOverlays() {
    if (get(simScores).size > 0) applyThreshold();
  }

  /** Called from App.svelte when the user clicks in similarity mode. */
  export function handleClick(lng: number, lat: number) {
    const mgr = $sourceManager;
    if (!mgr) return;
    const emb = mgr.getEmbeddingAt(lng, lat);
    if (!emb) return;

    $simSelectedPixel = { ci: emb.ci, cj: emb.cj, row: emb.row, col: emb.col, lng, lat };
    $simRefEmbedding = emb.embedding;
    runCompute();
  }

  /** CPU compute — runs once per reference pixel selection, across all zones. */
  function runCompute() {
    const mgr = $sourceManager;
    if (!mgr || !$simRefEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      mgr.clearSimilarityOverlay();
      const regions = mgr.getEmbeddingRegions();
      if (regions.size === 0) return;

      const results = new Map<string, ReturnType<typeof computeSimilarityScores>>();
      for (const [zoneId, region] of regions) {
        results.set(zoneId, computeSimilarityScores(region, $simRefEmbedding!));
      }
      $simScores = results;
      overlayCanvases = new Map();
      applyThreshold();
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /** Render threshold into per-zone canvases and push to map. */
  function applyThreshold() {
    const mgr = $sourceManager;
    const results = get(simScores);
    const threshold = $simThreshold;
    if (!mgr || results.size === 0) return;

    for (const [zoneId, result] of results) {
      let canvas = overlayCanvases.get(zoneId);
      canvas = renderSimilarityCanvas(result, threshold, canvas);
      overlayCanvases.set(zoneId, canvas);
      const src = mgr.getOpenSource(zoneId);
      src?.setSimilarityOverlay(canvas);
    }
  }

  function handleClear() {
    $sourceManager?.clearSimilarityOverlay();
    $simSelectedPixel = null;
    $simRefEmbedding = null;
    $simScores = new Map();
    overlayCanvases = new Map();
  }

  // React to threshold changes from any source (sidebar slider or UMAP window slider)
  $effect(() => {
    const _t = $simThreshold; // track only threshold
    if (get(simScores).size > 0) applyThreshold();
  });

</script>

<div class="space-y-3" data-tutorial="similarity-panel">
  {#if $simSelectedPixel}
    <div class="text-[10px] text-gray-600 italic">Reference pixel selected — see UMAP window</div>
  {:else if $simEmbeddingTileCount > 0}
    <div class="text-[10px] text-gray-600 italic">Click a pixel to select reference</div>
  {:else}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region above to load embeddings, then click any pixel to find similar ones.
    </div>
  {/if}

  {#if $simSelectedPixel}
    <div class="flex gap-1.5">
      <button
        onclick={handleClear}
        class="flex-1 text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >CLEAR</button>
    </div>
  {/if}

  {#if isComputing}
    <div class="text-[9px] text-purple-400 animate-pulse">Computing similarity...</div>
  {/if}
</div>
