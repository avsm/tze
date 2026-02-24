<script lang="ts">
  import { zarrSource, metadata, opacity, preview, gridVisible, utmBoundaryVisible } from '../stores/zarr';

  const enabled = $derived(!!$metadata);

  function updateOpacity(val: number) {
    $opacity = val;
    $zarrSource?.setOpacity(val);
  }

  function toggleGrid() {
    $gridVisible = !$gridVisible;
    $zarrSource?.setGridVisible($gridVisible);
  }

  function toggleUtm() {
    $utmBoundaryVisible = !$utmBoundaryVisible;
    $zarrSource?.setUtmBoundaryVisible($utmBoundaryVisible);
  }

  function setPreview(mode: 'rgb' | 'pca' | 'bands') {
    $preview = mode;
    $zarrSource?.setPreview(mode);
  }
</script>

<!-- Opacity -->
<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <div class="flex items-center justify-between">
    <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Opacity</label>
    <span class="text-term-cyan/70 tabular-nums text-[11px]">{$opacity.toFixed(2)}</span>
  </div>
  <input type="range" min="0" max="100" value={Math.round($opacity * 100)}
         oninput={(e) => updateOpacity(parseInt((e.target as HTMLInputElement).value) / 100)}
         class="w-full h-1 mt-1.5" />
</div>

<!-- Preview mode -->
{#if $metadata?.hasRgb || $metadata?.hasPca}
  <div class="px-4 py-3 border-b border-gray-800/60">
    <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Preview</label>
    <div class="mt-2 flex gap-1.5">
      {#if $metadata?.hasRgb}
        <button onclick={() => setPreview('rgb')}
                class="flex-1 text-[10px] font-bold tracking-wider py-1.5 rounded border transition-all
                       {$preview === 'rgb' ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40' : 'bg-gray-950 text-gray-500 border-gray-700/60'}">
          RGB
        </button>
      {/if}
      {#if $metadata?.hasPca}
        <button onclick={() => setPreview('pca')}
                class="flex-1 text-[10px] font-bold tracking-wider py-1.5 rounded border transition-all
                       {$preview === 'pca' ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40' : 'bg-gray-950 text-gray-500 border-gray-700/60'}">
          PCA
        </button>
      {/if}
    </div>
  </div>
{/if}

<!-- Overlays -->
<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Overlays</label>
  <div class="mt-2 space-y-1.5">
    <label class="flex items-center gap-2 cursor-pointer group">
      <input type="checkbox" checked={$gridVisible} onchange={toggleGrid}
             class="w-3 h-3 rounded accent-[#00e5ff]" />
      <span class="text-[11px] group-hover:text-term-cyan transition-colors">Chunk grid</span>
    </label>
    <label class="flex items-center gap-2 cursor-pointer group">
      <input type="checkbox" checked={$utmBoundaryVisible} onchange={toggleUtm}
             class="w-3 h-3 rounded accent-[#39ff14]" />
      <span class="text-[11px] group-hover:text-term-green transition-colors">UTM zone</span>
    </label>
  </div>
</div>
