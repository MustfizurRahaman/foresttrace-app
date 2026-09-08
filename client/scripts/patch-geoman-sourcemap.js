#!/usr/bin/env node
/**
 * Strips the sourceMappingURL comment from leaflet-geoman's dist bundle.
 *
 * @geoman-io/leaflet-geoman-free ships a truncated leaflet-geoman.js.map -- the
 * published file is cut off mid-string, so source-map-loader throws
 * "Unterminated string in JSON" on every dev build. The bundle itself is fine;
 * only the map is bad.
 *
 * Dropping the comment makes webpack skip the map for this one file, which keeps
 * our own source maps intact -- GENERATE_SOURCEMAP=false would have disabled
 * them everywhere.
 *
 * Runs as postinstall because node_modules is rewritten by every install. It is
 * idempotent and never fails the install: a missing package or a fixed upstream
 * map is a no-op, not an error.
 */

const fs = require('fs');
const path = require('path');

const BUNDLE = path.join(
  __dirname, '..', 'node_modules', '@geoman-io', 'leaflet-geoman-free', 'dist', 'leaflet-geoman.js',
);
const MAP = `${BUNDLE}.map`;
const MARKER = '//# sourceMappingURL=leaflet-geoman.js.map';

try {
  if (!fs.existsSync(BUNDLE)) process.exit(0);

  // Leave it alone if upstream ever ships a valid map.
  if (fs.existsSync(MAP)) {
    try {
      JSON.parse(fs.readFileSync(MAP, 'utf8'));
      process.exit(0);
    } catch {
      // Corrupt, as expected -- fall through and strip the reference.
    }
  }

  const src = fs.readFileSync(BUNDLE, 'utf8');
  if (!src.includes(MARKER)) process.exit(0);

  fs.writeFileSync(BUNDLE, src.replace(MARKER, ''));
  console.log('[patch-geoman-sourcemap] stripped reference to corrupt leaflet-geoman.js.map');
} catch (err) {
  console.warn('[patch-geoman-sourcemap] skipped:', err.message);
}
