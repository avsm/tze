import create from 'stac-js';

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

/**
 * Fetch a STAC catalog and walk its children/items to discover all UTM zone zarr stores.
 * Returns an array of ZoneDescriptor sorted by utmZone.
 */
export interface CatalogResult {
  zones: ZoneDescriptor[];
  globalPreviewUrl: string | null;
}

export async function loadCatalog(catalogUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const zones: ZoneDescriptor[] = [];
  let globalPreviewUrl: string | null = null;

  // 1. Fetch and parse the root catalog
  const catalogData = await fetchJson(catalogUrl, signal);
  const catalog = create(catalogData as Record<string, unknown>);

  // 2. Follow child links (rel=child → collections)
  const childLinks = catalog.getChildLinks();
  for (const link of childLinks) {
    const collectionUrl = new URL(link.href, catalogUrl).href;
    const collectionData = await fetchJson(collectionUrl, signal);
    const collection = create(collectionData as Record<string, unknown>);

    // 3. Follow item links (rel=item → items)
    const itemLinks = collection.getItemLinks();
    for (const itemLink of itemLinks) {
      const itemUrl = new URL(itemLink.href, collectionUrl).href;
      const itemData = await fetchJson(itemUrl, signal) as Record<string, unknown>;
      const item = create(itemData);

      // 4. Extract zone info from item
      const props = item.properties as Record<string, unknown>;
      const assets = item.assets as Record<string, { href: string }>;
      const zarrAsset = assets?.zarr;
      if (!zarrAsset) continue;

      const zarrUrl = new URL(zarrAsset.href, itemUrl).href;

      zones.push({
        id: item.id as string,
        utmZone: (props.utm_zone as number) ?? 0,
        epsg: (props.crs_epsg as number) ?? 0,
        bbox: item.bbox as [number, number, number, number],
        geometry: (item.geometry as GeoJSON.Polygon),
        zarrUrl,
        title: (item.title as string) ?? undefined,
      });
    }
  }

  // Sort by UTM zone number
  zones.sort((a, b) => a.utmZone - b.utmZone);

  // Probe for global preview store next to the catalog
  const baseUrl = catalogUrl.replace(/\/[^/]*$/, '/');
  // Find the latest year from discovered zones
  const years = [...new Set(zones.map(z => z.id.match(/_(\d{4})$/)?.[1]).filter(Boolean))].sort();
  const latestYear = years[years.length - 1] ?? '2025';
  const candidateUrl = `${baseUrl}global_rgb_${latestYear}.zarr`;
  try {
    const probe = await fetch(`${candidateUrl}/zarr.json`, { method: 'HEAD', signal });
    if (probe.ok) {
      globalPreviewUrl = candidateUrl;
    }
  } catch {
    // Global preview not available — that's fine
  }

  return { zones, globalPreviewUrl };
}

/** Simple point-in-bbox test (WGS84). */
export function pointInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  const [w, s, e, n] = bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}
