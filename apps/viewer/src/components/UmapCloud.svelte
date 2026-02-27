<script lang="ts">
  import { onMount } from 'svelte';
  import { zarrSource } from '../stores/zarr';
  import { subsampleEmbeddings } from '../lib/umap-subsample';
  import { PointCloudRenderer } from '../lib/point-cloud-renderer';
  import type { TileSimilarity } from '../lib/similarity';
  import type { UmapWorkerInput, UmapWorkerOutput } from '../lib/umap-worker';

  interface Props {
    cachedScores: TileSimilarity[];
    refEmbedding: Float32Array;
    selectedPixel: { ci: number; cj: number; row: number; col: number };
    threshold: number;
    embeddingTileCount: number;
  }

  let { cachedScores, refEmbedding, selectedPixel, threshold, embeddingTileCount }: Props = $props();

  let canvasEl: HTMLCanvasElement;
  let renderer: PointCloudRenderer | null = null;
  let worker: Worker | null = null;
  let status = $state('');
  let currentScores: Float32Array | null = null;
  let currentRefIndex = -1;

  /** Build RGBA color array with threshold highlighting.
   *  Above threshold: bright score color. Below: dimmed. Ref pixel: white. */
  function buildColors(scores: Float32Array, refIndex: number, thresh: number): Uint8Array {
    const n = scores.length;
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = scores[i];
      const off = i * 4;
      if (i === refIndex) {
        colors[off] = 255; colors[off + 1] = 255; colors[off + 2] = 255; colors[off + 3] = 255;
      } else if (s >= thresh) {
        // Above threshold: bright — lerp from cyan (0,220,255) to white (255,255,255)
        const t = thresh < 1 ? (s - thresh) / (1 - thresh) : 1;
        colors[off]     = Math.round(40 + 215 * t);
        colors[off + 1] = Math.round(220 + 35 * t);
        colors[off + 2] = 255;
        colors[off + 3] = 255;
      } else {
        // Below threshold: warm orange-red graded by score
        const t = thresh > 0 ? s / thresh : 0;
        colors[off]     = Math.round(60 + 120 * t);  // 60→180
        colors[off + 1] = Math.round(20 + 40 * t);   // 20→60
        colors[off + 2] = Math.round(15 + 15 * t);   // 15→30
        colors[off + 3] = 255;
      }
    }
    return colors;
  }

  function killWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  async function runUmap() {
    const src = $zarrSource;
    if (!src || cachedScores.length === 0 || !refEmbedding) return;

    killWorker();

    status = 'Sampling...';

    const sample = subsampleEmbeddings(
      src.embeddingCache,
      cachedScores,
      refEmbedding,
      selectedPixel,
    );

    if (sample.count < 4) {
      status = 'Too few points';
      return;
    }

    status = `UMAP ${sample.count} pts...`;

    // Create worker using Vite module worker pattern
    const w = new Worker(new URL('../lib/umap-worker.ts', import.meta.url), { type: 'module' });
    worker = w;

    w.postMessage(
      { embeddings: sample.embeddings, count: sample.count, nBands: sample.nBands } satisfies UmapWorkerInput,
      { transfer: [sample.embeddings.buffer] },
    );

    w.onmessage = (e: MessageEvent<UmapWorkerOutput>) => {
      // Guard: if worker was replaced, ignore stale results
      if (worker !== w) return;

      const { positions } = e.data;
      currentScores = sample.scores;
      currentRefIndex = sample.refIndex;
      const colors = buildColors(sample.scores, sample.refIndex, threshold);

      if (!renderer) {
        renderer = new PointCloudRenderer(canvasEl);
      }
      renderer.setData(positions, colors, sample.refIndex);
      renderer.start();

      status = `${sample.count} points`;
      w.terminate();
      worker = null;
    };

    w.onerror = (err) => {
      if (worker !== w) return;
      console.error('UMAP worker error:', err);
      status = 'UMAP failed';
      w.terminate();
      worker = null;
    };
  }

  // Trigger UMAP when cachedScores changes (new pixel click or new tiles loaded)
  $effect(() => {
    // Access reactive deps
    const _scores = cachedScores;
    const _ref = refEmbedding;
    const _pixel = selectedPixel;
    const _tileCount = embeddingTileCount;
    if (_scores.length > 0 && _ref && _pixel) {
      runUmap();
    }
  });

  // Recolor points when threshold changes (no UMAP re-run)
  $effect(() => {
    const t = threshold;
    if (renderer && currentScores) {
      const colors = buildColors(currentScores, currentRefIndex, t);
      renderer.updateColors(colors);
    }
  });

  onMount(() => {
    return () => {
      killWorker();
      renderer?.dispose();
      renderer = null;
    };
  });
</script>

<div class="flex flex-col items-center gap-1">
  <canvas
    bind:this={canvasEl}
    width={400}
    height={400}
    class="w-[200px] h-[200px] rounded border border-gray-700/40"
  ></canvas>
  {#if status}
    <div class="text-[9px] text-gray-500">{status}</div>
  {/if}
</div>
