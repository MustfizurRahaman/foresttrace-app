import { clearcutCogUrl, COG_BASE_URL, COG_PREFIX_FOR_COVERAGE as COG_PREFIX } from '../config';

/**
 * Which region/year pairs actually have a clearcut COG.
 *
 * The chart reads precomputed hectares from clearcut_stats.json, which is
 * independent of whether the raster for that region was ever converted. On the
 * COG path that makes the chart disagree with the map: select every FMU and the
 * map draws only the regions with COGs while the chart sums every region that
 * has stats. This narrows the chart to what the map can actually draw.
 *
 * There is no manifest of uploaded COGs, so availability is probed with HEAD and
 * cached for the session. That is affordable because only regions that already
 * have stats are ever probed -- the count scales with regions processed, not
 * with regions selected.
 *
 * Requires the host to allow HEAD cross-origin. In dev the /cogs proxy makes it
 * same-origin; in production it rides on the same CORS policy the range reads
 * already need. A probe that fails for any reason counts as "absent", which
 * matches what the user sees: no raster on the map.
 */

// One request that answers for every region and year at once.
//
// Probing was fine while a handful of regions were selected and pathological at
// 39: 39 regions x 5 module years is ~195 HEAD requests issued together, against
// a browser limit of roughly 6 per origin. Everything else queued behind them --
// which is why selecting all FMUs left the boundaries waiting on COG lookups for
// regions that have no COGs at all.
//
// Falls back to probing when the manifest is absent, so a bucket that hasn't
// been re-indexed still works.
let _manifestPromise = null;

function loadManifest() {
  if (!_manifestPromise) {
    _manifestPromise = fetch(`${COG_BASE_URL}/cogs/manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _manifestPromise;
}

/**
 * `${region}_${year}` keys that have a PNG tile pyramid for a layer, or null
 * when the manifest is unavailable (callers then request as before).
 *
 * Stats are not a substitute for this: troutlake has clearcut statistics for
 * 2017-2025 but tiles for only 2020 and 2024, so gating on "the region has
 * data" still produced a full request tree for every missing year.
 */
export async function getTileCoverage(tileLayer) {
  const manifest = await loadManifest();
  const byRegion = manifest?.tiles?.[tileLayer];
  if (!byRegion) return null;
  const covered = new Set();
  for (const [region, years] of Object.entries(byRegion)) {
    for (const year of years) covered.add(`${region}_${year}`);
  }
  return covered;
}

/** `${region}_${year}` keys the manifest says exist, or null if there is none. */
async function coverageFromManifest() {
  const manifest = await loadManifest();
  const byRegion = manifest?.prefixes?.[COG_PREFIX];
  if (!byRegion) return null;
  const covered = new Set();
  for (const [region, years] of Object.entries(byRegion)) {
    for (const year of years) covered.add(`${region}_${year}`);
  }
  return covered;
}

// `${region}_${year}` -> Promise<boolean>
const cache = new Map();

// Availability is a property of the raster, not of which layer renders it, so
// the accumulated product stands in for both.
const PROBE_LAYER_ID = 'clearcut-accumulated';

function probe(region, year) {
  const key = `${region}_${year}`;
  if (!cache.has(key)) {
    const url = clearcutCogUrl(PROBE_LAYER_ID, region, year);
    cache.set(
      key,
      url
        ? fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false)
        : Promise.resolve(false),
    );
  }
  return cache.get(key);
}

/**
 * @param {Array<{region: string, years: number[]}>} wanted region/year pairs worth probing
 * @returns {Promise<Set<string>>} `${region}_${year}` keys that have a COG
 */
export async function getCogCoverage(wanted) {
  const fromManifest = await coverageFromManifest();
  if (fromManifest) return fromManifest;

  const pairs = wanted.flatMap(({ region, years }) => years.map((year) => ({ region, year })));
  const present = await Promise.all(pairs.map(({ region, year }) => probe(region, year)));
  return new Set(pairs.filter((_, i) => present[i]).map(({ region, year }) => `${region}_${year}`));
}

export function clearCogCoverageCache() {
  cache.clear();
  _manifestPromise = null;
}
