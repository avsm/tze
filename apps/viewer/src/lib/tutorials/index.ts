import { registerTutorial } from '../../stores/tutorial';
import { understandingEmbeddings } from './understanding-embeddings';
import { classifyWithOsm } from './classify-with-osm';
import { segmentationTutorial } from './segmentation';

export function registerAllTutorials() {
  registerTutorial(understandingEmbeddings);
  registerTutorial(classifyWithOsm);
  registerTutorial(segmentationTutorial);
}
