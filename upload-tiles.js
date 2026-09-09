#!/usr/bin/env node
/**
 * Upload a local tile folder to Cloudflare R2.
 *
 * Usage:
 *   node upload-tiles.js <local-folder> <r2-destination-prefix>
 *
 * Example:
 *   node upload-tiles.js client/public/tiles/clearcut/troutlake_2020 tiles/clearcut/troutlake_2020
 *
 * Credentials are read from .env.r2 in the project root.
 * Copy .env.r2.example → .env.r2 and fill in your values before running.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error('Missing R2 credentials. Copy .env.r2.example to .env.r2 and fill in all values.');
  process.exit(1);
}

const [localFolder, destPrefix] = process.argv.slice(2);
if (!localFolder || !destPrefix) {
  console.error('Usage: node upload-tiles.js <local-folder> <r2-destination-prefix>');
  process.exit(1);
}

const localAbs = path.resolve(localFolder);
if (!fs.existsSync(localAbs)) {
  console.error(`Local folder not found: ${localAbs}`);
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

function walk(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.json' ? 'application/json'
    : 'application/octet-stream';
}

async function main() {
  const files = walk(localAbs);
  console.log(`Uploading ${files.length} files from ${localAbs} → ${R2_BUCKET_NAME}/${destPrefix}`);

  let done = 0;
  const CONCURRENCY = 10;

  async function uploadFile(file) {
    const key = destPrefix.replace(/\/$/, '') + '/' + path.relative(localAbs, file).replace(/\\/g, '/');
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fs.readFileSync(file),
      ContentType: contentType(file),
      // Tiles went up with no Cache-Control at all, leaving browsers to guess:
      // with only ETag and Last-Modified they fall back to heuristic freshness,
      // which happens to work but is not a decision anyone made and collapses
      // to zero for a freshly uploaded tile -- exactly when the timeline's
      // playback is re-requesting the same years over and over.
      //
      // A tile's bytes are fixed by its region/year/z/x/y path, so a long
      // immutable lifetime is simply true. Regenerating a year means new pixels
      // under the same key, which is what upload-tiles.js is for, so bump the
      // year's directory or purge if that ever needs to be visible immediately.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    done += 1;
    process.stdout.write(`\r${done}/${files.length}`);
  }

  // Upload in batches to avoid overwhelming the connection pool.
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    await Promise.all(files.slice(i, i + CONCURRENCY).map(uploadFile));
  }

  console.log(`\nDone.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });