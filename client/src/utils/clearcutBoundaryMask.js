/**
 * Wabigoon's clearcut-accumulated tiles for 2022+ were generated over a
 * larger raster extent than the actual FMU polygon, so some tiles render
 * clearcut pixels outside the region boundary. 2021's tile set was
 * generated correctly (clipped to the boundary), so it's used as a
 * reference footprint: any 2022+ tile whose native z/x/y isn't present in
 * 2021's set is known to fall outside the boundary and is excluded.
 *
 * This is a stopgap against the existing tile files, not a fix to the
 * generation pipeline — once wabigoon's 2022+ tiles are regenerated with
 * proper polygon clipping, this mask (and its manifest file) can be removed.
 */

const AFFECTED_REGION = 'wabigoon';
const AFFECTED_LAYER = 'clearcut-accumulated';
const REFERENCE_YEAR = 2021;
const MANIFEST_URL = `${process.env.PUBLIC_URL || ''}/data/wabigoon_clearcut_valid_tiles_2021.json`;

let manifestCache = null; // Set once loaded, null while unresolved.
let manifestPromise = null;

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => { manifestCache = new Set(arr); })
      .catch(() => { manifestCache = new Set(); });
  }
  return manifestPromise;
}

export function needsBoundaryMask(layerId, region, year) {
  return layerId === AFFECTED_LAYER && region === AFFECTED_REGION && Number(year) > REFERENCE_YEAR;
}

/** Kicks off the manifest fetch; safe to call repeatedly. */
export function preloadBoundaryManifest() {
  loadManifest();
}

/**
 * Sync membership check against the already-loaded manifest.
 * Returns true/false once loaded, or null if the manifest hasn't resolved
 * yet (callers should treat null as "unknown — don't block on it").
 */
export function isWithinReferenceBoundarySync(z, x, y) {
  if (!manifestCache) return null;
  return manifestCache.has(`${z}/${x}/${y}`);
}

/** Async membership check — resolves once the manifest is available. */
export async function isWithinReferenceBoundary(z, x, y) {
  await loadManifest();
  return manifestCache.has(`${z}/${x}/${y}`);
}
