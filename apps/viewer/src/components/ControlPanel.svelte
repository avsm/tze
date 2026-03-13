<script lang="ts">
  import { displayManager, metadata, opacity } from '../stores/zarr';

  const visible = $derived(!!$metadata);

  function updateOpacity(val: number) {
    $opacity = val;
    $displayManager?.setOpacity(val);
  }
</script>

{#if visible}
  <div class="px-3 py-2.5 border-b border-gray-800/60">
    <div class="flex items-center gap-1.5">
      <span class="text-gray-500 text-[10px] shrink-0">Opacity</span>
      <input type="range" min="0" max="100" value={Math.round($opacity * 100)}
             oninput={(e) => updateOpacity(parseInt((e.target as HTMLInputElement).value) / 100)}
             title="Opacity {$opacity.toFixed(2)}"
             class="flex-1 h-1 accent-[#00e5ff] min-w-0" />
      <span class="text-term-cyan/60 tabular-nums text-[10px] w-7 text-right shrink-0">{$opacity.toFixed(2)}</span>
    </div>
  </div>
{/if}
