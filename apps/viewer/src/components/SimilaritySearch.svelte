<script lang="ts">
  import { onMount } from 'svelte';
  import { zarrSource, metadata } from '../stores/zarr';
  import { computeSimilarityScores, renderSimilarityOverlays, type TileSimilarity } from '../lib/similarity';
  import UmapCloud from './UmapCloud.svelte';

  let threshold = $state(0.5);
  let isComputing = $state(false);
  let selectedPixel = $state<{ lng: number; lat: number; ci: number; cj: number; row: number; col: number } | null>(null);
  let refEmbedding = $state<Float32Array | null>(null);
  let cachedScores = $state<TileSimilarity[]>([]);
  let embeddingTileCount = $state(0);
  let pendingRecompute = false;

  // Track embedding loads via events since embeddingCache is a plain Map
  $effect(() => {
    const src = $zarrSource;
    if (!src) { embeddingTileCount = 0; return; }
    embeddingTileCount = src.embeddingCache.size;
    const handler = () => {
      embeddingTileCount = src.embeddingCache.size;
      // Re-run similarity + UMAP when new tiles are loaded while a pixel is selected
      if (refEmbedding && selectedPixel) runCompute();
    };
    src.on('embeddings-loaded', handler);
    return () => src.off('embeddings-loaded', handler);
  });

  /** Called from App.svelte when the user clicks in similarity mode. */
  export function handleClick(lng: number, lat: number) {
    const src = $zarrSource;
    if (!src) return;
    const emb = src.getEmbeddingAt(lng, lat);
    if (!emb) return;

    selectedPixel = { lng, lat, ci: emb.ci, cj: emb.cj, row: emb.row, col: emb.col };
    refEmbedding = emb.embedding;
    runCompute();
  }

  /** GPU compute — runs once per reference pixel selection.
   *  If called while already computing, queues a re-run. */
  async function runCompute() {
    const src = $zarrSource;
    if (!src || !refEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      src.clearClassificationOverlays();
      cachedScores = await computeSimilarityScores(
        src.embeddingCache,
        refEmbedding,
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
    if (!src || cachedScores.length === 0) return;

    renderSimilarityOverlays(cachedScores, threshold, (r) => {
      src.addClassificationOverlay(r.ci, r.cj, r.canvas);
      src.setClassificationOpacity(0.8);
    });
  }

  function handleClear() {
    $zarrSource?.clearClassificationOverlays();
    selectedPixel = null;
    refEmbedding = null;
    cachedScores = [];
  }

  function updateThreshold(val: number) {
    threshold = val;
    if (cachedScores.length > 0) applyThreshold();
  }
</script>

<div class="space-y-3">
  {#if selectedPixel}
    <div class="text-[10px] text-gray-500">
      Reference: <span class="text-gray-300">({selectedPixel.ci},{selectedPixel.cj}) px [{selectedPixel.row},{selectedPixel.col}]</span>
    </div>
  {:else if embeddingTileCount > 0}
    <div class="text-[10px] text-gray-600 italic">Click a pixel to select reference</div>
  {:else}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Double-click a tile to load embeddings, then click any pixel to find similar ones.
    </div>
  {/if}

  <div class="flex items-center gap-2">
    <span class="text-gray-600 text-[10px] shrink-0">Threshold</span>
    <input type="range" min="0" max="100" value={Math.round(threshold * 100)}
           oninput={(e) => updateThreshold(parseInt((e.target as HTMLInputElement).value) / 100)}
           class="flex-1 h-1" />
    <span class="text-gray-500 text-[10px] tabular-nums w-8 text-right">{threshold.toFixed(2)}</span>
  </div>

  {#if cachedScores.length > 0 && refEmbedding && selectedPixel}
    <UmapCloud {cachedScores} {refEmbedding} {selectedPixel} {threshold} {embeddingTileCount} />
  {/if}

  {#if selectedPixel}
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
