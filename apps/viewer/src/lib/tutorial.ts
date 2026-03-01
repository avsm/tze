import type { Map as MaplibreMap } from 'maplibre-gl';
import type { ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';
import type { Writable, Readable } from 'svelte/store';
import type { ToolId } from '../stores/tools';
import type { StoreMetadata } from '@ucam-eo/maplibre-zarr-tessera';
import type { TileSimilarity } from './similarity';
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
  /** Optional HTML content rendered below the description text. */
  html?: string;
  /** Optional HTML content shown in a separate floating diagram panel. */
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
  zarrSource: ZarrTesseraSource | null;
  stores: {
    activeTool: Writable<ToolId>;
    simThreshold: Writable<number>;
    zarrSource: Writable<ZarrTesseraSource | null>;
    metadata: Readable<StoreMetadata | null>;
    simScores: Writable<TileSimilarity[]>;
    simRefEmbedding: Writable<Float32Array | null>;
    simSelectedPixel: Writable<{ ci: number; cj: number; row: number; col: number } | null>;
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
  similarityClick(lng: number, lat: number): void;
  openOsmModal(opts?: { autoImport?: boolean }): void;
  closeOsmModal(): void;
  switchBasemap(id: 'osm' | 'satellite' | 'dark'): void;
}
