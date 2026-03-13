<script lang="ts">
  import { ChevronDown, Sun } from 'lucide-svelte';
  import { sourceManager } from '../stores/zarr';
  import { segmentPolygons } from '../stores/segmentation';
  import { SegmentationSession } from '@ucam-eo/tessera-tasks';

  const segSession = new SegmentationSession({
    modelUrl: `${import.meta.env.BASE_URL}models/solar_unet.onnx`,
    statsUrl: `${import.meta.env.BASE_URL}models/solar_unet_stats.json`,
    wasmPaths: `${import.meta.env.BASE_URL}ort-wasm/`,
  });

  const DETECTORS = [
    { id: 'solar', label: 'Solar Panels', icon: Sun },
  ] as const;

  let selectedDetector = $state<string>('solar');
  let detectorDropdownOpen = $state(false);

  let threshold = $state(0.5);
  let isRunning = $state(false);
  let progressDone = $state(0);
  let progressTotal = $state(0);
  let resultCount = $state(0);
  let embeddingTileCount = $state(0);
  let hasProbs = $state(false);
  let errorMsg = $state<string | null>(null);

  const activeDetector = $derived(DETECTORS.find(d => d.id === selectedDetector) ?? DETECTORS[0]);

  $effect(() => {
    const mgr = $sourceManager;
    if (!mgr) { embeddingTileCount = 0; return; }
    embeddingTileCount = mgr.totalTileCount();
    const handler = () => { embeddingTileCount = mgr.totalTileCount(); };
    mgr.on('embeddings-loaded', handler);
    return () => mgr.off('embeddings-loaded', handler);
  });

  async function handleDetect() {
    const mgr = $sourceManager;
    if (!mgr || isRunning) return;
    isRunning = true;
    errorMsg = null;
    progressDone = 0;
    progressTotal = 0;

    try {
      const regions = mgr.getEmbeddingRegions();
      if (regions.size === 0) return;

      const allFeatures: GeoJSON.Feature[] = [];
      for (const [zoneId, region] of regions) {
        const src = mgr.getOpenSource(zoneId);
        if (!src) continue;
        // SegmentationSession.run expects a TesseraSource for projection
        const results = await segSession.run(
          region,
          src,
          threshold,
          (done, total) => {
            progressDone = done;
            progressTotal = total;
          },
        );
        allFeatures.push(...results.flatMap(r => r.polygons));
      }

      resultCount = allFeatures.length;
      hasProbs = true;
      $segmentPolygons = { type: 'FeatureCollection', features: allFeatures };
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      isRunning = false;
    }
  }

  function updateThreshold(val: number) {
    threshold = val;
    if (!segSession.hasCachedProbabilities) return;
    const results = segSession.rethreshold(val);
    const features = results.flatMap(r => r.polygons);
    resultCount = features.length;
    $segmentPolygons = { type: 'FeatureCollection', features };
  }

  function handleClear() {
    segSession.clear();
    hasProbs = false;
    resultCount = 0;
    $segmentPolygons = { type: 'FeatureCollection', features: [] };
  }
</script>

<div class="space-y-3" data-tutorial="segment-panel">
  <!-- Detector selector -->
  <div class="relative">
    <button
      onclick={() => { detectorDropdownOpen = !detectorDropdownOpen; }}
      class="flex items-center gap-1.5 w-full px-2 py-1.5 rounded
             border border-gray-700/60 bg-gray-900/60
             text-[10px] text-gray-300 hover:border-gray-600 transition-colors"
    >
      <activeDetector.icon size={11} class="text-orange-400 shrink-0" />
      <span class="flex-1 text-left">{activeDetector.label}</span>
      <ChevronDown size={10} class="text-gray-600" />
    </button>
    {#if detectorDropdownOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" aria-label="Close detector menu" onclick={() => { detectorDropdownOpen = false; }}></button>
      <div class="absolute top-full left-0 right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl py-1">
        {#each DETECTORS as det}
          <button
            onclick={() => { selectedDetector = det.id; detectorDropdownOpen = false; }}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[10px] transition-colors
                   {det.id === selectedDetector
                     ? 'text-orange-400 bg-orange-400/10'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
          >
            <det.icon size={11} />
            {det.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if embeddingTileCount === 0}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region above to load embeddings, then run detection with a trained UNet model.
    </div>
  {:else}
    <div class="text-[10px] text-gray-500">
      <span class="text-gray-300">{embeddingTileCount}</span> embedding tile{embeddingTileCount !== 1 ? 's' : ''} loaded
    </div>
  {/if}

  <button
    data-tutorial="segment-detect-btn"
    onclick={handleDetect}
    disabled={embeddingTileCount === 0 || isRunning}
    class="w-full text-[10px] font-bold tracking-wider px-2 py-2 rounded
           border transition-all
           {embeddingTileCount > 0 && !isRunning
             ? 'text-orange-400 border-orange-500/40 hover:border-orange-400/60 hover:bg-orange-400/10'
             : 'text-gray-600 border-gray-700/60 opacity-40 pointer-events-none'}"
  >
    {isRunning ? 'DETECTING...' : `DETECT ${activeDetector.label.toUpperCase()}`}
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
