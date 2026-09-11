'use strict';

/**
 * Builds client/public/data/wildfire_years.json — a map of
 *   { "<region>": [year, year, ...] }
 * listing which years each region actually has burned-area tiles for.
 *
 * The wildfire tile pyramid is sparse: a region only has a folder for a year
 * in which something burned. Without this manifest the year slider offers all
 * years 2010-2025 for every region and most of them render nothing, which
 * looks like a broken layer rather than "no fire that year".
 *
 * The NBAC output is produced outside this repo, so its location has to be
 * supplied — there is no default. Re-run whenever the source changes.
 *
 * Accepts either layout, because the wildfire layer is mid-migration:
 *   PNG pyramid   <region>_<year>/{z}/{x}/{y}.png     (directories)
 *   COG           <region>_<year>.tif                 (files)
 * Reading the COGs matters once they are the layer's source — a manifest built
 * from the old tile folders describes a set the map no longer draws from, and a
 * region-year missing from it is simply unreachable in the year slider.
 *
 * Usage:
 *   node generate-wildfire-years.js <dir>
 *   WILDFIRE_TILES_DIR=<dir> node generate-wildfire-years.js
 */

const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'client', 'public', 'data', 'wildfire_years.json');

const tilesDir = process.argv[2] || process.env.WILDFIRE_TILES_DIR;

if (!tilesDir) {
  console.error('Error: no wildfire tiles directory given.\n');
  console.error('Usage:');
  console.error('  node generate-wildfire-years.js <tilesDir>');
  console.error('  WILDFIRE_TILES_DIR=<tilesDir> node generate-wildfire-years.js\n');
  console.error('  <dir>  folder of <region>_<year>.tif COGs,');
  console.error('         or of <region>_<year>/{z}/{x}/{y}.png tile pyramids');
  process.exit(1);
}

if (!fs.existsSync(tilesDir)) {
  console.error(`Tiles directory not found: ${tilesDir}`);
  process.exit(1);
}

const byRegion = new Map();

// A COG directory holds files, a PNG pyramid holds directories. Decide from what
// is actually there rather than from a flag, so the same command works either way.
const entries = fs.readdirSync(tilesDir, { withFileTypes: true });
const cogs = entries.filter((e) => e.isFile() && /\.tiff?$/i.test(e.name));
const mode = cogs.length > 0 ? 'cog' : 'png';
const candidates = mode === 'cog' ? cogs : entries.filter((e) => e.isDirectory());

console.log(`Reading ${mode === 'cog' ? 'COGs' : 'tile folders'} from ${tilesDir}`);

for (const entry of candidates) {
  // Strip the extension in COG mode so both layouts share one <region>_<year> parse.
  const stem = mode === 'cog' ? entry.name.replace(/\.tiff?$/i, '') : entry.name;

  const match = stem.match(/^(.*)_(\d{4})$/);
  if (!match) {
    console.warn(`  skipping unrecognised name: ${entry.name}`);
    continue;
  }

  const [, region, year] = match;
  if (!byRegion.has(region)) byRegion.set(region, new Set());
  byRegion.get(region).add(Number(year));
}

const result = {};
for (const region of [...byRegion.keys()].sort()) {
  result[region] = [...byRegion.get(region)].sort((a, b) => a - b);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`);

const totalYears = Object.values(result).reduce((sum, years) => sum + years.length, 0);
console.log(`Wrote ${OUT_FILE}`);
console.log(`  ${Object.keys(result).length} regions, ${totalYears} region-years`);
