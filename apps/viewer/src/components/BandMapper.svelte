<script lang="ts">
  import { bands, displayManager, metadata } from '../stores/zarr';

  let r = $state($bands[0]);
  let g = $state($bands[1]);
  let b = $state($bands[2]);

  function updateBands() {
    $bands = [r, g, b];
    $displayManager?.setBands([r, g, b]);
  }

  const enabled = $derived(!!$metadata);
</script>

<div class="px-3 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Band Mapping</span>
  <div class="mt-2 space-y-2">
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                   bg-red-500/20 text-red-400 border border-red-500/30">R</span>
      <input type="range" min="0" max="127" bind:value={r}
             oninput={() => updateBands()}
             class="flex-1 h-1" />
      <span class="w-6 text-right text-red-400 tabular-nums text-[11px]">{r}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                   bg-green-500/20 text-green-400 border border-green-500/30">G</span>
      <input type="range" min="0" max="127" bind:value={g}
             oninput={() => updateBands()}
             class="flex-1 h-1" />
      <span class="w-6 text-right text-green-400 tabular-nums text-[11px]">{g}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                   bg-blue-500/20 text-blue-400 border border-blue-500/30">B</span>
      <input type="range" min="0" max="127" bind:value={b}
             oninput={() => updateBands()}
             class="flex-1 h-1" />
      <span class="w-6 text-right text-blue-400 tabular-nums text-[11px]">{b}</span>
    </div>
  </div>
</div>
