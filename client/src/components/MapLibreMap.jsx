import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
// Modes offered in the toolbar, in the order they appear. Labels carry a
// monochrome glyph rather than an emoji so the stack reads as one control
// surface -- the coloured axe on the Sources pill is deliberately the odd one
// out, because that button does something categorically different.
const DRAW_MODES = [
  { id: 'select', glyph: '\u2196', label: 'Select' },
  // A pin is the cheapest thing a user can mean by "here", and until now the
  // toolbar had no way to say it -- every question about a location required
  // enclosing it in an area first.
  { id: 'point', glyph: '\u2022', label: 'Pin' },
  { id: 'rectangle', glyph: '\u25AD', label: 'Rectangle' },
  { id: 'polygon', glyph: '\u2B20', label: 'Polygon' },
  { id: 'circle', glyph: '\u25EF', label: 'Circle' },
];

function DrawingTools({ onCreate, onChange, onAsk, proposedFeatures, enabled }) {
  const { current: mapRef } = useMap();
  const drawRef = useRef(null);
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Drives the Ask button's presence. Kept locally rather than read from the
  // parent's drawn-feature state so the button appears the instant a shape is
  // finished, without a round trip through App.
  const [shapeCount, setShapeCount] = useState(0);
  const [mode, setMode] = useState('select');
  // Set once terra-draw has started. The setup is async, so the mode effect
  // would otherwise run against a null instance on first render and never
  // re-run -- leaving the toolbar visually active but inert.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mapInstance = mapRef?.getMap?.();
    if (!mapInstance) return undefined;

    let cancelled = false;
    let draw = null;

    const started = (async () => {
      const {
        TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode,
        TerraDrawCircleMode, TerraDrawSelectMode, TerraDrawRenderMode,
        TerraDrawPointMode,
      } = await import('terra-draw');
      const { TerraDrawMapLibreGLAdapter } = await import('terra-draw-maplibre-gl-adapter');

      if (cancelled) return;

      // The adapter registers its render layers into the map's style, so
      // starting before the style exists leaves terra-draw storing features it
      // can never paint -- a shape completes, fires 'finish', and stays
      // invisible. Nothing throws, which is what makes it confusing.
      if (!mapInstance.isStyleLoaded()) {
        await new Promise((resolve) => {
          const done = () => {
            if (mapInstance.isStyleLoaded()) {
              mapInstance.off('styledata', done);
              resolve();
            }
          };
          // 'load' never re-fires once it has fired, so a style that is still
          // settling after a basemap swap needs 'styledata' as well.
          mapInstance.once('load', done);
          mapInstance.on('styledata', done);
          done();
        });
      }

      if (cancelled) return;

      draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: mapInstance, lib: maplibregl }),
        modes: [
          new TerraDrawPointMode(),
          new TerraDrawPolygonMode(),
          new TerraDrawRectangleMode(),
          new TerraDrawCircleMode(),
          // Display-only mode for geometry the assistant proposed. Render mode
          // rather than a drawing mode on purpose: these features cannot be
          // selected, dragged or edited, so a proposal can never be mistaken
          // for something the user drew -- and amber keeps them visually
          // separate from the user's own shapes.
          new TerraDrawRenderMode({
            modeName: 'ai',
            styles: {
              polygonFillColor: '#f59e0b',
              polygonFillOpacity: 0.18,
              polygonOutlineColor: '#f59e0b',
              polygonOutlineWidth: 2,
            },
          }),
          new TerraDrawSelectMode({
            flags: {
              point: { feature: { draggable: true } },
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
      // 'change' rather than 'finish' for the snapshot: finish fires only on
      // completing a shape, so edits, deletions and Clear would leave whatever
      // consumes this holding stale geometry.
      draw.on('change', () => {
        // The assistant's own proposals live in the same store, so they have to
        // be filtered out here: publishing them would feed them back as shapes
        // the user drew, and the next question would carry the model's guess
        // back to the model as if it were the user's area of interest.
        const userShapes = draw.getSnapshot().filter((f) => f.properties?.mode !== 'ai');
        setShapeCount(userShapes.length);
        if (onChangeRef.current) onChangeRef.current(userShapes);
      });
      drawRef.current = draw;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      setReady(false);
      started.finally(() => {
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
    if (!draw || !ready) return;
    // 'static' is terra-draw's inert mode -- the instance stays alive so any
    // drawn features survive the toggle, it just stops responding to the map.
    try {
      draw.setMode(enabled ? mode : 'static');
    } catch (err) {
      // setMode throws for an unregistered mode, and throwing from an effect
      // takes the whole render down. That happens routinely under hot reload:
      // the instance is built once per map (deps are [mapRef]), so editing the
      // mode list swaps in a toolbar offering modes the live instance has never
      // heard of. A reload fixes it; crashing over it does not.
      console.warn(`[MapLibreMap] mode "${mode}" unavailable — reload if you just edited the mode list`, err);
    }
  }, [enabled, mode, ready]);

  // Mirror the assistant's proposals into the store. Replaced wholesale on each
  // change rather than appended, so a new answer supersedes the last one instead
  // of layering proposals the user never asked to keep.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !ready) return;

    const existing = draw.getSnapshot()
      .filter((f) => f.properties?.mode === 'ai')
      .map((f) => f.id);
    if (existing.length) draw.removeFeatures(existing);

    if (!proposedFeatures?.length) return;
    try {
      // addFeatures reports per-feature validation rather than throwing, so
      // ignoring the return is how a proposal ends up counted in the transcript
      // but absent from the map.
      const results = draw.addFeatures(proposedFeatures) || [];
      const failed = results.filter((r) => r && r.valid === false);
      if (failed.length) {
        console.warn(
          `[MapLibreMap] terra-draw rejected ${failed.length}/${proposedFeatures.length} proposed features:`,
          failed.map((r) => r.reason || r),
        );
      }
    } catch (err) {
      console.warn('[MapLibreMap] could not add proposed features', err);
    }
  }, [proposedFeatures, ready]);

  const clearAll = useCallback(() => {
    const draw = drawRef.current;
    if (!draw) return;
    // Clears the user's shapes and the assistant's proposals alike -- "Clear"
    // meaning "everything drawn" is what the button looks like it does.
    draw.clear();
    setShapeCount(0);
    // clear() empties the store without emitting 'change', so the snapshot has
    // to be pushed by hand or consumers keep the shapes that were just removed.
    if (onChangeRef.current) onChangeRef.current([]);
  }, []);

  if (!enabled) return null;

  return (
    <div className="map-draw-tools">
      {DRAW_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`map-draw-btn${mode === m.id ? ' map-draw-btn--active' : ''}`}
          aria-pressed={mode === m.id}
          title={m.label}
          onClick={() => setMode(m.id)}
        >
          <span className="map-draw-glyph" aria-hidden="true">{m.glyph}</span>
          <span className="map-draw-label">{m.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="map-draw-btn map-draw-btn--danger"
        title="Remove all drawn shapes"
        onClick={clearAll}
      >
        <span className="map-draw-glyph" aria-hidden="true">{'\u2715'}</span>
        <span className="map-draw-label">Clear</span>
      </button>

      {/* Only once there is something to ask about. A permanently-visible button
          that does nothing until you draw would be worse than absent: it invites
          a click that silently fails. Rendered last so it sits closest to where
          the eye lands after finishing a shape. */}
      {shapeCount > 0 && onAsk && (
        <button
          type="button"
          className="map-draw-btn map-draw-btn--ask map-draw-btn--wide"
          title="Ask the Forestry AI Agent about this area"
          onClick={onAsk}
        >
          <span className="map-draw-glyph" aria-hidden="true">{'\u2728'}</span>
          <span className="map-draw-label">Ask AI</span>
        </button>
      )}
    </div>
  );
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
  onDrawChange = null,
  onAskAboutDrawing = null,
  proposedFeatures = null,
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
    // Dev-only handle. Two rendering faults in a row have come down to "is the
    // layer there at all", which is one console line to answer with the map in
    // hand and guesswork without it. Stripped from production builds.
    if (process.env.NODE_ENV !== 'production') window.__foresttraceMap = e.target;
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

      <DrawingTools
        onCreate={onShapeCreate}
        onChange={onDrawChange}
        onAsk={onAskAboutDrawing}
        proposedFeatures={proposedFeatures}
        enabled={drawingEnabled}
      />
    </Map>
  );
}

export default MapLibreMap;
