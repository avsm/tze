import proj4 from 'proj4';
import type { UtmBounds } from './types.js';

/**
 * Bidirectional converter between WGS84 (longitude/latitude) and
 * UTM (easting/northing) coordinates.
 *
 * @remarks
 * Uses proj4 internally. Derives the UTM zone and hemisphere from
 * the EPSG code (e.g. 32633 → zone 33 North, 32733 → zone 33 South).
 *
 * @example
 * ```typescript
 * const proj = new UtmProjection(32633);
 * const [easting, northing] = proj.forward(13.4, 52.5);
 * const [lng, lat] = proj.inverse(easting, northing);
 * ```
 */
export class UtmProjection {
  /** EPSG code this projection was created with. */
  readonly epsg: number;

  /** UTM zone number (1–60). */
  readonly zone: number;

  /** Whether this is a southern hemisphere zone. */
  readonly isSouth: boolean;

  private proj: proj4.Converter;

  /**
   * @param epsg - EPSG code for a UTM CRS (32601–32660 for north,
   *   32701–32760 for south).
   */
  constructor(epsg: number) {
    this.epsg = epsg;
    this.isSouth = epsg >= 32700 && epsg <= 32760;
    this.zone = this.isSouth ? epsg - 32700 : epsg - 32600;

    const def = `+proj=utm +zone=${this.zone}${this.isSouth ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    this.proj = proj4('EPSG:4326', def);
  }

  /**
   * Project WGS84 → UTM.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns `[easting, northing]` in metres.
   */
  forward(lng: number, lat: number): [number, number] {
    const [e, n] = this.proj.forward([lng, lat]);
    return [e, n];
  }

  /**
   * Project UTM → WGS84.
   *
   * @param easting - Easting in metres.
   * @param northing - Northing in metres.
   * @returns `[longitude, latitude]` in degrees.
   */
  inverse(easting: number, northing: number): [number, number] {
    const [lng, lat] = this.proj.inverse([easting, northing]);
    return [lng, lat];
  }

  /**
   * Convert UTM bounding box to WGS84 corner coordinates.
   *
   * @param bounds - UTM bounds using easting/northing conventions.
   * @returns Four `[lng, lat]` pairs: `[TL, TR, BR, BL]`.
   */
  chunkCornersToLngLat(bounds: UtmBounds): [[number, number], [number, number], [number, number], [number, number]] {
    const tl = this.inverse(bounds.minE, bounds.maxN);
    const tr = this.inverse(bounds.maxE, bounds.maxN);
    const br = this.inverse(bounds.maxE, bounds.minN);
    const bl = this.inverse(bounds.minE, bounds.minN);
    return [tl, tr, br, bl];
  }
}
