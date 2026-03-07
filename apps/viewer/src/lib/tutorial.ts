import type { Map as MaplibreMap } from 'maplibre-gl';
import type { ZarrSourceManager } from '@ucam-eo/maplibre-zarr-tessera';
import type { Writable, Readable } from 'svelte/store';
import type { ToolId } from '../stores/tools';
import type { StoreMetadata } from '@ucam-eo/maplibre-zarr-tessera';
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';
import type { ClassDef, LabelPoint } from '../stores/classifier';

export type StepTrigger =
  | { kind: 'click' }
  | { kind: 'action-complete' }
  | { kind: 'timeout'; ms: number };

export type ArrowDirection = 'top' | 'bottom' | 'left' | 'right' | 'none';

export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  html?: string;
  diagram?: { title: string; html: string; url?: string };
  highlight?: string;
  arrow?: ArrowDirection;
  action?: (ctx: TutorialContext) => Promise<void> | void;
  trigger?: StepTrigger;
  spotlight?: boolean;
  delay?: number;
}

export interface TutorialDef {
  id: string;
  name: string;
  description: string;
  steps: TutorialStep[];
}

export interface TutorialContext {
  map: MaplibreMap;
  manager: ZarrSourceManager;
  stores: {
    activeTool: Writable<ToolId>;
    simThreshold: Writable<number>;
    sourceManager: Writable<ZarrSourceManager | null>;
    metadata: Readable<StoreMetadata | null>;
    simScores: Writable<Map<string, SimilarityResult>>;
    simRefEmbedding: Writable<Float32Array | null>;
    simSelectedPixel: Writable<{ ci: number; cj: number; row: number; col: number; lng: number; lat: number } | null>;
    simEmbeddingTileCount: Writable<number>;
    classes: Writable<ClassDef[]>;
    labels: Writable<LabelPoint[]>;
    isClassified: Writable<boolean>;
    classificationOpacity: Writable<number>;
    kValue: Writable<number>;
    confidenceThreshold: Writable<number>;
  };
  flyTo(opts: { center: [number, number]; zoom?: number; duration?: number }): Promise<void>;
  waitForEvent(event: string, timeout?: number): Promise<void>;
  /** Ensure the zone source at the given coordinate is open and ready. */
  ensureZoneAt(lng: number, lat: number): Promise<void>;
  similarityClick(lng: number, lat: number): void;
  openOsmModal(opts?: { autoImport?: boolean }): void;
  closeOsmModal(): void;
  switchBasemap(id: 'osm' | 'satellite' | 'dark'): void;
}
