<script lang="ts">
  import { get } from 'svelte/store';
  import { zarrSource } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { computeSimilarityScores, renderSimilarityOverlays, type TileSimilarity } from '../lib/similarity';

  let isComputing = $state(false);
  let pendingRecompute = false;

  // Track embedding loads via events since embeddingCache is a plain Map
  $effect(() => {
    const src = $zarrSource;
    if (!src) { $simEmbeddingTileCount = 0; return; }
    $simEmbeddingTileCount = src.embeddingCache.size;
    const handler = () => {
      $simEmbeddingTileCount = src.embeddingCache.size;
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
    if (get(simScores).length > 0) applyThreshold();
  }

  /** Called from App.svelte when the user clicks in similarity mode. */
  export function handleClick(lng: number, lat: number) {
    const src = $zarrSource;
    if (!src) return;
    const emb = src.getEmbeddingAt(lng, lat);
    if (!emb) return;

    $simSelectedPixel = { ci: emb.ci, cj: emb.cj, row: emb.row, col: emb.col };
    $simRefEmbedding = emb.embedding;
    runCompute();
  }

  /** GPU compute — runs once per reference pixel selection.
   *  If called while already computing, queues a re-run. */
  async function runCompute() {
    const src = $zarrSource;
    if (!src || !$simRefEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      src.clearClassificationOverlays();
      $simScores = await computeSimilarityScores(
        src.embeddingCache,
        $simRefEmbedding,
      );
      applyThreshold();
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /** CPU render — runs instantly when threshold slider moves.
   *  Updates existing overlay sources in-place (no clear+re-add). */
  function applyThreshold() {
    const src = $zarrSource;
    const scores = $simScores;
    const threshold = $simThreshold;
    if (!src || scores.length === 0) return;

    renderSimilarityOverlays(scores, threshold, (r) => {
      src.addClassificationOverlay(r.ci, r.cj, r.canvas);
      src.setClassificationOpacity(0.8);
    });
  }

  function handleClear() {
    $zarrSource?.clearClassificationOverlays();
    $simSelectedPixel = null;
    $simRefEmbedding = null;
    $simScores = [];
  }

  // React to threshold changes from any source (sidebar slider or UMAP window slider)
  $effect(() => {
    const _t = $simThreshold; // track only threshold
    // Use get() to avoid tracking simScores in this effect
    if (get(simScores).length > 0) applyThreshold();
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
