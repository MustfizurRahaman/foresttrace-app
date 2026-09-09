const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.r2') });

const { createProxyMiddleware } = require('http-proxy-middleware');

// Public R2 bucket holding the COGs -- the same origin the production build
// reads directly. Read from the root .env.r2 (the file upload-cogs.js already
// uses) rather than hardcoded here, so the bucket URL lives in one place and a
// bucket swap doesn't mean editing source.
const R2_PUBLIC = process.env.R2_PUBLIC;

// Port the Express API (index.js) listens on. Its own default is 3001 -- chosen
// so CRA can hold 3000 -- and this proxy was pointing at 5001, so /api/chat got
// ECONNREFUSED even with the server running.
//
// Deliberately NOT falling back to process.env.PORT: CRA uses that for the dev
// server itself, so a developer who sets PORT=3000 would have this proxy dial
// the dev server and loop back into itself.
const API_PORT = process.env.API_PORT || 3001;

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: `http://localhost:${API_PORT}`,
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

  // PNG tiles, for the same two reasons as the COGs above.
  //
  // client/public/tiles/ holds only a placeholder set -- there are no wildfire
  // or wildlife tiles locally at all -- so with REACT_APP_TILES_BASE_URL empty
  // those layers 404 against the dev server and silently render nothing. And
  // the layers that get tinted are fetch()ed rather than <img>-loaded so their
  // pixels can be read, which makes them CORS-gated like the COGs.
  //
  // Requests fall through to client/public/tiles/ first, so a locally generated
  // tile set still wins over the bucket.
  app.use(
    '/tiles',
    createProxyMiddleware({
      target: R2_PUBLIC,
      changeOrigin: true,
      pathRewrite: { '^/tiles': '/tiles' },
    })
  );
};
