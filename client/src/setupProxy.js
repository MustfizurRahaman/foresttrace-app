const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.r2') });

const { createProxyMiddleware } = require('http-proxy-middleware');

// Public R2 bucket holding the COGs -- the same origin the production build
// reads directly. Read from the root .env.r2 (the file upload-cogs.js already
// uses) rather than hardcoded here, so the bucket URL lives in one place and a
// bucket swap doesn't mean editing source.
const R2_PUBLIC = process.env.R2_PUBLIC;

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:5001',
      changeOrigin: true,
    })
  );

  // COGs are range-read by the browser, and a Range header isn't CORS-safelisted,
  // so every read triggers a preflight the bucket must answer. Proxying them
  // through the dev server makes them same-origin, so local work isn't blocked on
  // the bucket's CORS policy.
  //
  // This is a DEV-ONLY convenience -- react-scripts ignores this file in a
  // production build, where the app reads the bucket directly and the CORS policy
  // is load-bearing. Verifying a COG works locally therefore proves nothing about
  // whether it will work in production.
  if (!R2_PUBLIC) {
    // Warn rather than throw: the COG path is behind a flag, so a dev who isn't
    // touching it should still get a working /api proxy.
    console.warn(
      '[setupProxy] R2_PUBLIC is not set in .env.r2 -- skipping the /cogs proxy. ' +
        'COG layers will not load locally until it is set (see .env.r2.example).'
    );
    return;
  }

  app.use(
    '/cogs',
    createProxyMiddleware({
      target: R2_PUBLIC,
      changeOrigin: true,
      pathRewrite: { '^/cogs': '/cogs' },
    })
  );
};
