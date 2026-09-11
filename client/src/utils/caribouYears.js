/**
 * Which years each region has caribou habitat tiles for.
 *
 * The MSPA source covers 2020-2024 only — a much narrower window than the
 * 2010-2025 the other modules use — and a region only has tiles for years it
 * was assessed in. Without this manifest the slider offers years that render
 * nothing, which reads as a broken layer rather than "not assessed".
 *
 *   { "troutlake": [2020, 2021, 2022, 2023, 2024] }
 *
 * Same loader shape as wildfireYears.js.
 */

let _yearsPromise = null;

function loadCaribouYears() {
  if (!_yearsPromise) {
    const base = process.env.PUBLIC_URL || '';
    _yearsPromise = fetch(`${base}/data/caribou_years.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`caribou_years.json: HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        console.error('[CaribouYears]', err);
        _yearsPromise = null;
        throw err;
      });
  }
  return _yearsPromise;
}

/**
 * Union of assessed years across the given regions, ascending.
 *
 * @param {string[]} regions - FMU ids
 * @returns {Promise<number[]>}
 */
export async function getHabitatYearsForRegions(regions) {
  if (!Array.isArray(regions) || regions.length === 0) return [];

  const all = await loadCaribouYears();
  const union = new Set();

  for (const region of regions) {
    const years = all[String(region || '').toLowerCase()];
    if (Array.isArray(years)) years.forEach((y) => union.add(y));
  }

  return [...union].sort((a, b) => a - b);
}

export function clearCaribouYearsCache() {
  _yearsPromise = null;
}
