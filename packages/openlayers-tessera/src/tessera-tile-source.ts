import XYZ from 'ol/source/XYZ';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

/**
 * OpenLayers tile source that renders TESSERA RGB tiles from a Zarr pyramid.
 *
 * @remarks
 * Uses {@link TesseraTileRenderer} to fetch and render tiles. Integrates
 * with OpenLayers' XYZ source via a custom tile loader function.
 *
 * @example
 * ```typescript
 * import TileLayer from 'ol/layer/Tile';
 * const source = new TesseraTileSource({
 *   url: 'https://dl2.geotessera.org/zarr/v1/2025.zarr/global_rgb',
 *   variable: 'rgb',
 * });
 * const layer = new TileLayer({ source });
 * map.addLayer(layer);
 * ```
 */
export class TesseraTileSource extends XYZ {
  private renderer: TesseraTileRenderer;

  constructor(options: {
    url: string;
    variable?: string;
    attributions?: string;
  }) {
    super({
      attributions: options.attributions,
      tileLoadFunction: (tile, _src) => {
        const imageTile = tile as import('ol/Tile').default & { getImage: () => HTMLImageElement };
        const img = imageTile.getImage() as HTMLImageElement;
        const coord = tile.getTileCoord(); // [z, x, y]
        const z = coord[0];
        const x = coord[1];
        const y = coord[2];

        this.renderer
          .renderTile(z, x, y)
          .then((data) => {
            if (data.byteLength === 0) return;
            const blob = new Blob([data], { type: 'image/png' });
            img.src = URL.createObjectURL(blob);
          })
          .catch((err) => {
            console.error('[TesseraTileSource] Tile render failed:', err);
          });
      },
    });

    this.renderer = new TesseraTileRenderer(options.url, {
      variable: options.variable ?? 'rgb',
    });
  }

  /** Switch the rendered Zarr variable and refresh tiles. */
  setVariable(variable: string): void {
    this.renderer.setVariable(variable);
    this.refresh();
  }
}
