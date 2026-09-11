import maplibregl from 'maplibre-gl';
import { processTile } from './tileWorkerClient';

/**
 * MapLibre protocol that applies the Leaflet per-pixel tint to PNG tiles.
 *
 * MapLibre has no declarative way to do this: `raster-color` is a Mapbox GL JS
 * property, and MapLibre's raster paint properties (hue-rotate, saturation,
 * brightness, contrast) can't express an arbitrary ramp like biomass's. So the
 * recoloring happens the same way it always has -- in tileProcessor.worker.js --
 * and this protocol just puts it in front of MapLibre's tile loader.
 *
 * Reusing the worker rather than reimplementing the ramps is the point: the two
 * renderers stay pixel-identical for free, and there's one place to change a
 * color.
 *
 * NOT used for clearcut or wildfire. Those layers are on COGs, where class IDs
 * survive to draw time and coloring is a palette lookup rather than a tint of a
 * pre-flattened PNG. Biomass is the last layer left here: its PNGs encode a
 * 16-bit value across R/G, which is a decode, not a palette lookup.
 */

/** Layers that need the tint and have no COG product yet. */
export const TINTED_LAYER_IDS = new Set(['biomass-density']);

/**
 * Builds a tinted:// URL.
 *
 * Coordinates are carried as explicit path segments rather than parsed back out
 * of the tile URL: MapLibre substitutes {z}/{x}/{y} anywhere in the string, so
 * both copies get the same values, and the tile URL's own layout (which varies
 * per layer, and is TMS for some) never has to be reverse-engineered.
 */
export function tintedTileUrl(layerId, tileUrl) {
  return `tinted://${layerId}/{z}/{x}/{y}/${tileUrl}`;
}

function parseTintedUrl(url) {
  const rest = url.replace(/^tinted:\/\//, '');
  const [layerId, z, x, y, ...tail] = rest.split('/');
  return {
    layerId,
    coords: { z: Number(z), x: Number(x), y: Number(y) },
    tileUrl: tail.join('/'),
  };
}

// Tinted results, keyed by the full tinted:// URL -- which already encodes
// layer, region, year and z/x/y, so it identifies the pixels exactly.
//
// Worth caching because a tinted tile is expensive in a way a plain PNG is not:
// fetch, decode, canvas draw, getImageData, a worker round trip, then
// createImageBitmap. And it is all redone on every year change, because the
// overlay sources are year-scoped (they have to be -- see the setTiles crash),
// so MapLibre drops its own tile cache each frame. Timeline playback therefore
// re-tinted every visible tile of every step, every pass.
//
// ImageData rather than ImageBitmap: MapLibre takes ownership of the bitmap it
// is handed, so a cached one cannot be served twice. Rebuilding a bitmap from
// cached pixels skips the network and the worker, which are the costly parts.
// Sized for playback rather than for a single view: buffering two years ahead
// across several regions puts three frames' worth of tiles in play at once, and
// a cache that evicts within one pass of the timeline is no cache at all.
const MAX_CACHED_TILES = 600;   // ~157 MB worst case at 256x256 RGBA, far less in practice
const tintCache = new Map();

function cacheGet(key) {
  const hit = tintCache.get(key);
  if (!hit) return null;
  // Re-insert to mark as recently used: Map preserves insertion order, so the
  // oldest key is simply the first.
  tintCache.delete(key);
  tintCache.set(key, hit);
  return hit;
}

function cacheSet(key, imageData) {
  tintCache.set(key, imageData);
  while (tintCache.size > MAX_CACHED_TILES) {
    tintCache.delete(tintCache.keys().next().value);
  }
}

/** Frees the cache -- for a hard refresh of regenerated tiles. */
export function clearTintCache() {
  tintCache.clear();
}

// Requests already running, so two sources asking for the same tile at once
// share one fetch and one tint rather than racing.
const inFlightByUrl = new Map();

// In-flight tint requests, per layer.
//
// MapLibre's own isSourceLoaded() is the natural place to ask whether a source
// is busy, and it does not report these as busy -- which is why the wildfire
// and biomass loads showed no indicator while the COG-backed clearcut layer
// did. This protocol is the authority for its own layers: it knows when a fetch
// starts and when the worker hands the tinted bitmap back, which is the real
// span of the work.
const inFlight = new Map();
const listeners = new Set();

function notify() {
  const active = [...inFlight.entries()].filter(([, n]) => n > 0).map(([id]) => id);
  listeners.forEach((fn) => fn(active));
}

function beginTint(layerId) {
  inFlight.set(layerId, (inFlight.get(layerId) || 0) + 1);
  notify();
}

function endTint(layerId) {
  const next = (inFlight.get(layerId) || 1) - 1;
  if (next <= 0) inFlight.delete(layerId);
  else inFlight.set(layerId, next);
  notify();
}

/**
 * Subscribe to tint activity. The callback receives the layer ids currently
 * fetching; an empty array means idle.
 *
 * @returns {Function} unsubscribe
 */
export function onTintActivity(fn) {
  listeners.add(fn);
  fn([...inFlight.keys()]);
  return () => listeners.delete(fn);
}

async function loadTinted(url, signal) {
  const cached = cacheGet(url);
  if (cached) {
    // No fetch, no worker: just re-wrap the pixels we already computed.
    return { data: await createImageBitmap(cached) };
  }

  const running = inFlightByUrl.get(url);
  if (running) return { data: await createImageBitmap(await running) };

  const work = tintTile(url, signal);
  inFlightByUrl.set(url, work);
  try {
    const imageData = await work;
    return { data: await createImageBitmap(imageData) };
  } finally {
    inFlightByUrl.delete(url);
  }
}

/** Fetches and tints one tile, returning the tinted ImageData. */
async function tintTile(url, signal) {
  const { layerId, coords, tileUrl } = parseTintedUrl(url);

  beginTint(layerId);
  try {
    // Fetched rather than loaded as an <img>, because the pixels have to be
    // readable -- which means the tile host needs CORS, same as the COGs do.
    const res = await fetch(tileUrl, { signal });
    if (!res.ok) throw new Error(`${tileUrl}: HTTP ${res.status}`);

    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // The worker also tallies stats, but nothing consumes them here -- the stats
    // path still runs through <RasterTileLayer> on the Leaflet map. Note the
    // biomass area tally would be wrong anyway: it derives latitude from y, and a
    // TMS source hands us a flipped y.
    const { imageData: tinted } = await processTile(layerId, imageData, coords);

    cacheSet(url, tinted);
    return tinted;
  } finally {
    // finally, not after the return: an aborted or 404'd tile must decrement
    // too, or the indicator sticks on forever after a sparse area is panned to.
    endTint(layerId);
  }
}

let registered = false;

/**
 * Registers the protocol. Idempotent, and module-scoped for the same reason the
 * COG protocol is: MapLibre keeps one global registry, so re-registering on a
 * remount throws.
 */
export function ensureTintedProtocol() {
  if (registered) return;
  maplibregl.addProtocol('tinted', (params, abortController) =>
    loadTinted(params.url, abortController?.signal));
  registered = true;
}
