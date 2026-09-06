import React, { useCallback, useEffect, useRef } from 'react';
import { TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { createEmptyBiomassHistogram } from '../utils/biomassHistogram';
import { processTile } from '../utils/tileWorkerClient';
import { needsBoundaryMask, preloadBoundaryManifest, isWithinReferenceBoundarySync } from '../utils/clearcutBoundaryMask';

const NATIVE_TILE_ZOOM_LEVELS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const TILE_ZOOM_LEVELS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const TILE_ZOOM_RANGE = {
  min: Math.min(...TILE_ZOOM_LEVELS),
  max: Math.max(...TILE_ZOOM_LEVELS),
};
const NATIVE_TILE_ZOOM_RANGE = {
  min: Math.min(...NATIVE_TILE_ZOOM_LEVELS),
  max: Math.max(...NATIVE_TILE_ZOOM_LEVELS),
};
const RASTER_TILE_CLASS = 'foresttrace-raster-tile';
// Delay before a tileUrl change (e.g. dragging the year slider) triggers an
// actual tile refetch — collapses many rapid ticks into one redraw.
const TILE_REDRAW_DEBOUNCE_MS = 200;

// Layer types whose tiles need per-pixel recoloring + stat tallying. That
// work happens in a worker (see tileWorkerClient) and the resulting canvas
// tiles are added to the map imperatively — these layers render nothing
// through react-leaflet's <TileLayer>.
const PROCESSED_LAYER_IDS = new Set([
  'clearcut-accumulated',
  'clearcut-annual',
  'wildfire-burned',
  'biomass-density',
]);

function wrapTileX(x, z) {
  const tilesPerAxis = 2 ** z;
  return ((x % tilesPerAxis) + tilesPerAxis) % tilesPerAxis;
}

function clampTileY(y, z) {
  const max = (2 ** z) - 1;
  if (y < 0) return 0;
  if (y > max) return max;
  return y;
}

function normalizeTileCoords(coords) {
  return {
    ...coords,
    x: wrapTileX(coords.x, coords.z),
    y: clampTileY(coords.y, coords.z),
  };
}

function RasterTileLayer({
  onStatsUpdate,
  onBiomassHistogramUpdate,
  onLoadingChange = null,
  opacity = 0.5,
  tileUrl,
  tms = true,
  layerId = '',
  region = null,
  year = null,
}) {
  const map = useMap();
  const lowResLayerRef = useRef(null);
  const highResLayerRef = useRef(null);
  const canvasLayerRef = useRef(null);
  const tileCountsRef = useRef(new Map());
  const biomassTileHistogramRef = useRef(new Map());
  const styleTagRef = useRef(null);
  const tileUrlRef = useRef(tileUrl);
  const yearRef = useRef(year);
  const isFirstTileUrlSync = useRef(true);
  const onStatsUpdateRef = useRef(onStatsUpdate);
  const onBiomassHistogramUpdateRef = useRef(onBiomassHistogramUpdate);
  const onLoadingChangeRef = useRef(onLoadingChange);

  onStatsUpdateRef.current = onStatsUpdate;
  onBiomassHistogramUpdateRef.current = onBiomassHistogramUpdate;
  onLoadingChangeRef.current = onLoadingChange;

  useEffect(() => {
    if (!styleTagRef.current) {
      const style = document.createElement('style');
      style.id = 'tile-opacity-rule';
      document.head.appendChild(style);
      styleTagRef.current = style;
    }

    const rule = `.${RASTER_TILE_CLASS} { opacity: ${opacity} !important; }`;
    styleTagRef.current.textContent = rule;
  }, [opacity, layerId]);

  const emitBiomassHistogram = useCallback(() => {
    if (!onBiomassHistogramUpdateRef.current) return;
    const combined = createEmptyBiomassHistogram();
    biomassTileHistogramRef.current.forEach((tileBins) => {
      tileBins.forEach((tileBin, idx) => {
        combined[idx].area += tileBin.area;
        combined[idx].pixels += tileBin.pixels;
      });
    });
    onBiomassHistogramUpdateRef.current(combined);
  }, []);

  const updateVisiblePercentage = useCallback(() => {
    let visibleRed = 0;
    let visibleTotal = 0;

    [lowResLayerRef.current, highResLayerRef.current, canvasLayerRef.current].forEach((layer) => {
      if (!layer || !layer._tiles) return;
      Object.values(layer._tiles).forEach((tile) => {
        if (!tile || !tile.coords) return;
        const key = `${tile.coords.z}/${tile.coords.x}/${tile.coords.y}`;
        const counts = tileCountsRef.current.get(key);
        if (!counts) return;
        visibleRed += counts.red;
        visibleTotal += counts.total;
      });
    });

    const percentage = visibleTotal > 0
      ? ((visibleRed / visibleTotal) * 100).toFixed(2)
      : '0.00';

    if (onStatsUpdateRef.current) onStatsUpdateRef.current(percentage);
  }, []);

  // Generic fallback for layer types with no dedicated recoloring (currently
  // the placeholder forest/wildlife layers): just detects pure-red pixels for
  // the visible-percentage stat, no worker involved.
  const handleTileLoad = useCallback((e) => {
    // Habitat tiles already contain the color ramp and transparency.
    if (layerId === 'caribou-habitat') return;

    const img = e.tile;
    if (!(img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)) return;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = img.naturalWidth;
    tmpCanvas.height = img.naturalHeight;
    const ctx = tmpCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height).data;

    let redCount = 0;
    let totalCount = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      totalCount += 1;
      if (pixels[i + 3] > 0 && pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 0) {
        redCount += 1;
      }
    }

    if (e.coords) {
      const key = `${e.coords.z}/${e.coords.x}/${e.coords.y}`;
      tileCountsRef.current.set(key, { red: redCount, total: totalCount });
    }
    updateVisiblePercentage();
  }, [layerId, updateVisiblePercentage]);

  const handleClearcutTileError = useCallback((e) => {
    if (!e.coords) return;
    const key = `${e.coords.z}/${e.coords.x}/${e.coords.y}`;
    tileCountsRef.current.delete(key);
    updateVisiblePercentage();
  }, [updateVisiblePercentage]);

  const handleClearcutTileUnload = useCallback((e) => {
    if (!e.coords) return;
    const key = `${e.coords.z}/${e.coords.x}/${e.coords.y}`;
    tileCountsRef.current.delete(key);
    updateVisiblePercentage();
  }, [updateVisiblePercentage]);

  useEffect(() => {
    if (!map) return;
    const handleMove = () => updateVisiblePercentage();
    map.on('moveend', handleMove);
    map.on('zoomend', handleMove);
    return () => {
      map.off('moveend', handleMove);
      map.off('zoomend', handleMove);
    };
  }, [map, updateVisiblePercentage]);

  // Worker-backed canvas layer for clearcut/wildfire/biomass tiles: fetches
  // each tile at its native zoom, crop-scales it onto a 256x256 canvas,
  // hands the raw pixels to the worker for recoloring + stat tallying, then
  // paints the result. Keeps the pixel loop and PNG re-encode off the main
  // thread entirely.
  //
  // The layer instance itself is created once per map/layerId/tms — NOT per
  // tileUrl — so a year change (which only changes tileUrl) doesn't tear
  // down and rebuild the whole GridLayer (and the onLoadingChange/histogram
  // churn that came with it). createTile reads the URL from tileUrlRef at
  // request time; the effect below updates that ref and calls redraw() to
  // refetch tiles in place, the same way react-leaflet's own <TileLayer>
  // handles a url change via setUrl instead of remounting.
  useEffect(() => {
    if (!map || !PROCESSED_LAYER_IDS.has(layerId)) return undefined;

    const isBiomass = layerId === 'biomass-density';
    const biomassHistogramMap = biomassTileHistogramRef.current;
    const tileCountsMap = tileCountsRef.current;

    if (needsBoundaryMask(layerId, region, yearRef.current)) {
      preloadBoundaryManifest();
    }

    if (onLoadingChangeRef.current) onLoadingChangeRef.current(true);

    const ProcessedTileLayer = L.GridLayer.extend({
      createTile(coords, done) {
        const normalizedCoords = normalizeTileCoords(coords);
        const nativeZ = Math.min(normalizedCoords.z, NATIVE_TILE_ZOOM_RANGE.max);
        const zoomDiff = normalizedCoords.z - nativeZ;
        const scale = 2 ** zoomDiff;
        const nativeCoords = normalizeTileCoords({
          ...normalizedCoords,
          z: nativeZ,
          x: Math.floor(normalizedCoords.x / scale),
          y: Math.floor(normalizedCoords.y / scale),
        });
        const srcSize = 256 / scale;
        const srcX = (normalizedCoords.x % scale) * srcSize;
        const srcY = (normalizedCoords.y % scale) * srcSize;

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        const applyMask = needsBoundaryMask(layerId, region, yearRef.current);
        if (applyMask) {
          const withinBoundary = isWithinReferenceBoundarySync(nativeCoords.z, nativeCoords.x, nativeCoords.y);
          if (withinBoundary === false) {
            // Known to fall outside the 2021 reference footprint — skip the
            // fetch entirely and leave the tile blank.
            done(null, canvas);
            return canvas;
          }
        }

        const img = new Image();
        img.crossOrigin = 'anonymous';
        // Stashed so a superseded tile (panned away, or redrawn for a new
        // year before this one finished) can abort the in-flight fetch
        // instead of leaving it to run to completion in the background —
        // see handleTileUnload below.
        canvas._pendingImage = img;

        img.onload = () => {
          const tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = 256;
          tmpCanvas.height = 256;
          const tmpCtx = tmpCanvas.getContext('2d');
          tmpCtx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, 256, 256);
          const imageData = tmpCtx.getImageData(0, 0, 256, 256);

          delete canvas._pendingImage;

          if (applyMask) {
            const withinBoundary = isWithinReferenceBoundarySync(nativeCoords.z, nativeCoords.x, nativeCoords.y);
            if (withinBoundary === false) {
              done(null, canvas);
              return;
            }
          }

          processTile(layerId, imageData, normalizedCoords).then((result) => {
            ctx.putImageData(result.imageData, 0, 0);

            const key = `${normalizedCoords.z}/${normalizedCoords.x}/${normalizedCoords.y}`;
            if (isBiomass) {
              biomassTileHistogramRef.current.set(key, result.histogram);
              emitBiomassHistogram();
            } else {
              tileCountsRef.current.set(key, { red: result.redCount, total: result.totalCount });
              updateVisiblePercentage();
            }

            done(null, canvas);
          });
        };

        img.onerror = () => {
          delete canvas._pendingImage;
          done(new Error(`Failed to load tile ${nativeCoords.z}/${nativeCoords.x}/${nativeCoords.y}`), canvas);
        };

        const tileY = tms ? (2 ** nativeCoords.z - 1 - nativeCoords.y) : nativeCoords.y;
        img.src = L.Util.template(tileUrlRef.current, { ...nativeCoords, y: tileY });

        return canvas;
      },
    });

    const gridLayer = new ProcessedTileLayer({
      minZoom: TILE_ZOOM_RANGE.min,
      maxZoom: TILE_ZOOM_RANGE.max,
      keepBuffer: 1,
      zIndex: 10,
      className: RASTER_TILE_CLASS,
    });

    canvasLayerRef.current = gridLayer;
    gridLayer.addTo(map);

    const handleTileUnload = (e) => {
      const pendingImage = e.tile && e.tile._pendingImage;
      if (pendingImage) {
        pendingImage.onload = null;
        pendingImage.onerror = null;
        pendingImage.src = ''; // aborts the in-flight request
        delete e.tile._pendingImage;
      }
      if (!e.coords) return;
      const key = `${e.coords.z}/${e.coords.x}/${e.coords.y}`;
      if (isBiomass) {
        biomassTileHistogramRef.current.delete(key);
        emitBiomassHistogram();
      } else {
        tileCountsRef.current.delete(key);
        updateVisiblePercentage();
      }
    };
    gridLayer.on('tileunload', handleTileUnload);
    gridLayer.on('tileerror', handleTileUnload);

    const handleLoad = () => {
      if (onLoadingChangeRef.current) onLoadingChangeRef.current(false);
      if (!isBiomass) updateVisiblePercentage();
    };
    gridLayer.on('load', handleLoad);
    gridLayer.on('loading', () => {
      if (onLoadingChangeRef.current) onLoadingChangeRef.current(true);
    });

    return () => {
      gridLayer.off('tileunload', handleTileUnload);
      gridLayer.off('tileerror', handleTileUnload);
      gridLayer.off('load', handleLoad);
      map.removeLayer(gridLayer);
      canvasLayerRef.current = null;
      if (onLoadingChangeRef.current) onLoadingChangeRef.current(false);
      if (isBiomass) {
        biomassHistogramMap.clear();
        if (onBiomassHistogramUpdateRef.current) {
          onBiomassHistogramUpdateRef.current(createEmptyBiomassHistogram());
        }
      } else {
        tileCountsMap.clear();
        updateVisiblePercentage();
      }
    };
  }, [map, layerId, tms, region, emitBiomassHistogram, updateVisiblePercentage]);

  // Keeps the GridLayer above alive across a tileUrl change (e.g. the year
  // slider) — updates the ref createTile reads from immediately (cheap), but
  // debounces the actual redraw(). redraw() re-fetches every visible tile
  // from scratch, and a slider drag fires one tileUrl change per pixel of
  // movement — without debouncing, a single drag triggers a full refetch
  // storm per tick. Waiting for the drag to pause collapses that into one
  // redraw per interaction instead of one per tick.
  useEffect(() => {
    tileUrlRef.current = tileUrl;
    yearRef.current = year;
    if (isFirstTileUrlSync.current) {
      isFirstTileUrlSync.current = false;
      return undefined;
    }
    const timer = setTimeout(() => {
      if (canvasLayerRef.current) {
        canvasLayerRef.current.redraw();
      }
    }, TILE_REDRAW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tileUrl, year]);

  if (PROCESSED_LAYER_IDS.has(layerId)) {
    return null;
  }

  // Keep pre-colored habitat tiles on one native-zoom-aware image layer.
  if (layerId === 'caribou-habitat') {
    return (
      <TileLayer
        ref={highResLayerRef}
        url={tileUrl}
        minZoom={TILE_ZOOM_RANGE.min}
        maxZoom={TILE_ZOOM_RANGE.max}
        maxNativeZoom={NATIVE_TILE_ZOOM_RANGE.max}
        zIndex={10}
        className={RASTER_TILE_CLASS}
        tms={tms}
        crossOrigin="anonymous"
        keepBuffer={1}
        eventHandlers={{
          loading: () => onLoadingChangeRef.current?.(true),
          load: () => onLoadingChangeRef.current?.(false),
        }}
      />
    );
  }

  return (
    <>
      <TileLayer
        ref={lowResLayerRef}
        url={tileUrl}
        minZoom={TILE_ZOOM_RANGE.min}
        maxZoom={12}
        maxNativeZoom={12}
        zIndex={10}
        className={RASTER_TILE_CLASS}
        tms={tms}
        crossOrigin="anonymous"
        keepBuffer={1}
        eventHandlers={{
          tileload: (e) => {
            handleTileLoad(e);
          },
          tileerror: (e) => {
            handleClearcutTileError(e);
          },
          tileunload: (e) => {
            handleClearcutTileUnload(e);
          },
        }}
      />
      <TileLayer
        ref={highResLayerRef}
        url={tileUrl}
        minZoom={13}
        maxZoom={TILE_ZOOM_RANGE.max}
        maxNativeZoom={NATIVE_TILE_ZOOM_RANGE.max}
        zIndex={10}
        className={RASTER_TILE_CLASS}
        tms={tms}
        crossOrigin="anonymous"
        keepBuffer={1}
        eventHandlers={{
          tileload: (e) => {
            handleTileLoad(e);
          },
          tileerror: (e) => {
            handleClearcutTileError(e);
          },
          tileunload: (e) => {
            handleClearcutTileUnload(e);
          },
        }}
      />
    </>
  );
}

export default RasterTileLayer;
