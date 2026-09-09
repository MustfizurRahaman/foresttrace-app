#!/usr/bin/env node
/**
 * Rewrite Cache-Control on objects already in R2.
 *
 * Tiles were uploaded with no Cache-Control at all -- only ETag and
 * Last-Modified -- so browsers fall back to heuristic freshness and still make a
 * revalidation round trip. A 304 is cheap in bytes and not in latency, and the
 * timeline's playback issues hundreds per frame.
 *
 * upload-tiles.js now sets the header, but that only helps future uploads. This
 * fixes what is already published.
 *
 * Why a per-object rewrite rather than a cache rule
 * ------------------------------------------------
 * Cloudflare Cache Rules would fix every object at once, but they operate on
 * zones, and the bucket is served from a `pub-*.r2.dev` subdomain -- a managed
 * endpoint outside any zone (its responses carry no cf-cache-status). Attaching
 * a custom domain would make rules available, and remains the better long-term
 * answer; this is the option that works with the credentials in .env.r2.
 *
 * The rewrite is a metadata-only CopyObject onto the same key: no data leaves
 * or enters the bucket, but it is one API call per object, so scope it by prefix
 * rather than running it over all 401k tiles at once.
 *
 * Usage:
 *   node set-cache-headers.js tiles/wildfire/ --dry-run
 *   node set-cache-headers.js tiles/wildfire/
 *   node set-cache-headers.js tiles/ --concurrency 64
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const { S3Client, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');

const missing = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env.r2: ${missing.join(', ')}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const prefix = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const concurrency = Number(args[args.indexOf('--concurrency') + 1]) || 32;

if (!prefix) {
  console.error('Usage: node set-cache-headers.js <prefix> [--dry-run] [--concurrency N]');
  console.error('Example: node set-cache-headers.js tiles/wildfire/');
  process.exit(1);
}

// Tile and COG bytes are fixed by their key (region/year/z/x/y), so a long
// immutable lifetime is simply true. Sidecar JSON is regenerated in place under
// a stable name and must revalidate instead -- the same split upload-cogs.js
// makes.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=300, must-revalidate';

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.json': 'application/json',
};

const policyFor = (key) => (key.endsWith('.json') ? REVALIDATE : IMMUTABLE);

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const Bucket = process.env.R2_BUCKET_NAME;

async function rewrite(key) {
  await client.send(new CopyObjectCommand({
    Bucket,
    Key: key,
    // Copying an object onto itself with REPLACE is the only way to change
    // metadata without re-uploading the bytes.
    CopySource: `${Bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
    MetadataDirective: 'REPLACE',
    CacheControl: policyFor(key),
    ContentType: CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream',
  }));
}

(async () => {
  console.log(`${dryRun ? 'Scanning' : 'Rewriting'} r2://${Bucket}/${prefix}`);
  console.log(`  immutable: *.png/.jpg/.tif   revalidate: *.json   concurrency: ${concurrency}\n`);

  const t0 = Date.now();
  let token;
  let seen = 0;
  let done = 0;
  let failed = 0;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket, Prefix: prefix, ContinuationToken: token,
    }));
    const keys = (res.Contents ?? []).map((o) => o.Key);
    seen += keys.length;

    if (!dryRun) {
      for (let i = 0; i < keys.length; i += concurrency) {
        const batch = keys.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(rewrite));
        results.forEach((r) => {
          if (r.status === 'fulfilled') done += 1;
          else {
            failed += 1;
            // One line per failure, not a stack: at this volume a thrown error
            // per object would bury the progress it is reporting.
            if (failed <= 10) console.error(`  FAIL ${r.reason?.name}: ${r.reason?.message}`);
          }
        });
        const rate = done / ((Date.now() - t0) / 1000);
        process.stdout.write(`\r  ${done.toLocaleString()} rewritten, ${failed} failed  (${rate.toFixed(0)}/s)`);
      }
    } else {
      process.stdout.write(`\r  ${seen.toLocaleString()} objects`);
    }

    token = res.NextContinuationToken;
  } while (token);

  const secs = (Date.now() - t0) / 1000;
  process.stdout.write('\r');
  if (dryRun) {
    console.log(`${seen.toLocaleString()} objects would be rewritten (listed in ${secs.toFixed(0)}s)`);
    console.log('\n--dry-run: nothing changed');
  } else {
    console.log(`Done: ${done.toLocaleString()} rewritten, ${failed} failed, ${secs.toFixed(0)}s`);
    if (failed) console.log('Re-run to retry the failures -- the operation is idempotent.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
