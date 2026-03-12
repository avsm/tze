export interface ZoneDescriptor {
  id: string;                // e.g. "utm30_2025"
  utmZone: number;           // e.g. 30
  epsg: number;              // e.g. 32630
  bbox: [number, number, number, number]; // [w, s, e, n] WGS84
  geometry: GeoJSON.Polygon;
  zarrUrl: string;           // resolved absolute URL
  title?: string;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json();
}

/** Extract links with a given rel from a STAC object's links array. */
function linksWithRel(data: StacObject, rel: string): StacLink[] {
  return (data.links ?? []).filter((l) => l.rel === rel);
}

interface StacLink { rel: string; href: string; type?: string; title?: string }
interface StacObject {
  type?: string;
  id?: string;
  links?: StacLink[];
  properties?: Record<string, unknown>;
  assets?: Record<string, { href: string }>;
  bbox?: [number, number, number, number];
  geometry?: GeoJSON.Polygon;
  title?: string;
  [key: string]: unknown;
}

/**
 * Fetch a STAC catalog and walk its children/items to discover all UTM zone zarr stores.
 * Returns an array of ZoneDescriptor sorted by utmZone.
 */
export interface CatalogResult {
  zones: ZoneDescriptor[];
  availableYears: string[];               // e.g. ["2024", "2025"]
  globalPreviewUrls: Record<string, string>;  // year → preview zarr URL
  globalPreviewUrl: string | null;         // keep for back-compat (latest year)
  /** Union of all zone bounding boxes [west, south, east, north] */
  globalBounds: [number, number, number, number] | null;
}

export async function loadCatalog(catalogUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const zones: ZoneDescriptor[] = [];
  let globalBounds: [number, number, number, number] | null = null;

  // Resolve relative catalog URLs against the page origin so that
  // new URL(href, base) works for relative STAC link resolution,
  // and fetch() routes through the Vite/proxy server.
  const resolvedCatalogUrl = new URL(catalogUrl, window.location.href).href;

  // 1. Fetch the root catalog (plain JSON — no stac-js, which mangles STAC 1.1 links)
  const catalog = await fetchJson(resolvedCatalogUrl, signal) as StacObject;

  // 2. Follow child links (rel=child → collections)
  const childLinks = linksWithRel(catalog, 'child');
  for (const link of childLinks) {
    const collectionUrl = new URL(link.href, resolvedCatalogUrl).href;
    const collection = await fetchJson(collectionUrl, signal) as StacObject;

    // 3. Follow item links (rel=item → items)
    const itemLinks = linksWithRel(collection, 'item');
    for (const itemLink of itemLinks) {
      const itemUrl = new URL(itemLink.href, collectionUrl).href;
      const item = await fetchJson(itemUrl, signal) as StacObject;

      // 4. Extract zone info from item
      const props = item.properties ?? {};
      const assets = item.assets ?? {};
      const zarrAsset = assets.zarr;
      if (!zarrAsset) continue;

      const zarrUrl = new URL(zarrAsset.href, itemUrl).href;

      zones.push({
        id: item.id as string,
        utmZone: (props.utm_zone as number) ?? 0,
        epsg: props['proj:code'] ? parseInt((props['proj:code'] as string).split(':')[1], 10) : ((props.crs_epsg as number) ?? 0),
        bbox: item.bbox as [number, number, number, number],
        geometry: item.geometry as GeoJSON.Polygon,
        zarrUrl,
        title: (item.title as string) ?? undefined,
      });
    }
  }

  // Sort by UTM zone number
  zones.sort((a, b) => a.utmZone - b.utmZone);

  // Probe for global preview stores (one per year)
  const baseUrl = resolvedCatalogUrl.replace(/\/[^/]*$/, '/');
  const years = [...new Set(
    zones.map(z => z.id.match(/_(\d{4})$/)?.[1]).filter(Boolean)
  )].sort() as string[];

  const globalPreviewUrls: Record<string, string> = {};
  for (const year of years) {
    const candidateUrl = `${baseUrl}global_rgb_${year}.zarr`;
    try {
      const resp = await fetch(`${candidateUrl}/zarr.json`, { signal });
      if (resp.ok) {
        globalPreviewUrls[year] = candidateUrl;
        // Read bounds from the first successful probe
        if (!globalBounds) {
          const zarrMeta = await resp.json() as Record<string, unknown>;
          const attrs = zarrMeta.attributes as Record<string, unknown> | undefined;
          const spatialBbox = attrs?.['spatial:bbox'] as [number, number, number, number] | undefined;
          const spatial = attrs?.spatial as { bounds?: [number, number, number, number] } | undefined;
          if (spatialBbox) {
            globalBounds = spatialBbox;
          } else if (spatial?.bounds) {
            globalBounds = spatial.bounds;
          }
        }
      }
    } catch {
      // Preview not available for this year
    }
  }

  const latestYear = years[years.length - 1] ?? null;
  const globalPreviewUrl = latestYear ? (globalPreviewUrls[latestYear] ?? null) : null;

  // Fall back to computing bounds from zone bboxes
  if (!globalBounds && zones.length > 0) {
    globalBounds = [
      Math.min(...zones.map(z => z.bbox[0])),
      Math.min(...zones.map(z => z.bbox[1])),
      Math.max(...zones.map(z => z.bbox[2])),
      Math.max(...zones.map(z => z.bbox[3])),
    ];
  }

  return { zones, availableYears: years, globalPreviewUrls, globalPreviewUrl, globalBounds };
}

/** Simple point-in-bbox test (WGS84). */
export function pointInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  const [w, s, e, n] = bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}
