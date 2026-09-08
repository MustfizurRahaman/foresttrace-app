import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import Map, { Source, Layer, NavigationControl, useMap } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import { cogProtocol, setColorFunction } from '@geomatico/maplibre-cog-protocol';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildClassColorFunction, DEFAULT_VISIBLE_CLASSES, CLEARCUT_CLASS_ID } from '../utils/clearcutClasses';
import { ensureTintedProtocol } from '../utils/tintedTileProtocol';

// COG support is a URL protocol handler, not a layer type: once registered,
// any source whose url starts with cog:// is range-read straight from R2 with
// no tile server in between. Registered at module scope because MapLibre keeps
// one global protocol registry -- doing it per-mount would re-register on every
// remount and throw.
let cogProtocolRegistered = false;
function ensureCogProtocol() {
  if (cogProtocolRegistered) return;
  maplibregl.addProtocol('cog', cogProtocol);
  cogProtocolRegistered = true;
}

// MapLibre ships no default basemap, so the style is built by hand. These are
// the same XYZ endpoints the Leaflet build used -- MapLibre substitutes {z}/{x}/{y}
// by name, so the EOX/Esri {z}/{y}/{x} ordering carries over unchanged.
const EMPTY_STYLE = {
  version: 8,
  // MapLibre refuses to render text/symbol layers without a glyph source. None
  // of our layers use symbols today, but omitting this makes any later label
  // layer fail with a non-obvious "glyphs" error rather than just not drawing.
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {},
  layers: [],
};

/**
 * Builds the basemap portion of the style.
 *
 * Kept as a plain object rather than <Source> children because the basemap has
 * to sit underneath every overlay: MapLibre orders layers by their position in
 * style.layers, and declarative <Layer> children append, so a basemap added that
 * way would paint over the rasters it's supposed to sit behind.
 */
function buildBasemapStyle({ basemapMode, satelliteUrl, satelliteAttribution, lightBasemap }) {
  if (basemapMode === 'satellite') {
    return {
      ...EMPTY_STYLE,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [satelliteUrl],
          tileSize: 256,
          attribution: satelliteAttribution,
        },
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    };
  }

  return {
    ...EMPTY_STYLE,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [lightBasemap.baseUrl],
        tileSize: 256,
        attribution: lightBasemap.attribution,
      },
      'basemap-reference': {
        type: 'raster',
        tiles: [lightBasemap.referenceUrl],
        tileSize: 256,
      },
    },
    layers: [
      { id: 'basemap', type: 'raster', source: 'basemap' },
      // Labels/roads ride above the base but below overlays.
      { id: 'basemap-reference', type: 'raster', source: 'basemap-reference' },
    ],
  };
}

/**
 * Terra Draw, wired to the map instance the same way geoman's controls were.
 *
 * Setup is async (the drawing libs are code-split), which makes teardown the
 * tricky part: under StrictMode the effect mounts, unmounts and remounts, so a
 * naive version starts a second TerraDraw on a map that already has the first
 * one's sources and throws `Source "td-polygon" already exists`. Cleanup
 * therefore both flags cancellation *and* waits on the in-flight import, so an
 * instance created after unmount is still torn down instead of leaking.
 */
function DrawingTools({ onCreate, enabled }) {
  const { current: mapRef } = useMap();
  const drawRef = useRef(null);
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;

  useEffect(() => {
    const mapInstance = mapRef?.getMap?.();
    if (!mapInstance) return undefined;

    let cancelled = false;
    let draw = null;

    const ready = (async () => {
      const {
        TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode,
        TerraDrawCircleMode, TerraDrawSelectMode,
      } = await import('terra-draw');
      const { TerraDrawMapLibreGLAdapter } = await import('terra-draw-maplibre-gl-adapter');

      if (cancelled) return;

      draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: mapInstance, lib: maplibregl }),
        modes: [
          new TerraDrawPolygonMode(),
          new TerraDrawRectangleMode(),
          new TerraDrawCircleMode(),
          new TerraDrawSelectMode({
            flags: {
              polygon: { feature: { draggable: true, coordinates: { draggable: true, deletable: true } } },
              rectangle: { feature: { draggable: true } },
              circle: { feature: { draggable: true } },
            },
          }),
        ],
      });
      draw.start();
      draw.on('finish', (id) => {
        const feature = draw.getSnapshot().find((f) => f.id === id);
        if (feature && onCreateRef.current) onCreateRef.current(feature);
      });
      drawRef.current = draw;
    })();

    return () => {
      cancelled = true;
      ready.finally(() => {
        if (draw) {
          try {
            draw.stop();
          } catch {
            // stop() throws if the map/style was already torn down underneath
            // it; nothing left to clean up in that case.
          }
        }
        if (drawRef.current === draw) drawRef.current = null;
      });
    };
  }, [mapRef]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.setMode(enabled ? 'select' : 'static');
  }, [enabled]);

  return null;
}

