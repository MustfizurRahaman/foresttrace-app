import { clearcutCogUrl } from '../config';

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
  const pairs = wanted.flatMap(({ region, years }) => years.map((year) => ({ region, year })));
  const present = await Promise.all(pairs.map(({ region, year }) => probe(region, year)));
  return new Set(pairs.filter((_, i) => present[i]).map(({ region, year }) => `${region}_${year}`));
}

export function clearCogCoverageCache() {
  cache.clear();
}
