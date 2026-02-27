<script lang="ts">
  import { zarrSource } from '../stores/zarr';
  import { segmentPolygons } from '../stores/segmentation';
  import {
    runSolarSegmentation,
    rethreshold,
    clearSegmentation,
    hasCachedProbabilities,
  } from '../lib/segment';

  let threshold = $state(0.5);
  let isRunning = $state(false);
  let progressDone = $state(0);
  let progressTotal = $state(0);
  let resultCount = $state(0);
  let embeddingTileCount = $state(0);
  let hasProbs = $state(false);
  let errorMsg = $state<string | null>(null);

  $effect(() => {
    const src = $zarrSource;
    if (!src) { embeddingTileCount = 0; return; }
    embeddingTileCount = src.embeddingCache.size;
    const handler = () => { embeddingTileCount = src.embeddingCache.size; };
    src.on('embeddings-loaded', handler);
    return () => src.off('embeddings-loaded', handler);
  });

  async function handleDetect() {
    const src = $zarrSource;
    if (!src || isRunning) return;
    isRunning = true;
    errorMsg = null;
    progressDone = 0;
    progressTotal = 0;

    console.log('[SegmentPanel] handleDetect called, embeddingCache size:', src.embeddingCache.size);

    try {
      const results = await runSolarSegmentation(
        src.embeddingCache,
        src,
        threshold,
        (done, total) => {
          progressDone = done;
          progressTotal = total;
        },
      );

      const features = results.flatMap(r => r.polygons);
      resultCount = features.length;
      hasProbs = true;
      $segmentPolygons = { type: 'FeatureCollection', features };
      console.log('[SegmentPanel] Detection complete, features:', features.length);
    } catch (err) {
      console.error('[SegmentPanel] Detection failed:', err);
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      isRunning = false;
    }
  }

  function updateThreshold(val: number) {
    threshold = val;
    if (!hasCachedProbabilities()) return;
    const results = rethreshold(val);
    const features = results.flatMap(r => r.polygons);
    resultCount = features.length;
    $segmentPolygons = { type: 'FeatureCollection', features };
  }

  function handleClear() {
    clearSegmentation();
    hasProbs = false;
    resultCount = 0;
    $segmentPolygons = { type: 'FeatureCollection', features: [] };
  }
</script>

<div class="space-y-3">
  {#if embeddingTileCount === 0}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Double-click tiles to load embeddings, then detect solar panels with a trained UNet model.
    </div>
  {:else}
    <div class="text-[10px] text-gray-500">
      <span class="text-gray-300">{embeddingTileCount}</span> embedding tile{embeddingTileCount !== 1 ? 's' : ''} loaded
    </div>
  {/if}

  <button
    onclick={handleDetect}
    disabled={embeddingTileCount === 0 || isRunning}
    class="w-full text-[10px] font-bold tracking-wider px-2 py-2 rounded
           border transition-all
           {embeddingTileCount > 0 && !isRunning
             ? 'text-orange-400 border-orange-500/40 hover:border-orange-400/60 hover:bg-orange-400/10'
             : 'text-gray-600 border-gray-700/60 opacity-40 pointer-events-none'}"
  >
    {isRunning ? 'DETECTING...' : 'DETECT SOLAR PANELS'}
  </button>

  {#if isRunning && progressTotal > 0}
    <div class="space-y-1">
      <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-orange-500 transition-all duration-100"
          style="width: {Math.round((progressDone / progressTotal) * 100)}%"
        ></div>
      </div>
      <div class="text-[9px] text-gray-600 tabular-nums">
        {progressDone}/{progressTotal} patches
      </div>
    </div>
  {/if}

  {#if errorMsg}
    <div class="text-[9px] text-red-400 break-all">{errorMsg}</div>
  {/if}

  {#if hasProbs && !isRunning}
    <div class="text-[10px] text-orange-400">
      Found <span class="font-bold">{resultCount}</span> solar installation{resultCount !== 1 ? 's' : ''}
    </div>
  {/if}

  <div class="flex items-center gap-2">
    <span class="text-gray-600 text-[10px] shrink-0">Threshold</span>
    <input type="range" min="0" max="100" value={Math.round(threshold * 100)}
           oninput={(e) => updateThreshold(parseInt((e.target as HTMLInputElement).value) / 100)}
           class="flex-1 h-1" />
    <span class="text-gray-500 text-[10px] tabular-nums w-8 text-right">{threshold.toFixed(2)}</span>
  </div>

  {#if hasProbs}
    <div class="flex gap-1.5">
      <button
        onclick={handleClear}
        class="flex-1 text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >CLEAR</button>
    </div>
  {/if}
</div>
