const path = require('path');
const express = require('express');
const https = require('https');
const { createProxyMiddleware } = require('http-proxy-middleware');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.r2') });

// A map view fans out into dozens of parallel tile requests, and without a
// keep-alive agent each one opens a fresh TLS connection and a fresh DNS
// lookup. That is what produces the intermittent ENOTFOUND against R2: the
// bucket is reachable, the resolver is just being asked hundreds of times a
// second. Pooling connections collapses that to a handful of lookups and makes
// the tiles arrive faster besides.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 24,
  timeout: 30000,
});

// Public R2 bucket -- the same origin the production build reads directly, and
// the same bucket upload-cogs.js and upload-tiles.js write to. Read from the
// root .env.r2 rather than hardcoded, so the bucket URL lives in one place and a
// bucket swap doesn't mean editing source.
const R2_PUBLIC = process.env.R2_PUBLIC;

// Port the Express API (index.js) listens on. Its own default is 3001 -- chosen
// so CRA can hold 3000 -- and this proxy used to point at 5001, so /api/chat got
// ECONNREFUSED even with the server running.
//
// Deliberately NOT falling back to process.env.PORT: CRA uses that for the dev
// server itself, so a developer who sets PORT=3000 would have this proxy dial
// the dev server and loop back into itself.
const API_PORT = process.env.API_PORT || 3001;

// Layers that can be served off disk instead of R2, for fast iteration on a
// freshly generated pyramid. Set these in client/.env (gitignored) to a
// directory OUTSIDE the repo: 22k+ tiles under client/public/ make the CRA dev
// server crawl at startup, since it scans and watches everything there.
//
// Leave one unset and that layer falls through to the /tiles R2 proxy instead,
// i.e. exactly what production serves. That keeps this file free of
// machine-specific paths, so a fresh clone works with no configuration at all.
const LOCAL_TILE_DIRS = {
  '/tiles/wildfire': process.env.WILDFIRE_TILES_DIR,
  '/tiles/wildlife/caribou': process.env.CARIBOU_TILES_DIR,
  // Per-range caribou pyramids (range_<range>_<year>), built by
  // caribou_tiling/code/caribou_tiler_range.py. Express matches mount paths on
  // segment boundaries, so this and /tiles/wildlife/caribou stay distinct.
  '/tiles/wildlife/caribou-range': process.env.CARIBOU_RANGE_TILES_DIR,
  // The pre-simplification wildfire pyramid, mounted alongside the live one so
  // the 4 px edge simplification can be compared tile-for-tile in the browser
  // without swapping directories on disk. Purely a local verification aid:
  // nothing requests it by default, and it just 404s when unset.
  '/tiles/wildfire-baseline': process.env.WILDFIRE_BASELINE_TILES_DIR,
};

// Shared config for the R2 passthroughs.
function r2Proxy(prefix) {
  return {
    target: R2_PUBLIC,
    changeOrigin: true,
    agent: keepAliveAgent,
    pathRewrite: { [`^${prefix}`]: prefix },
    // A missing tile is normal -- pyramids are sparse -- and a transient DNS
    // failure is not worth a stack trace per tile. Answer the browser and log
    // one line instead of letting the default handler print the full error.
    onError: (err, _req, res) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`proxy error: ${err.code || err.message}`);
    },
  };
}

module.exports = function (app) {
  // Disk-backed layers first, and outside the R2_PUBLIC guard below: they need
  // no bucket, so a dev working from local pyramids stays unblocked even with
  // .env.r2 unconfigured. express.static calls next() on a miss, so a local
  // directory covering only part of a pyramid still falls through to R2.
  Object.entries(LOCAL_TILE_DIRS).forEach(([route, dir]) => {
    if (dir) {
      app.use(route, express.static(path.normalize(dir)));
    }
  });

  app.use(
    '/api',
    createProxyMiddleware({
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true,
    })
  );

  if (!R2_PUBLIC) {
    // Warn rather than throw: /api and any disk-backed layer still work, so a
    // dev who isn't touching remote tiles should still get a usable server.
    console.warn(
      '[setupProxy] R2_PUBLIC is not set in .env.r2 -- skipping the /tiles, '
        + '/data/regions and /cogs proxies. Remote layers will not load locally '
        + 'until it is set (see .env.r2.example).'
    );
    return;
  }

  // Per-FMU boundary GeoJSON lives on R2 too. The committed
  // public/data/regions-simplified.json only carries wabigoon and troutlake,
  // so without this every other FMU renders no outline.
  // Scoped to /data/regions so /data/clearcut_stats.json keeps being served
  // from public/data, where it is committed.
  app.use('/data/regions', createProxyMiddleware(r2Proxy('/data/regions')));

  // COGs are range-read by the browser, and a Range header isn't CORS-safelisted,
  // so every read triggers a preflight the bucket must answer. Proxying them
  // through the dev server makes them same-origin, so local work isn't blocked on
  // the bucket's CORS policy.
  //
  // This is a DEV-ONLY convenience -- react-scripts ignores this file in a
  // production build, where the app reads the bucket directly and the CORS policy
  // is load-bearing. Verifying a COG works locally therefore proves nothing about
  // whether it will work in production.
  app.use('/cogs', createProxyMiddleware(r2Proxy('/cogs')));

  // PNG tiles, for the same two reasons as the COGs above.
  //
  // client/public/tiles/ holds only a placeholder set -- there are no wildfire
  // or wildlife tiles locally at all -- so with REACT_APP_TILES_BASE_URL empty
  // those layers 404 against the dev server and silently render nothing. And
  // the layers that get tinted are fetch()ed rather than <img>-loaded so their
  // pixels can be read, which makes them CORS-gated like the COGs.
  //
  // A single catch-all rather than a per-layer list: the LOCAL_TILE_DIRS mounts
  // above and client/public/tiles/ are both consulted first, so a locally
  // generated tile set still wins over the bucket.
  app.use('/tiles', createProxyMiddleware(r2Proxy('/tiles')));
};
