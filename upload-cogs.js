#!/usr/bin/env node
/**
 * Upload Cloud Optimized GeoTIFFs to Cloudflare R2.
 *
 * Usage:
 *   node upload-cogs.js <local-folder> <r2-destination-prefix>
 *
 * Example:
 *   node upload-cogs.js ./cogs cogs/clearcut
 *
 * Credentials are read from .env.r2 in the project root -- same file upload-tiles.js uses.
 *
 * Why this isn't just upload-tiles.js
 * -----------------------------------
 * A COG is only fast if the browser can range-read it. That needs three things this
 * script sets and the PNG uploader doesn't:
 *   - Content-Type: image/tiff, so the browser doesn't sniff it as a download
 *   - a long immutable Cache-Control, since a regenerated year gets a new filename
 *   - CORS on the bucket (NOT set here -- see the note printed at the end)
 * Without CORS the fetch fails in the browser with an opaque error while curl works
 * fine, which is a genuinely confusing failure to debug after the fact.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.r2') });

const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { rebuildManifest } = require('./generate-cog-manifest');

const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error('Missing R2 credentials. Copy .env.r2.example to .env.r2 and fill in all values.');
  process.exit(1);
}

const [localFolder, destPrefix] = process.argv.slice(2);
if (!localFolder || !destPrefix) {
  console.error('Usage: node upload-cogs.js <local-folder> <r2-destination-prefix>');
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

const CONTENT_TYPES = {
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.json': 'application/json',
};

// Cache policy follows from whether a filename can ever mean something new.
//
// COGs are published under versioned prefixes (clearcut-accumulated-v4/...), so
// a given key's bytes never change and immutable is safe and free.
//
// Sidecar JSON -- patch vectors, stats -- is regenerated in place whenever the
// derivation changes, keeping its filename. Marking that immutable would pin the
// old file in the CDN and in every warm browser for a year, with no way to force
// a refresh short of renaming it. It revalidates instead: cheap, since a 304 is
// a few hundred bytes, and correct when the data is republished.
const CACHE_CONTROL = {
  '.tif': 'public, max-age=31536000, immutable',
  '.tiff': 'public, max-age=31536000, immutable',
  '.json': 'public, max-age=300, must-revalidate',
};

async function uploadFile(localPath, key) {
  const ext = path.extname(localPath).toLowerCase();
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    ContentLength: fs.statSync(localPath).size,
    CacheControl: CACHE_CONTROL[ext] || 'public, max-age=300, must-revalidate',
  }));
}

(async () => {
  const files = fs.readdirSync(localAbs)
    .filter((f) => /\.(tif|tiff|json)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No .tif/.tiff/.json files in ${localAbs}`);
    process.exit(1);
  }

  console.log(`Uploading ${files.length} files -> r2://${R2_BUCKET_NAME}/${destPrefix}/\n`);

  let uploaded = 0;
  let bytes = 0;
  for (const file of files) {
    const localPath = path.join(localAbs, file);
    const key = `${destPrefix}/${file}`;
    const size = fs.statSync(localPath).size;
    try {
      await uploadFile(localPath, key);
      uploaded += 1;
      bytes += size;
      console.log(`  ok  ${key}  (${(size / 1e6).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`  FAIL ${key}: ${err.name} - ${err.message}`);
    }
  }

  console.log(`\nDone: ${uploaded}/${files.length} files, ${(bytes / 1e6).toFixed(2)} MB`);

  // Re-index automatically. The app treats a COG absent from the manifest as
  // not existing and falls back to the PNG pyramid, so forgetting this step
  // fails silently -- the map still draws, just from the wrong source. Doing it
  // here means the manifest cannot drift from the bucket.
  if (uploaded > 0 && /^cogs(\/|$)/.test(destPrefix)) {
    console.log('\nRe-indexing COG manifest…');
    try {
      await rebuildManifest({ client, bucket: R2_BUCKET_NAME, quiet: true });
      console.log('  ok  cogs/manifest.json');
    } catch (err) {
      // Never fail the upload over this: the files are already published, and
      // the fix is one command. Say so loudly instead.
      console.error(`  FAIL manifest: ${err.name} - ${err.message}`);
      console.error('  Run `node generate-cog-manifest.js` before the new COGs will be used.');
    }
  }
  console.log(
    '\nNOTE: browsers range-read COGs cross-origin, so the bucket needs a CORS policy\n'
    + 'allowing GET + the Range header from your app origin. Without it the map shows\n'
    + 'nothing while curl still works. Set it in: Cloudflare Dashboard -> R2 -> your\n'
    + 'bucket -> Settings -> CORS policy. The same policy covers the sidecar JSON,\n'
    + 'which is fetched (not <img>-loaded) and so is equally CORS-gated.',
  );
})();
