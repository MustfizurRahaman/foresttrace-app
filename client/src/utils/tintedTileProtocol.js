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
 * NOT used for clearcut. Those layers are moving to COGs, where class IDs
 * survive to draw time and coloring is a palette lookup rather than a tint of a
 * pre-flattened PNG.
 */

/** Layers that need the tint and have no COG product yet. */
export const TINTED_LAYER_IDS = new Set(['wildfire-burned', 'biomass-density']);

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

async function loadTinted(url, signal) {
  const { layerId, coords, tileUrl } = parseTintedUrl(url);

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

  return { data: await createImageBitmap(tinted) };
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
