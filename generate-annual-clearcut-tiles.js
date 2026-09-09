'use strict';

// Derives annual (new-pixel-only) clearcut tiles from accumulated tiles
// using a 2-year lookback voting filter:
//   annual(Y) = pixels present in accumulated(Y) absent from accumulated(Y-1) AND accumulated(Y-2)
//
// The lookback years are Y-1 and Y-2 literally. A year whose lookback isn't in
// the record has no filter to apply and is REFUSED rather than generated: with
// no lookback every pixel reads as new, which silently turns annual(Y) into a
// copy of accumulated(Y). That is what happened to 2015 and 2016 -- their
// annual and accumulated hectares are identical to 0.1 ha -- because the
// lookback was picked by position in AVAILABLE_YEARS, so 2016 looked back at
// 2015 and 2010, and 2015 at 2010 alone, across a five-year gap in the record.
//
// Pass --allow-missing-lookback to generate anyway. Do that only if you want
// "everything is new", and know the output isn't an annual series.
//
// Usage:
//   node generate-annual-clearcut-tiles.js --local [region] [year]
//       reads/writes client/public/tiles/ (no R2 credentials needed)
//
//   node generate-annual-clearcut-tiles.js --production [region] [year]
//       reads accumulated tiles from R2, writes annual tiles to R2
//
// Setup: npm install pngjs @aws-sdk/client-s3 dotenv   (repo root)
// Credentials for --production: .env.r2

const args = process.argv.slice(2);
const isLocal      = args.includes('--local');
const isProduction = args.includes('--production');
const allowMissingLookback = args.includes('--allow-missing-lookback');

if (!isLocal && !isProduction) {
  console.error('Error: specify --local or --production');
  console.error('  --local       read/write client/public/tiles/ (no credentials needed)');
  console.error('  --production  read/write Cloudflare R2 (requires .env.r2)');
  process.exit(1);
}

if (isProduction) require('dotenv').config({ path: '.env.r2' });

const { PNG } = require('pngjs');
const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const AVAILABLE_YEARS = [2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

const REGIONS = [
  'abitibiriver', 'algoma', 'algonquinpark', 'bancroftminden', 'blackspruce',
  'boundarywaters', 'caribou', 'dogrivermatawin', 'dryden', 'englishriver',
  'frenchsevern', 'gordoncosens', 'hearst', 'kenogami', 'kenora', 'lacseul',
  'lakenipigon', 'lakehead', 'mazinawlanark', 'missinaibi', 'nagagami',
  'nipissing', 'northshore', 'ogoki', 'ottawavalley', 'pic', 'pineland',
  'redlake', 'romeomalette', 'spanish', 'sudbury', 'temagami', 'timiskaming',
  'troutlake', 'wabadowgangnoopming', 'wabigoon', 'whiskeyjack', 'whiteriver',
  'whitefeather',
];

const CONCURRENCY    = 8;
const LOCAL_TILES    = path.join(__dirname, 'client', 'public');

// ── R2 client (production only) ───────────────────────────────────────────────

let r2, BUCKET;
if (isProduction) {
  const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  BUCKET = process.env.R2_BUCKET_NAME;
  // Attach the command constructors so production helpers can reference them.
  r2._GetObjectCommand     = GetObjectCommand;
  r2._PutObjectCommand     = PutObjectCommand;
  r2._ListObjectsV2Command = ListObjectsV2Command;
}

// ── Local I/O helpers ─────────────────────────────────────────────────────────

function listTilePathsLocal(region, year) {
  const dir = path.join(LOCAL_TILES, 'tiles', 'clearcut', `${region}_${year}`);
  if (!fs.existsSync(dir)) return [];
  const paths = [];
  for (const z of fs.readdirSync(dir)) {
    const zDir = path.join(dir, z);
    if (!fs.statSync(zDir).isDirectory()) continue;
    for (const x of fs.readdirSync(zDir)) {
      const xDir = path.join(zDir, x);
      if (!fs.statSync(xDir).isDirectory()) continue;
      for (const file of fs.readdirSync(xDir)) {
        if (file.endsWith('.png')) paths.push(`${z}/${x}/${file}`);
      }
    }
  }
  return paths;
}

function loadTileLocal(region, year, z, x, y) {
  const filePath = path.join(LOCAL_TILES, 'tiles', 'clearcut', `${region}_${year}`, String(z), String(x), `${y}.png`);
  if (!fs.existsSync(filePath)) return null;
  try { return PNG.sync.read(fs.readFileSync(filePath)); } catch { return null; }
}

function writeTileLocal(outKey, buf) {
  const localPath = path.join(LOCAL_TILES, outKey);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buf);
}

