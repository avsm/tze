<script lang="ts">
  import { get } from 'svelte/store';
  import { zarrSource } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { computeSimilarityScores, renderSimilarityCanvas } from '../lib/similarity';

  let isComputing = $state(false);
  let pendingRecompute = false;
  let overlayCanvas: HTMLCanvasElement | undefined;

  // Track embedding loads via events
  $effect(() => {
    const src = $zarrSource;
    if (!src) { $simEmbeddingTileCount = 0; return; }
    $simEmbeddingTileCount = src.regionTileCount();
    const handler = () => {
      $simEmbeddingTileCount = src.regionTileCount();
    };
    src.on('embeddings-loaded', handler);
    return () => src.off('embeddings-loaded', handler);
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
    if (get(simScores)) applyThreshold();
  }

  /** Called from App.svelte when the user clicks in similarity mode. */
  export function handleClick(lng: number, lat: number) {
    const src = $zarrSource;
    if (!src) return;
    const emb = src.getEmbeddingAt(lng, lat);
    if (!emb) return;

    $simSelectedPixel = { ci: emb.ci, cj: emb.cj, row: emb.row, col: emb.col, lng, lat };
    $simRefEmbedding = emb.embedding;
    runCompute();
  }

  /** CPU compute — runs once per reference pixel selection. */
  function runCompute() {
    const src = $zarrSource;
    if (!src || !$simRefEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      src.clearSimilarityOverlay();
      if (!src.embeddingRegion) return;
      $simScores = computeSimilarityScores(
        src.embeddingRegion,
        $simRefEmbedding,
      );
      overlayCanvas = undefined; // force new canvas for new region geometry
      applyThreshold();
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /** Render threshold into a single region-wide canvas and push to map.
   *  One PNG encode + one ImageSource — no per-tile overhead. */
  function applyThreshold() {
    const src = $zarrSource;
    const result = $simScores;
    const threshold = $simThreshold;
    if (!src || !result) return;

    overlayCanvas = renderSimilarityCanvas(result, threshold, overlayCanvas);
    src.setSimilarityOverlay(overlayCanvas);
  }

  function handleClear() {
    $zarrSource?.clearSimilarityOverlay();
    $simSelectedPixel = null;
    $simRefEmbedding = null;
    $simScores = null;
    overlayCanvas = undefined;
  }

  // React to threshold changes from any source (sidebar slider or UMAP window slider)
  $effect(() => {
    const _t = $simThreshold; // track only threshold
    // Use get() to avoid tracking simScores in this effect
    if (get(simScores)) applyThreshold();
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
