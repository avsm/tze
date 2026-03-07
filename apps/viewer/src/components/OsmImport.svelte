<script lang="ts">
  import { sourceManager } from '../stores/zarr';
  import { importOsmLabels } from '../stores/classifier';
  import { queryOverpass, type OsmCategory } from '../lib/overpass';
  import { sampleOsmCategories, type SampleProgress } from '../lib/osm-sampler';

  interface Props {
    open: boolean;
    autoImport?: boolean;
  }

  let { open = $bindable(false), autoImport = false }: Props = $props();

  type Phase = 'idle' | 'querying' | 'selecting' | 'sampling' | 'done' | 'error';

  let phase = $state<Phase>('idle');
  let categories = $state<OsmCategory[]>([]);
  let selected = $state<Set<string>>(new Set());
  let errorMsg = $state('');
  let sampleProgress = $state<SampleProgress | null>(null);
  let resultMsg = $state('');
  let abortCtrl = $state<AbortController | null>(null);
  let embeddingTileCount = $state(0);

  // Track embedding loads
  $effect(() => {
    const mgr = $sourceManager;
    if (!mgr) { embeddingTileCount = 0; return; }
    embeddingTileCount = mgr.totalTileCount();
    const handler = () => { embeddingTileCount = mgr.totalTileCount(); };
    mgr.on('embeddings-loaded', handler);
    return () => mgr.off('embeddings-loaded', handler);
  });

  const canQuery = $derived(embeddingTileCount > 0);

  // Auto-query when modal opens with embeddings ready
  $effect(() => {
    if (open && canQuery && phase === 'idle' && categories.length === 0) {
      handleQuery();
    }
  });

  // Auto-import all categories when in tutorial mode
  $effect(() => {
    if (autoImport && phase === 'selecting' && selected.size > 0) {
      handleImport();
    }
  });

  function handleClose() {
    abortCtrl?.abort();
    open = false;
    // Reset state for next open
    phase = 'idle';
    categories = [];
    selected = new Set();
    sampleProgress = null;
    resultMsg = '';
    errorMsg = '';
  }

  async function handleQuery() {
    const mgr = $sourceManager;
    if (!mgr) return;
    const bbox = mgr.embeddingBoundsLngLat();
    if (!bbox) return;

    phase = 'querying';
    errorMsg = '';
    const ctrl = new AbortController();
    abortCtrl = ctrl;

    try {
      categories = await queryOverpass(bbox, ctrl.signal);
      if (categories.length === 0) {
        errorMsg = 'No OSM features found in the loaded tile area.';
        phase = 'error';
        return;
      }
      // Pre-select all
      selected = new Set(categories.map(c => c.tag));
      phase = 'selecting';
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        phase = 'idle';
      } else {
        errorMsg = (e as Error).message;
        phase = 'error';
      }
    } finally {
      abortCtrl = null;
    }
  }

  function toggleCategory(tag: string) {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    selected = next;
  }

  function selectAll() {
    selected = new Set(categories.map(c => c.tag));
  }

  function selectNone() {
    selected = new Set();
  }

  async function handleImport() {
    const mgr = $sourceManager;
    if (!mgr) return;

    const regions = mgr.getEmbeddingRegions();
    if (regions.size === 0) return;

    const chosen = categories.filter(c => selected.has(c.tag));
    if (chosen.length === 0) return;

    phase = 'sampling';
    sampleProgress = null;

    try {
      // Sample from all zones and merge
      const sampled = new Map<string, Array<{ lngLat: [number, number]; embeddingAt: import('@ucam-eo/maplibre-zarr-tessera').EmbeddingAt }>>();
      for (const [zoneId] of regions) {
        const src = mgr.getOpenSource(zoneId);
        if (!src) continue;
        const zoneSampled = await sampleOsmCategories(src, chosen, (p) => {
          sampleProgress = p;
        });
        for (const [tag, samples] of zoneSampled) {
          const existing = sampled.get(tag) ?? [];
          existing.push(...samples);
          sampled.set(tag, existing);
        }
      }

      // Build class definitions and label map for import
      const newClasses = chosen
        .filter(c => sampled.has(c.tag))
        .map(c => ({ name: c.displayName, color: c.suggestedColor }));

      const newLabels = new Map<string, Array<{ lngLat: [number, number]; embeddingAt: import('@ucam-eo/maplibre-zarr-tessera').EmbeddingAt }>>();
      for (const c of chosen) {
        const s = sampled.get(c.tag);
        if (s && s.length > 0) {
          newLabels.set(c.displayName, s);
        }
      }

      const { classesCreated, labelsImported } = importOsmLabels(newClasses, newLabels);
      resultMsg = `Imported ${labelsImported} labels across ${classesCreated + (newClasses.length - classesCreated)} classes (${classesCreated} new)`;
      phase = 'done';
    } catch (e) {
      errorMsg = (e as Error).message;
      phase = 'error';
    } finally {
      sampleProgress = null;
    }
  }

  function handleRetry() {
    phase = 'idle';
    errorMsg = '';
    handleQuery();
  }
</script>

