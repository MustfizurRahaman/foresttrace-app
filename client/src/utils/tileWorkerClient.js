// Hands the per-pixel tile recoloring/stat work off to a background worker so
// panning with many regions/layers active doesn't block the main thread.
let worker = null;
let nextRequestId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/tileProcessor.worker.js', import.meta.url));
    worker.onmessage = (event) => {
      const { id, buffer, width, height, redCount, totalCount, histogram } = event.data;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve({
        imageData: new ImageData(new Uint8ClampedArray(buffer), width, height),
        redCount,
        totalCount,
        histogram,
      });
    };
  }
  return worker;
}

/**
 * Recolors an ImageData in a worker and tallies layer-specific stats.
 * Transfers imageData's buffer to the worker — the passed-in ImageData must
 * not be read after calling this.
 *
 * @param {string} layerId
 * @param {ImageData} imageData
 * @param {{ z: number, y: number }} coords
 * @returns {Promise<{ imageData: ImageData, redCount: number, totalCount: number, histogram: Array|null }>}
 */
export function processTile(layerId, imageData, coords) {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    getWorker().postMessage(
      {
        id,
        layerId,
        width: imageData.width,
        height: imageData.height,
        buffer: imageData.data.buffer,
        coords: { z: coords.z, y: coords.y },
      },
      [imageData.data.buffer],
    );
  });
}
