#!/usr/bin/env node
/**
 * Rebuild the COG availability manifest from what is actually in R2.
 *
 * Why a manifest
 * --------------
 * The app has to know which region/year COGs exist before it requests one, or
 * it asks for all of them: with 39 FMUs selected that was ~195 HEAD probes
 * issued at once, against a browser limit of about 6 per origin, and everything
 * else -- including the FMU boundaries -- queued behind lookups for regions that
 * have no COGs at all. One 1.2 kB manifest replaces the lot.
 *
 * Why it is generated rather than committed
 * -----------------------------------------
 * It describes the bucket, not the source tree, so a checked-in copy is a claim
 * about someone else's state that goes stale the moment anyone uploads. It is
 * derived from R2 and published back to R2, and the app reads it from there in
 * both dev (via the /cogs dev proxy) and production.
 *
 * RUN THIS AFTER EVERY COG UPLOAD. A region whose COGs are on the bucket but
 * missing from the manifest is treated as having none, and silently falls back
 * to the PNG pyramid.
 *
 * Usage:
 *   node generate-cog-manifest.js            # rebuild and publish
 *   node generate-cog-manifest.js --dry-run  # print what it would publish
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

const MANIFEST_KEY = 'cogs/manifest.json';

// cogs/<prefix>/<region>_<year>.tif -- the layout clearcutCogUrl() builds.
const COG_KEY = /^cogs\/([^/]+)\/([a-z0-9]+)_(\d{4})\.tif$/;

// tiles/<layer>/<region>_<year>/ -- listed with a delimiter so only the folder
// names come back. A full listing would be hundreds of thousands of PNGs; this
// is one cheap request per layer.
const TILE_DIR = /^([a-z0-9]+)_(\d{4})$/;

function makeClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Rebuild the manifest from the bucket and (unless dryRun) publish it.
 *
 * Exported so upload-cogs.js can re-index straight after an upload -- the
 * failure mode otherwise is silent: COGs on the bucket, absent from the
 * manifest, treated by the app as not existing.
 */
async function rebuildManifest({ client = makeClient(), bucket = process.env.R2_BUCKET_NAME, dryRun = false, quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const prefixes = {};
  let token;
  let scanned = 0;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'cogs/',
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      scanned += 1;
      const match = obj.Key.match(COG_KEY);
      if (!match) continue;
      const [, prefix, region, year] = match;
      prefixes[prefix] ??= {};
      prefixes[prefix][region] ??= [];
      prefixes[prefix][region].push(Number(year));
    }
    token = res.NextContinuationToken;
  } while (token);

  for (const prefix of Object.keys(prefixes)) {
    for (const region of Object.keys(prefixes[prefix])) {
      prefixes[prefix][region].sort((a, b) => a - b);
    }
  }

  // Which PNG tile sets exist, so the app stops requesting pyramids that were
  // never generated. Stats are not a usable proxy for this: troutlake has
  // clearcut statistics for 2017-2025 but tiles for only 2020 and 2024, so
  // gating on "has data" still produced a request tree per missing year.
  const tiles = {};
  const layerDirs = await client.send(new ListObjectsV2Command({
    Bucket: bucket, Prefix: 'tiles/', Delimiter: '/',
  }));

  for (const { Prefix: layerPrefix } of layerDirs.CommonPrefixes ?? []) {
    const layer = layerPrefix.replace('tiles/', '').replace(/\/$/, '');
    const byRegion = {};
    let layerToken;
    do {
      const res = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: layerPrefix, Delimiter: '/', ContinuationToken: layerToken,
      }));
      for (const { Prefix: dir } of res.CommonPrefixes ?? []) {
        const name = dir.replace(layerPrefix, '').replace(/\/$/, '');
        const match = name.match(TILE_DIR);
        if (!match) continue;
        const [, region, year] = match;
        byRegion[region] ??= [];
        byRegion[region].push(Number(year));
      }
      layerToken = res.NextContinuationToken;
    } while (layerToken);

    for (const region of Object.keys(byRegion)) byRegion[region].sort((a, b) => a - b);
    if (Object.keys(byRegion).length) tiles[layer] = byRegion;
  }

  const manifest = { generatedAt: new Date().toISOString(), prefixes, tiles };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;

  log(`Scanned ${scanned} objects under cogs/\n`);
  for (const [prefix, regions] of Object.entries(prefixes)) {
    const names = Object.keys(regions);
    log(`  cog  ${prefix}: ${names.length} region(s) — ${names.join(', ')}`);
  }
  for (const [layer, regions] of Object.entries(tiles)) {
    const names = Object.keys(regions);
    log(`  tile ${layer}: ${names.length} region(s) — ${names.join(', ')}`);
  }

  if (dryRun) {
    log(`\n--dry-run: not published (${body.length} bytes)`);
    return manifest;
  }

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: MANIFEST_KEY,
    Body: body,
    ContentType: 'application/json',
    // Regenerated in place under a fixed key, so it must revalidate -- the same
    // reasoning as the sidecar JSON in upload-cogs.js. An immutable manifest
    // would hide every COG uploaded after it for a year.
    CacheControl: 'public, max-age=300, must-revalidate',
  }));

  log(`\nPublished r2://${bucket}/${MANIFEST_KEY} (${body.length} bytes)`);
  return manifest;
}

module.exports = { rebuildManifest, MANIFEST_KEY };

if (require.main === module) {
  const missing = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing in .env.r2: ${missing.join(', ')}`);
    process.exit(1);
  }
  rebuildManifest({ dryRun: process.argv.includes('--dry-run') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
