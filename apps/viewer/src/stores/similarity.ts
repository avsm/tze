import { writable } from 'svelte/store';
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';

/** Per-zone similarity results. Empty map = no computation. */
export const simScores = writable<Map<string, SimilarityResult>>(new Map());
export const simRefEmbedding = writable<Float32Array | null>(null);
export const simSelectedPixel = writable<{ ci: number; cj: number; row: number; col: number; lng: number; lat: number } | null>(null);
export const simThreshold = writable(0.5);
export const simEmbeddingTileCount = writable(0);
