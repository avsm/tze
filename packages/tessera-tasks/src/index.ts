// @ucam-eo/tessera-tasks — analysis algorithms for TESSERA embeddings

export {
  computeSimilarityScores,
  renderSimilarityCanvas,
  type SimilarityResult,
} from './similarity.js';

export {
  classifyTiles,
  type ClassDef,
  type LabelSource,
  type LabelPoint,
  type ClassificationResult,
  type ClassifyProgress,
  type OnBatchUpdate,
} from './classify.js';

export {
  SegmentationSession,
  type SegmentationSessionOptions,
  type SegmentResult,
} from './segment.js';

export { ClassificationStore } from './classification-store.js';
