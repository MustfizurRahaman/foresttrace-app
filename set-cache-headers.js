#!/usr/bin/env node
/**
 * Backfill Cache-Control on tiles already in R2, without re-uploading them.
 *
 * Tiles were uploaded with only a Content-Type, so responses carry no
 * Cache-Control at all. Measured effect: a 937-byte caribou tile costs ~131 ms
 * every time it is requested, because neither the browser nor Cloudflare is
 * told it may keep a copy -- so every pan, zoom and reload refetches the whole
 * viewport from the origin bucket.
 *
 * Tile keys embed region, year, z, x and y, so a given key's bytes never
 * change. They are safe to cache indefinitely.
 *
 * CopyObject with MetadataDirective REPLACE rewrites an object's metadata in
 * place -- no data transfer, no re-upload of the 600k files.
 *
 * Scoped to one prefix on purpose. It defaults to the caribou pyramid so the
 * other modules' tiles are left exactly as they are; pass --prefix to widen it
 * deliberately rather than by accident.
 *
 * Usage:
 *   node set-cache-headers.js [options]
 *
 *   --prefix P        key prefix to rewrite (default tiles/wildlife/caribou/)
 *   --max-age N       seconds (default 31536000, one year)
 *   --concurrency N   parallel copies (default 64)
 *   --dry-run         list what would change, change nothing
 *   --restart         ignore the progress log and redo everything
 *
 * Credentials come from .env.r2, same as upload-tiles.js.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const fs = require('fs');
const {
  S3Client, ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const {
  CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
} = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error('Missing R2 credentials. Fill in .env.r2 (see .env.r2.example).');
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PREFIX = valueOf('--prefix', 'tiles/wildlife/caribou/');
const MAX_AGE = parseInt(valueOf('--max-age', '31536000'), 10);
const CONCURRENCY = Math.max(1, parseInt(valueOf('--concurrency', '64'), 10));
const DRY = flags.has('--dry-run');
const RESTART = flags.has('--restart');

// immutable tells the browser not to revalidate at all: no conditional request,
// no round trip. Correct here because a tile key's content is fixed for life.
const CACHE_CONTROL = `public, max-age=${MAX_AGE}, immutable`;

const progressPath = path.join(
  __dirname,
  `.cache-headers-progress-${PREFIX.replace(/[^a-z0-9]+/gi, '_')}.log`,
);

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  maxAttempts: 1,   // retry handled here so backoff and logging stay visible
});

// MetadataDirective REPLACE drops every header not restated, so Content-Type
// has to be supplied again -- omitting it would leave tiles served as
// application/octet-stream and the map would stop rendering them.
const contentType = (key) => {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json' || ext === '.geojson') return 'application/json';
  return 'application/octet-stream';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listKeys() {
  const keys = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME, Prefix: PREFIX, ContinuationToken: token, MaxKeys: 1000,
    }));
    (r.Contents || []).forEach((o) => keys.push(o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    if (keys.length % 50000 === 0 && keys.length) {
      process.stdout.write(`\r  listed ${keys.length.toLocaleString()}`);
    }
  } while (token);
  process.stdout.write('\r');
  return keys;
}

async function setHeaderWithRetry(key, attempts = 4) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await client.send(new CopyObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        CopySource: `${R2_BUCKET_NAME}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: contentType(key),
        CacheControl: CACHE_CONTROL,
      }));
      return true;
    } catch (err) {
      if (i === attempts) {
        console.error(`\n  FAILED ${key}: ${err.message}`);
        return false;
      }
      await sleep(250 * 2 ** (i - 1));
    }
  }
  return false;
}

async function main() {
  console.log(`Bucket : ${R2_BUCKET_NAME}`);
  console.log(`Prefix : ${PREFIX}`);
  console.log(`Header : Cache-Control: ${CACHE_CONTROL}`);
  console.log(`Mode   : ${DRY ? 'DRY RUN' : `live, concurrency ${CONCURRENCY}`}\n`);

  console.log('Listing objects...');
  const keys = await listKeys();
  console.log(`Found  : ${keys.length.toLocaleString()} objects`);

  if (keys.length === 0) {
    console.log('Nothing to do -- check the prefix.');
    return;
  }

  let done = new Set();
  if (!RESTART && fs.existsSync(progressPath)) {
    done = new Set(fs.readFileSync(progressPath, 'utf8').split('\n').filter(Boolean));
    console.log(`Resume : ${done.size.toLocaleString()} already done per ${path.basename(progressPath)}`);
  }

  const todo = keys.filter((k) => !done.has(k));
  console.log(`To do  : ${todo.length.toLocaleString()}\n`);

  if (DRY) {
    const before = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: keys[0] }));
    console.log('Sample object, current metadata:');
    console.log(`  key           : ${keys[0]}`);
    console.log(`  Content-Type  : ${before.ContentType || '(none)'}`);
    console.log(`  Cache-Control : ${before.CacheControl || '(none)'}`);
    console.log('\nWould become:');
    console.log(`  Content-Type  : ${contentType(keys[0])}`);
    console.log(`  Cache-Control : ${CACHE_CONTROL}`);
    console.log(`\nDRY RUN -- ${todo.length.toLocaleString()} objects would be rewritten, nothing changed.`);
    return;
  }

  const log = fs.createWriteStream(progressPath, { flags: 'a' });
  let ok = 0; let failed = 0; let i = 0;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const idx = i; i += 1;
      if (idx >= todo.length) return;
      const key = todo[idx];
      // eslint-disable-next-line no-await-in-loop
      if (await setHeaderWithRetry(key)) { ok += 1; log.write(`${key}\n`); } else failed += 1;
      const n = ok + failed;
      if (n % 2000 === 0) {
        const rate = n / ((Date.now() - t0) / 1000);
        const eta = (todo.length - n) / Math.max(rate, 0.001) / 60;
        process.stdout.write(`\r  ${n.toLocaleString()}/${todo.length.toLocaleString()}  `
          + `${rate.toFixed(0)}/s  ETA ${eta.toFixed(0)} min  failed ${failed}   `);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log.end();

  console.log(`\n\nRewrote ${ok.toLocaleString()}, failed ${failed}, `
    + `${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (failed) console.log('Re-run to retry the failures (the progress log skips what succeeded).');
}

main().catch((err) => { console.error(err); process.exit(1); });
