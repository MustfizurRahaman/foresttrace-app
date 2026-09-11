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
// Wildfire is versioned on the same rule:
//   wildfire-v1: regions derived from all_fmu_boundary_border.shp, the
//       pre-amalgamation FMU set -- `pic`, `boundarywaters` and `missinaibi` had
//       no COG at all, and several files were clipped to boundaries the app does
//       not draw.
//   wildfire-v2: regions taken from the app's own data/regions/ontario-index.json,
//       so ids and clip geometry match what the client requests by construction.
//   wildfire-v3: burned pixels written as class 1 of wildfire's own table
//       (wildfireClasses.js) rather than class 3 of the clearcut model's. Same
//       geometry as v2 -- only the pixel value changed.
// Caribou ships TWO products because the layer has two modes and neither raster
// answers for the other:
//   caribou-v1      per RANGE  (berens_2021)    -- one range, nothing else
//   caribou-fmu-v1  per FMU    (troutlake_2021) -- every range reaching that FMU
// An FMU raster carries all three ranges crossing troutlake, which is right when
// you asked for that FMU and wrong when you asked for Berens.
const COG_PREFIX_BY_LAYER = {
  'clearcut-annual': 'clearcut-annual',
  'clearcut-accumulated': 'clearcut-accumulated-v4',
  'wildfire-burned': 'wildfire-v3',
  'caribou-habitat': 'caribou-v1',
  'caribou-habitat-fmu': 'caribou-fmu-v1',
};

// The prefix coverage is judged against. Accumulated and annual are generated
// together, so one answers for both.
export const COG_PREFIX_FOR_COVERAGE = COG_PREFIX_BY_LAYER['clearcut-accumulated'];

/**
 * The COG prefix a layer DRAWS from, or null if it has no COG product.
 *
 * Callers fall back to PNG tiles on null. Caribou is the one layer whose id does
 * not settle this on its own -- it resolves to a different product per mode, so
 * the mode has to travel with the lookup.
 */
export function cogPrefixForLayer(layerId, { caribouRangeMode = false } = {}) {
  if (layerId === 'caribou-habitat') {
    return COG_PREFIX_BY_LAYER[caribouRangeMode ? 'caribou-habitat' : 'caribou-habitat-fmu'];
  }
  return COG_PREFIX_BY_LAYER[layerId] ?? null;
}

/**
 * The COG prefix whose coverage ANSWERS for a layer.
 *
 * Usually the same prefix, but not always: the two clearcut products are
 * generated together, so accumulated's coverage answers for annual too. They are
 * still different rasters -- only availability is shared, never the URL, or the
 * annual layer would draw the accumulated raster.
 *
 * Separate from the URL because coverage is keyed per prefix, so a caller asking
 * "does this region-year exist" has to say which product it means. Wildfire holds
 * different region-years from clearcut -- wabigoon has clearcut for twelve years
 * and fire for one -- so one shared set would have each layer answering for the
 * other.
 */
export function coveragePrefixForLayer(layerId, opts) {
  if (layerId === 'clearcut-annual') return COG_PREFIX_FOR_COVERAGE;
  return cogPrefixForLayer(layerId, opts);
}

/**
 * Per-year COG URL from a resolved prefix.
 *
 * Filenames carry no content hash, so a regenerated year reuses its URL. That's
 * deliberate -- the app's year slider builds these paths by convention rather than
 * from a manifest -- but it means the immutable Cache-Control set at upload time
 * would pin a stale file. Regenerate under a new prefix (or purge) rather than
 * overwriting in place.
 */
export function cogUrlForPrefix(prefix, region, year) {
  if (!prefix) return null;
  return `${COG_BASE_URL}/cogs/${prefix}/${region}_${year}.tif`;
}