{#if open}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onkeydown={(e) => e.key === 'Escape' && handleClose()}
  >
    <!-- Modal -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-gray-950 border border-gray-700/80 rounded-lg shadow-2xl shadow-cyan-900/30
             w-[400px] max-w-[90vw] font-mono text-gray-300 text-xs"
      onmousedown={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="px-5 py-4 border-b border-gray-800/60 flex items-center justify-between">
        <div>
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
            <h2 class="text-term-cyan text-sm font-bold tracking-[0.2em] uppercase">Import from OSM</h2>
          </div>
          <p class="text-gray-600 text-[10px] mt-0.5 tracking-wider">
            {#if phase === 'idle' || phase === 'querying'}
              Querying OpenStreetMap features in view
            {:else if phase === 'selecting'}
              Select categories to import as training labels
            {:else if phase === 'sampling'}
              Sampling embeddings from OSM polygons
            {:else if phase === 'done'}
              Import complete
            {:else}
              Error
            {/if}
          </p>
        </div>
        <button
          onclick={handleClose}
          class="text-gray-600 hover:text-gray-300 text-lg leading-none transition-colors px-1"
        >&times;</button>
      </div>

      <!-- Body -->
      <div class="px-5 py-4">
        {#if phase === 'idle'}
          {#if !canQuery}
            <div class="text-[11px] text-gray-500 text-center py-6">
              Draw a region to load embeddings first
            </div>
          {:else}
            <div class="flex items-center justify-center py-6">
              <button
                onclick={handleQuery}
                class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[11px]
                       px-5 py-2 rounded tracking-wider transition-all
                       hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95"
              >QUERY OSM</button>
            </div>
          {/if}

        {:else if phase === 'querying'}
          <div class="flex items-center justify-center gap-3 py-6">
            <div class="w-4 h-4 border-2 border-term-cyan/60 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-[11px] text-gray-400">Querying Overpass API...</span>
          </div>

        {:else if phase === 'selecting'}
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] text-gray-500">{categories.length} categories found</span>
            <div class="flex gap-3">
              <button onclick={selectAll}
                class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">All</button>
              <button onclick={selectNone}
                class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">None</button>
            </div>
          </div>
          <div class="max-h-[40vh] overflow-y-auto space-y-0.5 pr-1 scrollbar-thin border border-gray-800/40 rounded p-1">
            {#each categories as cat}
              <label class="flex items-center gap-2.5 px-2 py-1 rounded cursor-pointer
                            hover:bg-gray-900/60 transition-colors">
                <input
                  type="checkbox"
                  checked={selected.has(cat.tag)}
                  onchange={() => toggleCategory(cat.tag)}
                  class="w-3.5 h-3.5 accent-[var(--accent)]"
                  style="--accent: {cat.suggestedColor}"
                />
                <span class="w-3 h-3 rounded-sm shrink-0" style="background: {cat.suggestedColor}"></span>
                <span class="text-[11px] text-gray-300 flex-1 truncate">{cat.displayName}</span>
                <span class="text-[10px] text-gray-600 tabular-nums">{cat.polygons.length} poly</span>
              </label>
            {/each}
          </div>

        {:else if phase === 'sampling'}
          <div class="py-4 space-y-3">
            <div class="flex items-center justify-center gap-3">
              <div class="w-4 h-4 border-2 border-term-cyan/60 border-t-transparent rounded-full animate-spin"></div>
              <span class="text-[11px] text-gray-400">Sampling embeddings...</span>
            </div>
            {#if sampleProgress}
              <div class="text-[11px] text-gray-500 tabular-nums text-center">
                {sampleProgress.categoryName}: {sampleProgress.samplesCollected} samples
                ({sampleProgress.categoryIndex}/{sampleProgress.categoryTotal})
              </div>
              <div class="h-2 bg-gray-900 rounded-full overflow-hidden">
                <div class="h-full bg-term-cyan rounded-full transition-all duration-150"
                     style="width: {Math.round((sampleProgress.categoryIndex / sampleProgress.categoryTotal) * 100)}%"></div>
              </div>
            {/if}
          </div>

        {:else if phase === 'done'}
          <div class="py-4 text-center space-y-2">
            <div class="text-green-400 text-[12px]">{resultMsg}</div>
          </div>

        {:else if phase === 'error'}
          <div class="py-4 text-center space-y-2">
            <div class="text-red-400 text-[11px]">{errorMsg}</div>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 border-t border-gray-800/60 flex justify-end gap-2">
        {#if phase === 'selecting'}
          <button
            onclick={handleClose}
            class="text-[10px] text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded
                   border border-gray-700/60 hover:border-gray-500 transition-all"
          >CANCEL</button>
          <button
            onclick={handleImport}
            disabled={selected.size === 0}
            class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[11px]
                   px-4 py-1.5 rounded tracking-wider transition-all
                   hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
                   disabled:opacity-40 disabled:pointer-events-none"
          >IMPORT {selected.size} CATEGORIES</button>
        {:else if phase === 'done'}
          <button
            onclick={handleClose}
            class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[11px]
                   px-4 py-1.5 rounded tracking-wider transition-all
                   hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95"
          >DONE</button>
        {:else if phase === 'error'}
          <button
            onclick={handleClose}
            class="text-[10px] text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded
                   border border-gray-700/60 hover:border-gray-500 transition-all"
          >CLOSE</button>
          <button
            onclick={handleRetry}
            class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[11px]
                   px-4 py-1.5 rounded tracking-wider transition-all
                   hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95"
          >RETRY</button>
        {:else if phase === 'querying'}
          <button
            onclick={handleClose}
            class="text-[10px] text-gray-500 hover:text-red-400 px-3 py-1.5 rounded
                   border border-gray-700/60 hover:border-red-400/40 transition-all"
          >CANCEL</button>
        {/if}
      </div>
    </div>
  </div>
{/if}
