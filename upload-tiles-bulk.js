#!/usr/bin/env node
/**
 * Upload a large tile pyramid to Cloudflare R2, resumably.
 *
 * upload-tiles.js is fine for the ~22k-file wildfire pyramid, but it uploads in
 * fixed batches of 10 (each batch waits for its slowest file), has no retry, and
 * exits on the first failed PUT with no way to resume. At 600k files that means
 * a single network blip several hours in costs the whole run.
 *
 * This adds:
 *   - a worker pool, so N uploads stay in flight instead of stalling per batch
 *   - retry with backoff on transient failures
 *   - a local progress log, so an interrupted run resumes where it stopped
 *   - --prune, to delete keys under the prefix that no longer exist locally
 *
 * --prune matters when the new pyramid has FEWER tiles than the one it replaces.
 * Without it, tiles removed by the sieve stay in the bucket and keep being
 * served. Uploads always overwrite: a tile present in both may still have
 * different content, so skipping by existence would be wrong.
 *
 * Usage:
 *   node upload-tiles-bulk.js <local-folder> <r2-prefix> [options]
 *
 *   --concurrency N   parallel uploads (default 64)
 *   --prune           delete bucket keys not present locally, after uploading
 *   --cache-control   set Cache-Control: public, max-age=1y, immutable
 *   --dry-run         report what would happen, change nothing
 *   --restart         ignore the progress log and re-upload everything
 *
 * Credentials come from .env.r2, same as upload-tiles.js.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const fs = require('fs');
const {
  S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
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
const positional = args.filter((a) => !a.startsWith('--'));
const [localFolder, destPrefix] = positional;

const CONCURRENCY = (() => {
  const i = args.indexOf('--concurrency');
  return i >= 0 && args[i + 1] ? Math.max(1, parseInt(args[i + 1], 10)) : 64;
})();
const DRY = flags.has('--dry-run');
const PRUNE = flags.has('--prune');
const RESTART = flags.has('--restart');

if (!localFolder || !destPrefix) {
  console.error('Usage: node upload-tiles-bulk.js <local-folder> <r2-prefix> '
    + '[--concurrency N] [--prune] [--dry-run] [--restart]');
  process.exit(1);
}

const localAbs = path.resolve(localFolder);
if (!fs.existsSync(localAbs)) {
  console.error(`Local folder not found: ${localAbs}`);
  process.exit(1);
}

const prefix = destPrefix.replace(/\/+$/, '');
// Kept beside the tiles, not in the repo, so it never risks being committed.
const progressPath = `${localAbs}.upload-progress.log`;

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  maxAttempts: 1,   // retry is handled here so backoff and logging stay visible
});

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const contentType = (f) => {
  const ext = path.extname(f).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
};

const keyFor = (file) => `${prefix}/${path.relative(localAbs, file).replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Without this, responses carry no Cache-Control and every tile is refetched on
// each pan, zoom and reload -- ~131 ms apiece even for a 937-byte tile, since
// the cost is the round trip rather than the bytes. A tile key encodes region,
// year, z, x and y, so its content is fixed for life and safe to pin.
//
// Opt-in rather than default: the existing pyramids were uploaded without it,
// and set-cache-headers.js backfills them one prefix at a time. Making it
// automatic here would change what an upload does for every other module too.
const CACHE_CONTROL = flags.has('--cache-control')
  ? 'public, max-age=31536000, immutable'
  : undefined;

async function putWithRetry(file, key, attempts = 4) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: fs.readFileSync(file),
        ContentType: contentType(file),
        ...(CACHE_CONTROL ? { CacheControl: CACHE_CONTROL } : {}),
      }));
      return true;
    } catch (err) {
      if (i === attempts) {
        console.error(`\n  FAILED ${key}: ${err.message}`);
        return false;
      }
      await sleep(250 * 2 ** (i - 1));   // 250ms, 500ms, 1s
    }
  }
  return false;
}

async function listBucketKeys() {
  const keys = new Set();
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME, Prefix: `${prefix}/`, ContinuationToken: token, MaxKeys: 1000,
    }));
    (r.Contents || []).forEach((o) => keys.add(o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    if (keys.size % 100000 === 0 && keys.size) process.stdout.write(`\r  listed ${keys.size.toLocaleString()}`);
  } while (token);
  return keys;
}

async function main() {
  console.log(`Local : ${localAbs}`);
  console.log(`Target: ${R2_BUCKET_NAME}/${prefix}`);

  const files = walk(localAbs);
  console.log(`Files : ${files.length.toLocaleString()}  (concurrency ${CONCURRENCY}${DRY ? ', DRY RUN' : ''})`);

  let done = new Set();
  if (!RESTART && fs.existsSync(progressPath)) {
    done = new Set(fs.readFileSync(progressPath, 'utf8').split('\n').filter(Boolean));
    console.log(`Resume: ${done.size.toLocaleString()} already uploaded per ${path.basename(progressPath)}`);
  }

  const todo = files.filter((f) => !done.has(keyFor(f)));
  console.log(`To do : ${todo.length.toLocaleString()}`);

  if (!DRY && todo.length) {
    const log = fs.createWriteStream(progressPath, { flags: 'a' });
    let ok = 0; let failed = 0; let i = 0;
    const t0 = Date.now();

    const worker = async () => {
      for (;;) {
        const idx = i; i += 1;
        if (idx >= todo.length) return;
        const file = todo[idx];
        const key = keyFor(file);
        // eslint-disable-next-line no-await-in-loop
        if (await putWithRetry(file, key)) { ok += 1; log.write(`${key}\n`); } else failed += 1;
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
    console.log(`\n  uploaded ${ok.toLocaleString()}, failed ${failed}, `
      + `${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (failed) console.log('  re-run to retry the failures (the progress log skips what succeeded)');
  }

  if (PRUNE) {
    console.log('\nPruning keys that no longer exist locally...');
    const wanted = new Set(files.map(keyFor));
    const inBucket = await listBucketKeys();
    process.stdout.write('\r');
    const stale = [...inBucket].filter((k) => !wanted.has(k));
    console.log(`  in bucket ${inBucket.size.toLocaleString()}, local ${wanted.size.toLocaleString()}, `
      + `stale ${stale.length.toLocaleString()}`);
    if (DRY) {
      console.log('  DRY RUN — nothing deleted');
      stale.slice(0, 5).forEach((k) => console.log(`    would delete ${k}`));
    } else if (stale.length) {
      let removed = 0;
      for (let j = 0; j < stale.length; j += 1000) {
        // eslint-disable-next-line no-await-in-loop
        await client.send(new DeleteObjectsCommand({
          Bucket: R2_BUCKET_NAME,
          Delete: { Objects: stale.slice(j, j + 1000).map((Key) => ({ Key })), Quiet: true },
        }));
        removed += Math.min(1000, stale.length - j);
        process.stdout.write(`\r  deleted ${removed.toLocaleString()}/${stale.length.toLocaleString()}`);
      }
      console.log('');
    }
  }

  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
