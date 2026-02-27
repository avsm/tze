<script lang="ts">
  import { Search, Tags, Sun } from 'lucide-svelte';
  import { activeTool, type ToolId } from '../stores/tools';
  import { zarrSource, metadata } from '../stores/zarr';
  import SimilaritySearch from './SimilaritySearch.svelte';
  import LabelPanel from './LabelPanel.svelte';
  import SegmentPanel from './SegmentPanel.svelte';

  const enabled = $derived(!!$metadata);

  const tools: { id: ToolId; label: string; icon: typeof Search }[] = [
    { id: 'similarity', label: 'Similar', icon: Search },
    { id: 'classifier', label: 'Classify', icon: Tags },
    { id: 'segmenter',  label: 'Solar',   icon: Sun },
  ];

  let { similarityRef = $bindable() }: { similarityRef?: SimilaritySearch } = $props();

  function switchTool(id: ToolId) {
    if (id === $activeTool) return;
    $zarrSource?.clearClassificationOverlays();
    $activeTool = id;
  }
</script>

<div class="transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>

  <!-- Tool tabs -->
  <div class="flex border-b border-gray-800/60">
    {#each tools as tool}
      <button
        onclick={() => switchTool(tool.id)}
        class="flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] font-bold
               tracking-wider transition-all border-b-2 -mb-px
               {$activeTool === tool.id
                 ? 'text-term-cyan border-term-cyan'
                 : 'text-gray-600 border-transparent hover:text-gray-400'}"
      >
        <tool.icon size={12} />
        {tool.label}
      </button>
    {/each}
  </div>

  <!-- Active tool panel -->
  <div class="px-4 py-3">
    {#if $activeTool === 'similarity'}
      <SimilaritySearch bind:this={similarityRef} />
    {:else if $activeTool === 'classifier'}
      <LabelPanel />
    {:else if $activeTool === 'segmenter'}
      <SegmentPanel />
    {/if}
  </div>
</div>