/**
 * Paint shared by both overlay kinds.
 *
 * raster-fade-duration is 0 deliberately. The cross-fade binds the *parent*
 * tile's texture while a tile loads, and a parent that has been evicted from the
 * cache has none -- MapLibre then throws "Cannot read properties of undefined
 * (reading 'bind')" out of its render loop. Tiles served by an async protocol
 * (COG range reads, or the fetch-plus-worker tint) arrive slowly and out of
 * order, which is what makes that window wide enough to hit. These are
 * semi-transparent data overlays, so the fade bought us nothing anyway.
 */
const RASTER_PAINT = (opacity) => ({
  'raster-opacity': opacity,
  'raster-resampling': 'nearest',
  'raster-fade-duration': 0,
});

/**
 * MapLibre replacement for the Leaflet <MapContainer> stack.
 *
 * Renders raster overlays two ways during the migration: `rasterLayers` keeps the
 * existing PNG pyramids working unchanged, while `cogLayers` reads COGs directly.
 * Both can be on at once, which is what makes it possible to cut over one module
 * at a time and compare them on the same screen instead of trusting a swap.
 */
function MapLibreMap({
  center,
  zoom,
  minZoom,
  maxZoom,
  basemapMode,
  satelliteUrl,
  satelliteAttribution,
  lightBasemap,
  regionsData = null,
  rasterLayers = [],
  cogLayers = [],
  rasterOpacity = 0.5,
  onShapeCreate = null,
  drawingEnabled = false,
  onMapReady = null,
  mapRef = null,
}) {
  ensureCogProtocol();
  ensureTintedProtocol();

  const mapStyle = useMemo(
    () => buildBasemapStyle({ basemapMode, satelliteUrl, satelliteAttribution, lightBasemap }),
    [basemapMode, satelliteUrl, satelliteAttribution, lightBasemap],
  );

  // Class colors are applied by a per-pixel function keyed on the COG's URL, so
  // it has to be registered before MapLibre requests the first tile -- hence
  // useMemo during render rather than an effect after it. Without this the
  // protocol falls back to raw band values (0-5) and the layer paints as
  // near-black rather than the class palette.
  //
  // The layer's own color overrides the class palette for the clearcut class:
  // accumulated and annual are the same class ID in different rasters, so the
  // taxonomy color alone would paint both the same and make the two layers
  // indistinguishable when stacked. Falls back to the palette when a layer
  // declares no color.
  const cogSignature = cogLayers.map((l) => `${l.url}:${l.color || ''}`).join('|');
  useMemo(() => {
    cogLayers.forEach((layer) => {
      const visibleClasses = layer.visibleClasses || DEFAULT_VISIBLE_CLASSES;
      const overrides = layer.color ? { [CLEARCUT_CLASS_ID]: layer.color } : {};
      setColorFunction(
        layer.url,
        buildClassColorFunction(visibleClasses, 255, overrides),
      );
    });
    // cogSignature stands in for the layer list: the array identity changes on
    // every render, but the registration only needs redoing when a URL or color does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cogSignature]);

  const handleLoad = useCallback((e) => {
    if (mapRef) mapRef.current = e.target;
    if (onMapReady) onMapReady(e.target);
  }, [mapRef, onMapReady]);

  return (
    <Map
      initialViewState={{ longitude: center[1], latitude: center[0], zoom }}
      minZoom={minZoom}
      maxZoom={maxZoom}
      mapStyle={mapStyle}
      style={{ width: '100%', height: '100%' }}
      onLoad={handleLoad}
      attributionControl={{ compact: true }}
    >
      <NavigationControl position="bottom-left" showCompass={false} />

      {regionsData && (
        <Source id="regions" type="geojson" data={regionsData}>
          <Layer
            id="regions-fill"
            type="fill"
            paint={{ 'fill-color': '#1baf7a', 'fill-opacity': 0.05 }}
          />
          <Layer
            id="regions-outline"
            type="line"
            paint={{
              'line-color': basemapMode === 'satellite' ? '#ffffff' : '#333333',
              'line-width': 1.5,
            }}
          />
        </Source>
      )}

      {rasterLayers.map((layer) => (
        <Source
          key={layer.id}
          id={`raster-${layer.id}`}
          type="raster"
          tiles={[layer.tileUrl]}
          tileSize={256}
          scheme={layer.tms ? 'tms' : 'xyz'}
          minzoom={layer.minZoom ?? 6}
          maxzoom={layer.maxZoom ?? 14}
        >
          <Layer
            id={`raster-layer-${layer.id}`}
            type="raster"
            paint={RASTER_PAINT(rasterOpacity)}
          />
        </Source>
      ))}

      {cogLayers.map((layer) => (
        <Source
          key={layer.id}
          id={`cog-${layer.id}`}
          type="raster"
          url={`cog://${layer.url}`}
          tileSize={256}
        >
          <Layer
            id={`cog-layer-${layer.id}`}
            type="raster"
            paint={RASTER_PAINT(rasterOpacity)}
          />
        </Source>
      ))}

      {onShapeCreate && <DrawingTools onCreate={onShapeCreate} enabled={drawingEnabled} />}
    </Map>
  );
}

export default MapLibreMap;
