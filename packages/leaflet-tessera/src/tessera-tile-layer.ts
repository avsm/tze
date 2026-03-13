import * as L from 'leaflet';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

/**
 * Leaflet TileLayer that renders TESSERA RGB tiles from a Zarr pyramid.
 *
 * @remarks
 * Uses {@link TesseraTileRenderer} to fetch and render tiles. Each tile
 * is rendered as a PNG and displayed as an `<img>` element.
 *
 * @example
 * ```typescript
 * const layer = new TesseraTileLayer(
 *   'https://dl2.geotessera.org/zarr/v1/2025.zarr/global_rgb',
 *   { variable: 'rgb' },
 * );
 * layer.addTo(map);
 * ```
 */
export class TesseraTileLayer extends L.TileLayer {
  private renderer: TesseraTileRenderer;

  constructor(
    url: string,
    options?: L.TileLayerOptions & { variable?: string },
  ) {
    super('', options); // Empty URL template — we override createTile
    this.renderer = new TesseraTileRenderer(url, {
      variable: options?.variable ?? 'rgb',
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLImageElement {
    const img = document.createElement('img');
    this.renderer
      .renderTile(coords.z, coords.x, coords.y)
      .then((data) => {
        if (data.byteLength === 0) {
          done(undefined, img);
          return;
        }
        const blob = new Blob([data], { type: 'image/png' });
        img.src = URL.createObjectURL(blob);
        done(undefined, img);
      })
      .catch((err) => {
        done(err, img);
      });
    return img;
  }

  /** Switch the rendered Zarr variable and refresh tiles. */
  setVariable(variable: string): void {
    this.renderer.setVariable(variable);
    this.redraw();
  }
}
