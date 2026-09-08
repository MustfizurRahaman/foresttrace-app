const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Cloudflare R2 public bucket holding the tile pyramids.
const R2_BASE_URL = 'https://pub-8f0dff38416c4731a8b07c734030ec5f.r2.dev';

// Layers that can be served off disk instead of R2, for fast iteration on a
// freshly generated pyramid. Set these in client/.env (gitignored) to a
// directory OUTSIDE the repo: 22k+ tiles under client/public/ make the CRA dev
// server crawl at startup, since it scans and watches everything there.
//
// Leave one unset and that layer is proxied to R2 instead, i.e. exactly what
// production serves. That keeps this file free of machine-specific paths, so a
// fresh clone works with no configuration at all.
const LOCAL_TILE_DIRS = {
  '/tiles/wildfire': process.env.WILDFIRE_TILES_DIR,
  '/tiles/wildlife/caribou': process.env.CARIBOU_TILES_DIR,
  // Per-range caribou pyramids (range_<range>_<year>), built by
  // caribou_tiling/code/caribou_tiler_range.py. Not in the bucket yet, so this
  // is the only route that serves them; unset it and the app falls back to the
  // per-FMU tiles on R2. Mounted before /tiles/wildlife/caribou would match, so
  // it has to be its own path segment rather than a prefix of that one.
  '/tiles/wildlife/caribou-range': process.env.CARIBOU_RANGE_TILES_DIR,
  // The pre-simplification wildfire pyramid, mounted alongside the live one so
  // the 4 px edge simplification can be compared tile-for-tile in the browser
  // without swapping directories on disk. Purely a local verification aid:
  // nothing requests it by default, and it just 404s when unset. Express
  // matches mount paths on segment boundaries, so it never shadows
  // /tiles/wildfire.
  '/tiles/wildfire-baseline': process.env.WILDFIRE_BASELINE_TILES_DIR,
};

// Tile routes backed by R2. The two overridable layers appear here as well:
// express.static calls next() on a miss, so a local directory covering only
// part of a pyramid still falls through to R2 for the rest.
const R2_TILE_ROUTES = [
  '/tiles/clearcut',
  '/tiles/clearcut-annual',
  '/tiles/biomass',
  '/tiles/wildfire',
  '/tiles/wildlife/caribou',
  // Listed even though the per-range pyramids may not be uploaded yet: without
  // it a machine that has no local copy has nowhere to fall back to, which is
  // the difference between "works after a clone" and "works only where the
  // tiles were generated". Express matches mount paths on segment boundaries,
  // so this and /tiles/wildlife/caribou stay distinct.
  '/tiles/wildlife/caribou-range',
];

module.exports = function (app) {
  Object.entries(LOCAL_TILE_DIRS).forEach(([route, dir]) => {
    if (dir) {
      app.use(route, express.static(path.normalize(dir)));
    }
  });

  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:3001',
      changeOrigin: true,
    })
  );

  // Forward tile requests to R2 so the browser sees them as same-origin.
  // R2's public URL sends no CORS headers, and RasterTileLayer loads tiles
  // with crossOrigin="anonymous" (it reads pixels to tint them), so direct
  // requests are blocked. Proxying sidesteps that entirely.
  R2_TILE_ROUTES.forEach((route) => {
    app.use(
      route,
      createProxyMiddleware({
        target: R2_BASE_URL,
        changeOrigin: true,
      })
    );
  });

  // Per-FMU boundary GeoJSON lives on R2 too. The committed
  // public/data/regions-simplified.json only carries wabigoon and troutlake,
  // so without this every other FMU renders no outline.
  // Scoped to /data/regions so /data/clearcut_stats.json keeps being served
  // from public/data, where it is committed.
  app.use(
    '/data/regions',
    createProxyMiddleware({
      target: R2_BASE_URL,
      changeOrigin: true,
    })
  );
};
