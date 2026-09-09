/**
 * Runtime configuration derived from environment variables.
 *
 * In development (local):   .env  →  REACT_APP_TILES_BASE_URL is empty → relative paths
 * In production (Vercel):   set REACT_APP_TILES_BASE_URL in the Vercel project settings
 *                           e.g. https://pub-<id>.r2.dev
 */

// Base URL for all raster tiles. No trailing slash.
export const TILES_BASE_URL = process.env.REACT_APP_TILES_BASE_URL || '';

// Base URL for static data files (GeoJSON, etc.). No trailing slash.
export const DATA_BASE_URL = process.env.REACT_APP_DATA_BASE_URL || '';

// Base URL for Cloud Optimized GeoTIFFs. Separate from TILES_BASE_URL because
// COGs are range-read cross-origin by the browser, so their host needs a CORS
// policy that the PNG tile host does not -- keeping them separable means the two
// can live on different buckets or domains during the migration.
export const COG_BASE_URL = process.env.REACT_APP_COG_BASE_URL || TILES_BASE_URL;

// Maps a module layer id to its COG prefix. The two clearcut products are
// genuinely different rasters, not two renderings of one:
//   annual(Y)      = clearcut as the year-Y model saw it
//   accumulated(Y) = union of clearcut over the 5 years ending at Y, so regrowth
//                    drops out instead of accumulating forever
// Prefixes are versioned rather than overwritten. Filenames carry no content
// hash and are uploaded with an immutable Cache-Control, so republishing a year
// in place would leave the CDN and any warm browser serving the old raster
// indefinitely. Bump the suffix whenever the derivation rule changes.
//   v2: standing clearcut = seen in >=2 years of the 5-year window, no 2010 carry
//   v3: v2 OR detected this year -- the newest year has no later year to
//       corroborate it, so v2 excluded the current season's cuts entirely
//   v4: corroboration must be CONSECUTIVE -- seen in two adjacent years inside
//       the window, OR detected this year. v3 counted sightings however far
//       apart, so a pixel seen in 2019 and 2023 vouched for the four years
//       between; adjacency reads corroboration as "still there next season".
//       Mature years fall ~4-5%; 2017-2019 fall ~21%, because those windows
//       leaned on the 2010 baseline, which has no calendar neighbour.
const COG_PREFIX_BY_LAYER = {
  'clearcut-annual': 'clearcut-annual',
  'clearcut-accumulated': 'clearcut-accumulated-v4',
};

// The prefix coverage is judged against. Accumulated and annual are generated
// together, so one answers for both.
export const COG_PREFIX_FOR_COVERAGE = COG_PREFIX_BY_LAYER['clearcut-accumulated'];

/**
 * Per-year clearcut COG URL for a given layer.
 *
 * Filenames carry no content hash, so a regenerated year reuses its URL. That's
 * deliberate -- the app's year slider builds these paths by convention rather than
 * from a manifest -- but it means the immutable Cache-Control set at upload time
 * would pin a stale file. Regenerate under a new prefix (or purge) rather than
 * overwriting in place.
 *
 * Returns null for a layer with no COG product, so callers fall back to PNG tiles.
 */
export function clearcutCogUrl(layerId, region, year) {
  const prefix = COG_PREFIX_BY_LAYER[layerId];
  if (!prefix) return null;
  return `${COG_BASE_URL}/cogs/${prefix}/${region}_${year}.tif`;
}