// ── R2 I/O helpers ────────────────────────────────────────────────────────────

async function listTilePathsR2(region, year) {
  const prefix = `tiles/clearcut/${region}_${year}/`;
  const paths  = [];
  let token;
  do {
    const res = await r2.send(new r2._ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      const rel = obj.Key.slice(prefix.length);
      if (/^\d+\/\d+\/\d+\.png$/.test(rel)) paths.push(rel);
    }
    token = res.NextContinuationToken;
  } while (token);
  return paths;
}

async function loadTileR2(region, year, z, x, y) {
  const key = `tiles/clearcut/${region}_${year}/${z}/${x}/${y}.png`;
  try {
    const res = await r2.send(new r2._GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return PNG.sync.read(Buffer.concat(chunks));
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function writeTileR2(outKey, buf) {
  await r2.send(new r2._PutObjectCommand({
    Bucket: BUCKET, Key: outKey, Body: buf, ContentType: 'image/png',
  }));
}

// ── Voting logic ─────────────────────────────────────────────────────────────

// The two calendar years before `year` -- not the two preceding entries in
// AVAILABLE_YEARS. Positional lookback silently spans gaps in the record: with
// 2011-2014 absent it made 2010 a "previous year" of 2016.
function getPrevYears(year) {
  return [year - 1, year - 2];
}

/** Which of a year's lookback years exist in the record at all. */
function partitionLookback(year) {
  const wanted = getPrevYears(year);
  return {
    present: wanted.filter(y => AVAILABLE_YEARS.includes(y)),
    absent: wanted.filter(y => !AVAILABLE_YEARS.includes(y)),
  };
}

// A null png means the tile isn't in the pyramid. Tile pyramids are sparse --
// tiles with no content are never written -- so for a lookback year that IS in
// the record, absent genuinely means empty. It only becomes a lie when the year
// itself is missing, which processRegionYear rejects before getting here.
function isPresent(png, x, y) {
  if (!png) return false;
  const idx = (y * png.width + x) * 4;
  return png.data[idx + 3] > 0;
}

function computeAnnualTile(curr, prevs) {
  const out = new PNG({ width: curr.width, height: curr.height, filterType: -1 });
  out.data.fill(0);
  let hasContent = false;
  for (let py = 0; py < curr.height; py++) {
    for (let px = 0; px < curr.width; px++) {
      const i = (py * curr.width + px) * 4;
      if (curr.data[i + 3] === 0) continue;
      if (prevs.some(p => isPresent(p, px, py))) continue;
      out.data[i]     = curr.data[i];
      out.data[i + 1] = curr.data[i + 1];
      out.data[i + 2] = curr.data[i + 2];
      out.data[i + 3] = curr.data[i + 3];
      hasContent = true;
    }
  }
  return hasContent ? out : null;
}

// ── Processing ────────────────────────────────────────────────────────────────

async function processRegionYear(region, year) {
  const { present: prev, absent } = partitionLookback(year);

  if (absent.length && !allowMissingLookback) {
    console.error(
      `  [refuse] ${region}/${year}: lookback year(s) ${absent.join(', ')} are not in the record. ` +
      'Without them every pixel reads as new and annual would just copy accumulated. ' +
      'Pass --allow-missing-lookback to override.'
    );
    return { written: 0, skipped: 0, refused: 1 };
  }
  if (absent.length) {
    console.warn(
      `  [warn] ${region}/${year}: generating with lookback year(s) ${absent.join(', ')} missing — ` +
      'output is "everything is new", not an annual series.'
    );
  }

  const paths = isLocal
    ? listTilePathsLocal(region, year)
    : await listTilePathsR2(region, year);

  if (paths.length === 0) {
    console.log(`  [skip] no accumulated tiles for ${region}/${year}`);
    return { written: 0, skipped: 0, refused: 0 };
  }

  // A lookback year that's in the record but has no tiles for this region is
  // the same trap one level down: the filter would find nothing and pass every
  // pixel through. Sparsity is per-tile, never per-region.
  for (const py of prev) {
    const prevPaths = isLocal
      ? listTilePathsLocal(region, py)
      : await listTilePathsR2(region, py);
    if (prevPaths.length === 0) {
      if (!allowMissingLookback) {
        console.error(
          `  [refuse] ${region}/${year}: lookback year ${py} has no tiles for this region. ` +
          'Pass --allow-missing-lookback to override.'
        );
        return { written: 0, skipped: 0, refused: 1 };
      }
      console.warn(`  [warn] ${region}/${year}: lookback year ${py} has no tiles for this region.`);
    }
  }

  let written = 0, skipped = 0;

  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = paths.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (tilePath) => {
      const [z, x, y] = tilePath.replace('.png', '').split('/').map(Number);

      const curr = isLocal
        ? loadTileLocal(region, year, z, x, y)
        : await loadTileR2(region, year, z, x, y);
      if (!curr) { skipped++; return; }

      const prevImages = await Promise.all(
        prev.map(py => isLocal
          ? loadTileLocal(region, py, z, x, y)
          : loadTileR2(region, py, z, x, y))
      );

      const annual = computeAnnualTile(curr, prevImages);
      if (!annual) { skipped++; return; }

      const pngBuf = PNG.sync.write(annual);
      const outKey = `tiles/clearcut-annual/${region}_${year}/${z}/${x}/${y}.png`;

      if (isLocal) {
        writeTileLocal(outKey, pngBuf);
      } else {
        await writeTileR2(outKey, pngBuf);
      }
      written++;
    }));

    process.stdout.write(`\r  ${region}/${year}: ${i + batch.length}/${paths.length} tiles…`);
  }

  process.stdout.write('\r');
  return { written, skipped, refused: 0 };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (isProduction) {
    const missing = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
      .filter(k => !process.env[k]);
    if (missing.length) {
      console.error(`Missing in .env.r2: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  const posArgs   = args.filter(a => !a.startsWith('--'));
  const argRegion = posArgs[0] || null;
  const argYear   = posArgs[1] ? parseInt(posArgs[1], 10) : null;

  const regions = argRegion ? [argRegion] : REGIONS;
  const years   = AVAILABLE_YEARS.filter(y => y !== 2010 && (!argYear || y === argYear));

  const mode = isLocal ? 'local (client/public/tiles/)' : 'production (R2)';
  console.log(`Generating annual clearcut tiles — ${mode}`);
  console.log(`  Regions: ${regions.length}  Years: ${years.join(', ')}\n`);

  let totalWritten = 0, totalSkipped = 0, totalRefused = 0;
  for (const region of regions) {
    for (const year of years) {
      process.stdout.write(`${region} ${year}…\n`);
      const { written, skipped, refused } = await processRegionYear(region, year);
      if (!refused) console.log(`  → ${written} tiles written, ${skipped} skipped`);
      totalWritten += written;
      totalSkipped += skipped;
      totalRefused += refused ?? 0;
    }
  }

  console.log(`\nDone. Total: ${totalWritten} written, ${totalSkipped} skipped, ${totalRefused} refused.`);

  // Non-zero exit so a refusal can't pass unnoticed in a scripted run -- the
  // failure mode this guards against is silent, plausible-looking output.
  if (totalRefused > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
