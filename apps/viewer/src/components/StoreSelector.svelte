<script lang="ts">
  import { ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';
  import { mapInstance } from '../stores/map';
  import {
    zarrSource, metadata, status, loading, bands, opacity, preview,
    recentStores, addRecentStore,
  } from '../stores/zarr';

  let urlInput = $state('');
  let isLoading = $state(false);

  async function loadStore() {
    const url = urlInput.trim().replace(/\/+$/, '');
    if (!url || !$mapInstance) return;

    isLoading = true;
    $status = 'Connecting...';

    // Remove previous source
    $zarrSource?.remove();
    $zarrSource = null;
    $metadata = null;

    try {
      const source = new ZarrTesseraSource({
        url,
        bands: $bands,
        opacity: $opacity,
        preview: $preview,
      });

      source.on('metadata-loaded', (meta) => {
        $metadata = meta;
        $status = `Loaded: zone ${meta.utmZone}`;
      });
      source.on('loading', (progress) => { $loading = progress; });
      source.on('error', (err) => { $status = `Error: ${err.message}`; });

      await source.addTo($mapInstance);
      $zarrSource = source;
      addRecentStore(url);
    } catch (err) {
      $status = `Error: ${(err as Error).message}`;
    } finally {
      isLoading = false;
    }
  }

  function selectRecent(url: string) {
    urlInput = url;
    loadStore();
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Store URL</label>
  <div class="flex gap-1.5 mt-1.5">
    <input
      type="text"
      bind:value={urlInput}
      placeholder="https://host/utm30_2025.zarr"
      onkeydown={(e) => e.key === 'Enter' && loadStore()}
      class="flex-1 bg-gray-950 border border-gray-700/60 rounded px-2 py-1.5
             text-gray-300 text-[11px] focus:border-term-cyan/60 focus:outline-none
             focus:shadow-[0_0_8px_rgba(0,229,255,0.15)] transition-all
             placeholder-gray-700"
    />
    <button
      onclick={loadStore}
      disabled={isLoading}
      class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
             px-3 py-1.5 rounded tracking-wider transition-all
             hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
             disabled:opacity-50"
    >
      {isLoading ? '...' : 'LOAD'}
    </button>
  </div>

  {#if $recentStores.length > 0}
    <details class="mt-1.5">
      <summary class="text-[10px] text-gray-600 cursor-pointer hover:text-gray-400 transition-colors">
        Recent ({$recentStores.length})
      </summary>
      <div class="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
        {#each $recentStores as url}
          <button
            onclick={() => selectRecent(url)}
            class="block w-full text-left text-[10px] text-gray-500 hover:text-term-cyan
                   truncate px-1 py-0.5 rounded hover:bg-gray-900/50 transition-colors"
          >
            {url}
          </button>
        {/each}
      </div>
    </details>
  {/if}

  <div class="mt-1.5 text-[10px] text-gray-600 truncate">{$status}</div>
</div>
