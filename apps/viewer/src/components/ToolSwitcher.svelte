<script lang="ts">
  import { activeTool, type ToolId } from '../stores/tools';
  import { sourceManager, metadata } from '../stores/zarr';
  import { segmentVisible } from '../stores/segmentation';
  import { get } from 'svelte/store';
  import SimilaritySearch from './SimilaritySearch.svelte';
  import LabelPanel from './LabelPanel.svelte';
  import SegmentPanel from './SegmentPanel.svelte';

  const enabled = $derived(!!$metadata);

  let { similarityRef = $bindable(), onOpenOsm }: { similarityRef?: SimilaritySearch; onOpenOsm?: () => void } = $props();

  // Handle tool transition side effects reactively (tabs are in TopBar now)
  let prevTool: ToolId | null = null;
  $effect(() => {
    const tool = $activeTool;
    if (prevTool !== null && prevTool !== tool) {
      if (prevTool === 'segmenter') segmentVisible.set(false);
      get(sourceManager)?.clearClassificationOverlays();
      if (tool === 'segmenter') segmentVisible.set(true);
      if (tool === 'similarity') similarityRef?.restoreOverlays();
    }
    prevTool = tool;
  });
</script>

<div class="transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>

  <!-- Active tool panel -->
  <div class="px-3 py-3">
    <!-- SimilaritySearch always mounted (preserves UMAP state), hidden via CSS -->
    <div class:hidden={$activeTool !== 'similarity'}>
      <SimilaritySearch bind:this={similarityRef} />
    </div>
    {#if $activeTool === 'classifier'}
      <LabelPanel onOpenOsm={onOpenOsm} />
    {:else if $activeTool === 'segmenter'}
      <SegmentPanel />
    {/if}
  </div>
</div>
