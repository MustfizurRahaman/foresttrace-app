import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, useMap, GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

import TopMenu from './components/TopMenu';
import ModuleSelector from './components/ModuleSelector';
import ModulePanel from './components/ModulePanel';
import FMUSelector from './components/FMUSelector';
import MobileWarning from './components/MobileWarning';
import LandingPage from './components/LandingPage';
import AboutPage from './pages/AboutPage';
import HelpPage from './pages/HelpPage';
import NewsPage from './pages/NewsPage';
import PublicationPage from './pages/PublicationPage';
import DocumentationPage from './pages/DocumentationPage';
import MapSourcesInfo from './components/MapSourcesInfo';
import MapTimeline from './components/MapTimeline';
import ClearcutDetection from './modules/ClearcutDetection';
import BiomassModule from './modules/BiomassModule';
import WildfireModule from './modules/WildfireModule';
import CaribouHabitatModule from './modules/CaribouHabitatModule';
import RasterTileLayer from './components/RasterTileLayer';
import { handleLocateUser } from './utils/mapUtils';
import { CLEARCUT_SENSOR_SUBFOLDER_YEARS, DEFAULT_CLEARCUT_SENSOR, getRegionsWithClearcutData } from './utils/clearcutAreaStats';
import { createEmptyBiomassHistogram } from './utils/biomassHistogram';
import { getFireYearsForRegions } from './utils/wildfireYears';
import { WILDFIRE_CLASSES, WILDFIRE_CLASS_ID, WILDFIRE_VISIBLE_CLASSES } from './utils/wildfireClasses';
import { CARIBOU_CLASSES, CARIBOU_VISIBLE_CLASSES } from './utils/caribouClasses';
import { getFmusForRanges, rangeColor, CARIBOU_RANGES } from './utils/caribouStats';
import {
  TILES_BASE_URL, DATA_BASE_URL,
  cogPrefixForLayer, coveragePrefixForLayer, cogUrlForPrefix,
} from './config';
import useRegionBoundaries from './hooks/useRegionBoundaries';
import { TINTED_LAYER_IDS, tintedTileUrl } from './utils/tintedTileProtocol';
import { summarizeDrawing } from './utils/drawnShapeContext';
import { getCogCoverage, getTileCoverage } from './utils/clearcutCogCoverage';

import './styles/map.css';
import './styles/topmenu.css';
import './styles/menu.css';
import './styles/layout.css';

// maplibre-gl is ~400 kB gzipped -- as a static import it landed in the main
// bundle for every visitor even with USE_MAPLIBRE off. Lazy so the cost is paid
// only when the MapLibre renderer is actually switched on.
const MapLibreMap = React.lazy(() => import('./components/MapLibreMap'));

// Sentinel-2 cloudless annual composites (EOX IT Services GmbH).
// Free for non-commercial use; tiles.maps.eox.at serves 2018–2024.
// Years outside this range fall back to the static Esri World Imagery layer.
const EOX_S2_YEARS = new Set([2018, 2019, 2020, 2021, 2022, 2023, 2024]);

function getBasemapConfig(year) {
  if (EOX_S2_YEARS.has(year)) {
    return {
      url: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`,
      attribution: `Sentinel-2 cloudless ${year} &copy; <a href="https://eox.at">EOX IT Services GmbH</a>`,
    };
  }
  return {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, DigitalGlobe, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, and others',
  };
}

// Neutral basemap: gray canvas + boundaries/labels only, no imagery. Esri's
// "Light Gray Canvas" style is two stacked layers — a plain gray base and a
// reference layer carrying admin boundaries, place names, and city labels.
const LIGHT_BASEMAP = {
  baseUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  referenceUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  attribution: '&copy; Esri, HERE, Garmin, FAO, NOAA, USGS',
};

function isBasemapSynced(year) {
  if (EOX_S2_YEARS.has(year)) return true;
  // 2025 uses Esri "current" imagery which is close enough to the detection year
  // that a warning would be misleading.
  if (year >= 2025) return true;
  return false;
}

// The directory a layer's tiles live under: /tiles/<dir>/{region}_{year}/...
// Read from the URL template rather than hardcoded, so a new layer needs no
// second registration to be covered by the availability manifest.
function tileDirOf(tileUrl) {
  return tileUrl?.match(/\/tiles\/([^/]+)\//)?.[1] ?? null;
}

const center = [49.80318325874751, -92.8087780822145];

// Renders the MapLibre map instead of the Leaflet one. Off by default: the
// MapLibre path is still being brought to parity (stats tallying, biomass
// histograms and the wildfire layers still run through <RasterTileLayer>), so
// the Leaflet map stays the shipping one until those land.
//   REACT_APP_USE_MAPLIBRE=true npm start
const USE_MAPLIBRE = process.env.REACT_APP_USE_MAPLIBRE === 'true';

// Serve COG-backed layers from COGs rather than PNG pyramids. Independent of the
// renderer flag so the two can be evaluated separately -- though COGs only render
// on MapLibre, so this does nothing while USE_MAPLIBRE is off.
//
// Which layers this covers is data, not a list here: cogPrefixForLayer() returns
// null for any layer with no entry in COG_PREFIX_BY_LAYER, and those fall back to
// tiles. The env var keeps its original name so existing setups are unaffected.
const USE_COG = process.env.REACT_APP_USE_COG_CLEARCUT === 'true';
const TILE_ZOOM_LEVELS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const TILE_ZOOM_RANGE = {
  min: Math.min(...TILE_ZOOM_LEVELS),
  max: Math.max(...TILE_ZOOM_LEVELS),
};

// Esri's Light Gray Canvas cache stops at level 16 — deeper requests just
// re-serve the same overzoomed level-16 tile, so cap zoom there in light mode.
const LIGHT_BASEMAP_MAX_ZOOM = 16;
// One pyramid per range-year, built by caribou_tiling/code/caribou_tiler_range.py
// and served from disk via setupProxy (CARIBOU_RANGE_TILES_DIR) until it is
// uploaded. Opt-in, because a checkout without those tiles would otherwise ask
// for a pyramid that is not there.
//
// Worth the switch on two counts. One layer per range instead of one per FMU
// (a range spans 5-7 of them, all seven span 25). And an FMU pyramid holds
// every range overlapping that FMU -- troutlake carries Berens, Churchill and
// Sydney -- so selecting one range through FMU tiles also draws the others.
// A range pyramid holds that range alone.
const CARIBOU_RANGE_TILES = process.env.REACT_APP_CARIBOU_RANGE_TILES === 'true';
const CARIBOU_RANGE_TILE_URL = `${TILES_BASE_URL}/tiles/wildlife/caribou-range/{region}_{year}/{z}/{x}/{y}.png`;

// How far the viewport may zoom out, which is NOT where the tile pyramid starts.
// The two were the same value, so the map was pinned to the tiles' floor of z6 --
// too close to fit Ontario, which spans ~15 degrees of latitude and needs about
// z4. Below z6 the raster overlays simply stop drawing (their sources declare
// minzoom 6); the basemap and FMU boundaries still do, which is what makes a
// province-wide view worth having.
const MAP_MIN_ZOOM = 4;
const RASTER_MULTI_FMU_SOFT_LIMIT = 8;
// Caribou range mode gets a higher ceiling than the general one above. That
// limit exists to contain the per-tile recolouring in RasterTileLayer, and
// habitat tiles are pre-coloured -- they return early out of that path
// entirely. All seven ranges together are 25 FMUs, so this admits every
// combination rather than silently dropping layers mid-range.
const RASTER_RANGE_MODE_LIMIT = 25;
const PREFERRED_RASTER_REGIONS = ['wabigoon', 'troutlake'];

const MODULES = [
  {
    id: 'clearcut',
    name: 'Clearcut Detection',
    icon: '🪓',
    description: 'Detect and analyze clearcut areas',
    component: ClearcutDetection,
    temporalOptions: {
      yearRange: [2010, 2025],
      availableYears: [2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    },
    layers: [
      {
        id: 'clearcut-accumulated',
        name: 'Accumulated Clearcuts',
        tileUrl: `${TILES_BASE_URL}/tiles/clearcut/{region}_{year}/{z}/{x}/{y}.png`,
        color: '#FF0000',
        mode: 'accumulated',
        tms: false,
      },
      {
        id: 'clearcut-annual',
        name: 'Annual Clearcuts',
        tileUrl: `${TILES_BASE_URL}/tiles/clearcut-annual/{region}_{year}/{z}/{x}/{y}.png`,
        color: '#FFD700',
        mode: 'annual',
        tms: false,
      },
    ],
  },
  {
    id: 'biomass',
    name: 'Biomass',
    icon: '🌿',
    description: 'Biomass density visualization',
    component: BiomassModule,
    temporalOptions: {
      yearRange: [2010, 2010],
    },
    layers: [
      {
        id: 'biomass-density',
        name: 'Biomass Density',
        tileUrl: `${TILES_BASE_URL}/tiles/biomass/{region}_{year}_agb/{z}/{x}/{y}.png`,
        mode: 'annual',
        tms: false,
      },
    ],
  },
  {
    id: 'wildfire',
    name: 'Wildfire',
    icon: '🔥',
    description: 'Burned area mapping from NBAC',
    component: WildfireModule,
    temporalOptions: {
      yearRange: [2010, 2025],
      availableYears: [
        2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017,
        2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
      ],
    },
    layers: [
      {
        id: 'wildfire-burned',
        name: 'Burned Area',
        tileUrl: `${TILES_BASE_URL}/tiles/wildfire/{region}_{year}/{z}/{x}/{y}.png`,
        color: '#F8420B',
        mode: 'annual',
        tms: false,
        // Wildfire carries its own class table rather than borrowing clearcut's:
        // the rasteriser writes 1 for burned, 0 for nodata. All three unset for
        // clearcut, which falls back to its own palette and class 2.
        cogPalette: WILDFIRE_CLASSES,
        cogClasses: WILDFIRE_VISIBLE_CLASSES,
        cogColorClass: WILDFIRE_CLASS_ID,
      },
    ],
  },
  {
    id: 'forest',
    name: 'Forest',
    icon: '🌲',
    description: 'Forest type and age classification',
    component: ClearcutDetection,
    temporalOptions: {
      yearRange: [2010, 2025],
    },
    layers: [
      {
        id: 'forest-mature',
        name: 'Mature Forest',
        tileUrl: `${TILES_BASE_URL}/tiles/{year}/{z}/{x}/forest_mature_{y}.png`,
        color: '#1B4D1B',
        mode: 'annual',
      },
      {
        id: 'forest-young',
        name: 'Young Forest',
        tileUrl: `${TILES_BASE_URL}/tiles/{year}/{z}/{x}/forest_young_{y}.png`,
        color: '#66BB6A',
        mode: 'annual',
      },
    ],
  },
  {
    id: 'wildlife',
    name: 'Wildlife & Species',
    icon: '🐦',
    description: 'Species habitat and distribution',
    component: CaribouHabitatModule,
    temporalOptions: {
      // Caribou habitat (MSPA) is the only layer here with tiles behind it; the
      // bird/mammal entries below are still placeholders. availableYears drives
      // the slider by index so it snaps to assessed years.
      //
      // Year-over-year change is small by nature -- disturbance is cumulative,
      // so each year only ADDS to an existing footprint (0.01-1.35% of pixels
      // per step). The full span is where it reads: -12.9% core on troutlake.
      // 2023-2025 is nearly flat because the input disturbance layers do not
      // appear to extend past 2023.
      yearRange: [2015, 2025],
      availableYears: [2015, 2016, 2017, 2018, 2019, 2020,
        2021, 2022, 2023, 2024, 2025],
    },
    layers: [
      {
        id: 'caribou-habitat',
        name: 'Caribou Habitat',
        // Headline for the right panel while this layer is on. The Wildlife
        // module hosts several species, so the panel names the species rather
        // than the module. The left-hand module selector is untouched.
        panelTitle: 'Caribou Suitable Habitat',
        panelIcon: '🦌',
        // tiles/wildlife/{specie}/... so the module can host more species
        // without each one claiming a top-level prefix.
        tileUrl: `${TILES_BASE_URL}/tiles/wildlife/caribou/{region}_{year}/{z}/{x}/{y}.png`,
        // Mid-viridis: a single swatch standing in for the 5-class ramp.
        color: '#21918C',
        mode: 'annual',
        tms: false,
        // Caribou's own size-class table. cogColorClass is explicitly null: the
        // five-step ramp IS the information, so repainting one class in the
        // layer's colour would destroy the reading. `color` above is the panel
        // swatch, not the raster.
        cogPalette: CARIBOU_CLASSES,
        cogClasses: CARIBOU_VISIBLE_CLASSES,
        cogColorClass: null,
        // Both caribou products are complete -- 77 range COGs and 220 FMU COGs
        // cover every region that has habitat at all -- so a region-year absent
        // from coverage has no data rather than no conversion. Without this the
        // 19 FMUs outside the caribou range fell back to a PNG pyramid that does
        // not cover them either, and fetched a tree of 404s per region.
        cogAuthoritative: true,
      },
      {
        id: 'wildlife-birds',
        name: 'Bird Species',
        tileUrl: `${TILES_BASE_URL}/tiles/{year}/{z}/{x}/wildlife_birds_{y}.png`,
        color: '#FFD700',
        mode: 'annual',
      },
      {
        id: 'wildlife-mammals',
        name: 'Mammals',
        tileUrl: `${TILES_BASE_URL}/tiles/{year}/{z}/{x}/wildlife_mammals_{y}.png`,
        color: '#8B4513',
        mode: 'annual',
      },
    ],
  },
];

function DrawingTools({ mapRef, onDrawChange }) {
  const map = useMap();
  mapRef.current = map;
  const onDrawChangeRef = useRef(onDrawChange);
  onDrawChangeRef.current = onDrawChange;

  useEffect(() => {
    map.pm.addControls({
      position: 'bottomleft',
      drawPolygon: true,
      drawCircle: true,
      drawRectangle: true,
      editMode: true,
      dragMode: false,
      cutPolygon: false,
      removalMode: true,
    });

    // Re-read every geoman layer on any change rather than tracking a diff:
    // geoman fires create/remove/edit through several different events, and a
    // shape edited or deleted through the toolbar would otherwise leave a stale
    // copy behind. The layer count here is single digits, so re-reading is free.
    const publish = () => {
      if (!onDrawChangeRef.current) return;
      const features = map.pm.getGeomanLayers()
        .map((layer) => (layer.toGeoJSON ? layer.toGeoJSON() : null))
        .filter(Boolean);
      onDrawChangeRef.current(features);
    };

    // pm:create fires before the layer joins the map's geoman registry, so
    // publishing synchronously would miss the shape just drawn.
    const onCreate = () => setTimeout(publish, 0);

    map.on('pm:create', onCreate);
    map.on('pm:remove', publish);
    map.on('pm:cut', publish);
    map.on('pm:edit', publish);

    return () => {
      map.off('pm:create', onCreate);
      map.off('pm:remove', publish);
      map.off('pm:cut', publish);
      map.off('pm:edit', publish);
      map.pm.removeControls();
    };
  }, [map]);

  return null;
}

// Caribou population ranges (OMNR). Only the seven the pipeline models are in
// the file, so the overlay never implies coverage that does not exist. Each
// feature carries its own colour, so the map and the panel legend read from one
// source and cannot drift.
function CaribouRangeBoundaries({ visible, selectedRanges }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    // Fetch once, on first reveal -- 166 KB that most sessions never need.
    if (!visible || data) return undefined;
    let cancelled = false;
    fetch(`${DATA_BASE_URL}/data/caribou_ranges.geojson`)
      .then((r) => {
        if (!r.ok) throw new Error(`caribou_ranges.geojson: HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => console.error('[CaribouRanges]', err));
    return () => { cancelled = true; };
  }, [visible, data]);

  const onEachFeature = useCallback((feature, layer) => {
    layer.options.pmIgnore = true;
    // CARIBOU_RANGES wins over the geojson's own `color`, so restyling does not
    // mean regenerating the file.
    const colour = rangeColor(feature.properties?.RANGE_NAME)
      || feature.properties?.color || '#333333';
    layer.setStyle({
      color: colour,
      weight: 2,
      opacity: 1,
      // Outline only, matching RegionBoundaries. Leaflet draws vectors in
      // overlayPane, always above tilePane, so any fill here would tint the
      // habitat raster it is meant to annotate.
      fillOpacity: 0,
    });
    if (feature.properties?.RANGE_NAME) {
      layer.bindTooltip(feature.properties.RANGE_NAME, { sticky: true });
    }
  }, []);

  // With ranges selected, outline only those — otherwise the switches say one
  // range is on while the map still draws all seven.
  const shown = useMemo(() => {
    if (!data) return null;
    if (!selectedRanges || selectedRanges.length === 0) return data;
    const wanted = new Set(selectedRanges.map((r) => String(r).toLowerCase()));
    return {
      ...data,
      features: (data.features || []).filter(
        (f) => wanted.has(String(f.properties?.RANGE_NAME || '').toLowerCase()),
      ),
    };
  }, [data, selectedRanges]);

  if (!visible || !shown) return null;
  // Keyed on the selection so Leaflet rebuilds the layer when it changes;
  // react-leaflet does not diff GeoJSON data in place.
  return (
    <GeoJSON
      key={`caribou-ranges-${(selectedRanges || []).join('-') || 'all'}`}
      data={shown}
      onEachFeature={onEachFeature}
    />
  );
}

/**
 * The same range outlines as a plain FeatureCollection, for the MapLibre map.
 *
 * CaribouRangeBoundaries above is a Leaflet component -- setStyle, bindTooltip,
 * pmIgnore -- so it renders only inside <MapContainer>. With USE_MAPLIBRE on it
 * never mounted at all, which is why selecting a range drew habitat with no
 * boundary around it.
 *
 * MapLibre has no per-feature style callback, so the colour is resolved here and
 * written onto each feature for a data-driven paint expression to read.
 */
function useCaribouRangeGeoJson(selectedRanges) {
  const [data, setData] = useState(null);
  const wanted = (selectedRanges || []).length > 0;

  useEffect(() => {
    // Fetch once, on first reveal -- 166 KB that most sessions never need.
    if (!wanted || data) return undefined;
    let cancelled = false;
    fetch(`${DATA_BASE_URL}/data/caribou_ranges.geojson`)
      .then((r) => {
        if (!r.ok) throw new Error(`caribou_ranges.geojson: HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => console.error('[CaribouRanges]', err));
    return () => { cancelled = true; };
  }, [wanted, data]);

  return useMemo(() => {
    if (!data || !wanted) return null;
    const ids = new Set(selectedRanges.map((r) => String(r).toLowerCase()));
    const features = (data.features || [])
      .filter((f) => ids.has(String(f.properties?.RANGE_NAME || '').toLowerCase()))
      .map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          // CARIBOU_RANGES wins over the geojson's own `color`, so restyling does
          // not mean regenerating the file -- same precedence as the Leaflet path.
          _lineColor: rangeColor(f.properties?.RANGE_NAME)
            || f.properties?.color || '#333333',
        },
      }));
    return { type: 'FeatureCollection', features };
  }, [data, wanted, selectedRanges]);
}

function RegionBoundaries({ selectedFMUs, useOntarioOverview, basemapMode }) {
  const regionsData = useRegionBoundaries(selectedFMUs, useOntarioOverview);

  const onEachFeature = useCallback((feature, layer) => {
    layer.options.pmIgnore = true;
    layer.setStyle({
      color: basemapMode === 'satellite' ? '#ffffff' : '#2f8f5b',
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0,
    });
  }, [basemapMode]);

  if (!regionsData) return null;

  const featureIds = regionsData.features.map((f) => f.properties?.id).sort().join('-');

  return <GeoJSON key={`${featureIds}-${basemapMode}`} data={regionsData} onEachFeature={onEachFeature} />;
}

function ZoomControlPositioner({ position = 'bottomleft' }) {
  const map = useMap();

  useEffect(() => {
    const zoomControl = L.control.zoom({ position });
    map.addControl(zoomControl);

    return () => {
      map.removeControl(zoomControl);
    };
  }, [map, position]);

  return null;
}

// MapContainer's maxZoom prop only applies at initial mount, so this keeps
// Leaflet's own max-zoom clamp in sync when the basemap (and its supported
// zoom range) changes after the map already exists.
function MaxZoomController({ maxZoom }) {
  const map = useMap();

  useEffect(() => {
    map.setMaxZoom(maxZoom);
    if (map.getZoom() > maxZoom) {
      map.setZoom(maxZoom);
    }
  }, [map, maxZoom]);

  return null;
}

function App() {
  const [showApp, setShowApp] = useState(false);
  const [activePage, setActivePage] = useState(null);
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [clearcutPercent, setClearcutPercent] = useState(null);
  const [tilesLoading, setTilesLoading] = useState(false);
  const hidingTimerRef = useRef(null);
  const showingTimerRef = useRef(null);
  // Shown only if the load is still running after a beat. Most tile loads finish
  // faster than that, and an indicator that flashes on every pan reads as the
  // map fighting you rather than as information.
  const LOADING_SHOW_DELAY_MS = 500;
  // Held briefly once shown. Tiles arrive in batches with brief lulls between
  // them, and a source reads as loaded during a lull -- so a short hide delay
  // made the indicator strobe through a long load and, worse, re-armed the
  // 500 ms show delay each time, hiding it for most of the load it was meant to
  // report. Longer than the gaps, short enough not to linger once done.
  const LOADING_HIDE_DELAY_MS = 900;
  // Which map sources are still fetching, so the status line can name them.
  // Leaflet's <RasterTileLayer> passes no ids and simply leaves this empty.
  const [loadingSourceIds, setLoadingSourceIds] = useState([]);
  // The undebounced signal. tilesLoading is delayed on both edges so the
  // indicator doesn't strobe, which is right for a human watching it and wrong
  // for playback pacing -- the delays would add well over a second to every
  // frame. Playback reads this instead.
  const [tilesBusy, setTilesBusy] = useState(false);
  const handleLoadingChange = useCallback((loading, sourceIds = []) => {
    setTilesBusy(loading);
    // Only update the label when there is something to name. Clearing it during
    // a lull would flip the status line to the generic wording and back.
    if (sourceIds.length > 0) setLoadingSourceIds(sourceIds);
    if (loading) {
      clearTimeout(hidingTimerRef.current);
      if (!showingTimerRef.current) {
        showingTimerRef.current = setTimeout(() => setTilesLoading(true), LOADING_SHOW_DELAY_MS);
      }
    } else {
      clearTimeout(showingTimerRef.current);
      showingTimerRef.current = null;
      hidingTimerRef.current = setTimeout(() => setTilesLoading(false), LOADING_HIDE_DELAY_MS);
    }
  }, []);
  const [biomassHistogram, setBiomassHistogram] = useState(createEmptyBiomassHistogram());
  const [rasterOpacity, setRasterOpacity] = useState(1);
  const [selectedModuleId, setSelectedModuleId] = useState(MODULES[0]?.id);
  const selectedModule = useMemo(
    () => MODULES.find((m) => m.id === selectedModuleId) ?? MODULES[0],
    [selectedModuleId],
  );
  const [selectedYear, setSelectedYear] = useState(MODULES[0]?.temporalOptions?.yearRange?.[1] || 2025);
  const [selectedFMUs, setSelectedFMUs] = useState(['wabigoon']);
  const [allowHeavyRaster, setAllowHeavyRaster] = useState(false);
  const [basemapMode, setBasemapMode] = useState('light'); // 'light' | 'satellite'

  // Disable overview mode for now because the current simplified overview geometry
  // introduces visible boundary artifacts at Ontario-wide scale.
  const useOntarioOverview = false;

  const shouldLimitRasterRegions = useMemo(() => {
    if (!Array.isArray(selectedFMUs) || selectedFMUs.length <= RASTER_MULTI_FMU_SOFT_LIMIT) {
      return false;
    }
    return !allowHeavyRaster;
  }, [selectedFMUs, allowHeavyRaster]);

  const prioritizedRasterRegions = useMemo(() => {
    if (!Array.isArray(selectedFMUs)) return [];

    const selectedSet = new Set(selectedFMUs);
    const preferred = PREFERRED_RASTER_REGIONS.filter((id) => selectedSet.has(id));
    const rest = selectedFMUs.filter((id) => !PREFERRED_RASTER_REGIONS.includes(id));

    return [...preferred, ...rest];
  }, [selectedFMUs]);

  const rasterRegions = useMemo(() => {
    if (!shouldLimitRasterRegions) {
      return prioritizedRasterRegions;
    }
    return prioritizedRasterRegions.slice(0, RASTER_MULTI_FMU_SOFT_LIMIT);
  }, [prioritizedRasterRegions, shouldLimitRasterRegions]);

  const clearcutStatsRegion = useMemo(() => (
    rasterRegions.length > 0 ? rasterRegions[0] : null
  ), [rasterRegions]);

  // Caribou range mode. Selecting ranges swaps the habitat layer's regions for
  // the FMUs carrying those ranges, so the layer follows range boundaries
  // instead of the FMU selection. Deliberately scoped to that one layer: per
  // issue #15 the range shape must not affect any other module.
  const [selectedRanges, setSelectedRanges] = useState([]);
  const [rangeRegions, setRangeRegions] = useState([]);

  useEffect(() => {
    if (selectedRanges.length === 0) {
      setRangeRegions([]);
      return undefined;
    }
    let cancelled = false;
    getFmusForRanges(selectedRanges)
      .then((fmus) => {
        if (!cancelled) setRangeRegions(fmus.slice(0, RASTER_RANGE_MODE_LIMIT));
      })
      .catch((err) => {
        console.error('[CaribouRanges]', err);
        if (!cancelled) setRangeRegions([]);
      });
    return () => { cancelled = true; };
  }, [selectedRanges]);

  const caribouRasterRegions = selectedRanges.length > 0 ? rangeRegions : rasterRegions;

  // Range outlines for the MapLibre map. The Leaflet branch has its own
  // component; this is the same data shaped for a geojson source.
  const caribouRangeGeoJson = useCaribouRangeGeoJson(selectedRanges);

  const handleToggleRange = useCallback((rangeId, on) => {
    setSelectedRanges((prev) => (
      on ? [...new Set([...prev, rangeId])] : prev.filter((r) => r !== rangeId)
    ));
  }, []);

  const handleToggleAllRanges = useCallback((on) => {
    setSelectedRanges(on ? CARIBOU_RANGES.map((r) => r.id) : []);
  }, []);

  const [moduleYears, setModuleYears] = useState(() => {
    const initial = {};
    MODULES.forEach((module) => {
      if (module.temporalOptions?.yearRange) {
        initial[module.id] = module.temporalOptions.yearRange[1];
      }
    });
    return initial;
  });

  const [activeLayers, setActiveLayers] = useState(() => {
    const initial = {};
    MODULES.forEach((module) => {
      initial[module.id] = module === MODULES[0] ? [module.layers[0].id] : [];
    });
    return initial;
  });

  const handleLayerToggle = (moduleId, layerId) => {
    setActiveLayers((prev) => {
      const current = prev[moduleId] || [];
      if (current.includes(layerId)) {
        return { ...prev, [moduleId]: current.filter((l) => l !== layerId) };
      }
      return { ...prev, [moduleId]: [...current, layerId] };
    });
  };

  // Safety net: if a layer unmounts mid-load (year change, layer toggle)
  // without firing its `load` event, the spinner would stay forever.
  // Auto-dismiss after 12 s as a fallback.
  useEffect(() => {
    if (!tilesLoading) return;
    const guard = setTimeout(() => setTilesLoading(false), 12000);
    return () => clearTimeout(guard);
  }, [tilesLoading]);

  // Which years the selected FMUs actually burned in. Wildfire coverage is
  // sparse — a region only has tiles for years something burned — so this
  // narrows the wildfire slider to those years, the same way the clearcut
  // module narrows its own with a static availableYears list. Years with no
  // data are skipped rather than flagged.
  const [fireYears, setFireYears] = useState([]);

  useEffect(() => {
    let cancelled = false;

    if (selectedFMUs.length === 0) {
      setFireYears([]);
      return undefined;
    }

    getFireYearsForRegions(selectedFMUs)
      .then((years) => {
        if (!cancelled) setFireYears(years);
      })
      .catch(() => {
        if (!cancelled) setFireYears([]);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFMUs]);

  // The wildfire slider stops only on years with data. Falls back to the
  // module's declared list when a region has no fires at all, so the slider
  // stays usable and the panel's "No fire recorded" message carries the point.
  const wildfireYearOptions = useMemo(() => {
    const declared = MODULES.find((m) => m.id === 'wildfire')?.temporalOptions?.availableYears;
    return fireYears.length > 0 ? fireYears : declared;
  }, [fireYears]);

  // Stops on the timeline: the union of every year any ACTIVE layer can show,
  // not just the selected module's. The control moves all of them, so it has to
  // offer every year one of them has -- otherwise switching modules would
  // silently change which years are reachable.
  const timelineYears = useMemo(() => {
    const expand = (module) => {
      if (module.id === 'wildfire') return wildfireYearOptions || [];
      const declared = module.temporalOptions?.availableYears;
      if (declared?.length) return declared;
      const range = module.temporalOptions?.yearRange;
      if (!range || range.length !== 2) return [];
      const [from, to] = range;
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    };

    const years = new Set();
    MODULES.forEach((module) => {
      if (!(activeLayers[module.id] || []).length) return;
      expand(module).forEach((y) => years.add(y));
    });

    // Nothing switched on: fall back to the module in front, so the timeline
    // doesn't vanish while the user is deciding what to display.
    if (years.size === 0 && selectedModule) expand(selectedModule).forEach((y) => years.add(y));

    return [...years].sort((a, b) => a - b);
  }, [activeLayers, wildfireYearOptions, selectedModule]);

  // Changing FMU can drop the year currently being viewed out of the list.
  // Snap to the nearest available year, otherwise the slider handle and the
  // year label disagree.
  useEffect(() => {
    if (selectedModule?.id !== 'wildfire') return;
    if (!wildfireYearOptions?.length) return;
    if (wildfireYearOptions.includes(selectedYear)) return;

    const nearest = wildfireYearOptions.reduce((best, year) => (
      Math.abs(year - selectedYear) < Math.abs(best - selectedYear) ? year : best
    ), wildfireYearOptions[0]);

    setSelectedYear(nearest);
    setModuleYears((prev) => ({ ...prev, wildfire: nearest }));
  }, [wildfireYearOptions, selectedYear, selectedModule]);

  useEffect(() => {
    const handleOpacityChange = (e) => {
      setRasterOpacity(e.detail.opacity);
    };

    window.addEventListener('opacityChange', handleOpacityChange);
    return () => window.removeEventListener('opacityChange', handleOpacityChange);
  }, []);


  const mapMaxZoom = basemapMode === 'satellite' ? TILE_ZOOM_RANGE.max : LIGHT_BASEMAP_MAX_ZOOM;

  // Boundary GeoJSON for the MapLibre renderer. The Leaflet path fetches this
  // inside <RegionBoundaries>; both call the same hook, so the two render from
  // identical data.
  const maplibreRegions = useRegionBoundaries(selectedFMUs, useOntarioOverview);

  // Shapes the user has drawn, from whichever renderer is active. Held here
  // rather than inside either map so the AI agent sees the same thing on both.
  const [drawnFeatures, setDrawnFeatures] = useState([]);

  // Boundaries are only loaded by the hook on the MapLibre path; the Leaflet
  // <RegionBoundaries> calls the same hook, which caches, so this is the same
  // data either way and costs nothing extra.
  const drawingContext = useMemo(
    () => summarizeDrawing(drawnFeatures, maplibreRegions),
    [drawnFeatures, maplibreRegions],
  );

  // Which panel tab is showing. Lifted out of <ModuleSelector> so the map's
  // "Ask AI" button can bring the agent forward.
  const [panelTab, setPanelTab] = useState('modules');
  const [pendingPrompt, setPendingPrompt] = useState(null);
  // Geometry the assistant proposed. Kept apart from drawnFeatures so a
  // proposal never feeds back into the context as something the user drew.
  const [proposedFeatures, setProposedFeatures] = useState(null);

  const askAboutDrawing = useCallback(() => {
    setPanelTab('forest-ai');
    setPendingPrompt("What's in here?");
  }, []);

  // Flattens the module/layer/region matrix into plain source descriptors.
  // Mirrors the <RasterTileLayer> mapping in the Leaflet branch below -- kept as
  // data rather than components because MapLibre sources are declared by value.
  // Which region/years actually have a clearcut COG published. Only wabigoon
  // does today, so requesting one per selected region gave a 404 per region and
  // an AggregateError out of MapLibre's tile loader -- and drew nothing, rather
  // than falling back to the PNG pyramid that does exist for every region.
  // How many years ahead playback buffers.
  const PREFETCH_YEARS = 2;
  const [playing, setPlaying] = useState(false);

  // Coverage per COG prefix, not one shared set. Clearcut and wildfire are
  // separate products holding different region-years -- wabigoon has clearcut for
  // twelve years and fire for one -- so a single set would have each layer
  // answering for the other. A missing key means "not loaded yet".
  const [cogCoverageByPrefix, setCogCoverageByPrefix] = useState({});
  // Regions that have a clearcut product of any kind. null until known, and
  // treated the same way as unknown COG coverage: request nothing yet.
  const [clearcutRegions, setClearcutRegions] = useState(null);

  // Which PNG tile sets exist, keyed by the directory under /tiles/. Loaded for
  // every layer up front: it is one manifest fetch shared by all of them.
  const [tileCoverage, setTileCoverage] = useState({});

  useEffect(() => {
    let cancelled = false;
    const dirs = [...new Set(
      MODULES.flatMap((m) => (m.layers || []).map((l) => tileDirOf(l.tileUrl)).filter(Boolean)),
    )];
    Promise.all(dirs.map((dir) => getTileCoverage(dir).then((covered) => [dir, covered])))
      .then((entries) => {
        if (cancelled) return;
        setTileCoverage(Object.fromEntries(entries.filter(([, covered]) => covered)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRegionsWithClearcutData(DEFAULT_CLEARCUT_SENSOR)
      .then((regions) => { if (!cancelled) setClearcutRegions(regions); })
      // A failed stats fetch shouldn't blank the map -- fall back to asking for
      // everything, which is the old behaviour.
      .catch(() => { if (!cancelled) setClearcutRegions(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Ranges count as a selection even with no FMU chosen -- clearing coverage
    // on an empty rasterRegions left caribou range mode waiting on a set that
    // would never arrive, which reads as "coverage unknown" and draws nothing.
    if (!USE_MAPLIBRE || !USE_COG
        || (rasterRegions.length === 0 && selectedRanges.length === 0)) {
      setCogCoverageByPrefix({});
      return undefined;
    }
    let cancelled = false;

    // One request per active COG product, asking only about that product's own
    // module year. Probing every module's year multiplied the request count for
    // nothing. (Moot once the manifest is published -- this is the fallback.)
    const wanted = [];
    MODULES.forEach((module) => {
      (activeLayers[module.id] || []).forEach((layerId) => {
        const caribouRangeMode = layerId === 'caribou-habitat' && selectedRanges.length > 0;
        const prefix = coveragePrefixForLayer(layerId, { caribouRangeMode });
        if (!prefix || wanted.some((w) => w.prefix === prefix)) return;
        wanted.push({
          prefix,
          year: moduleYears[module.id] || selectedYear,
          // Caribou in range mode is keyed by range, everything else by FMU.
          // Only the HEAD-probe fallback reads this -- the manifest answers for
          // a whole prefix at once -- but probing FMU ids against a range-keyed
          // product would report the layer as having no coverage at all.
          regions: caribouRangeMode ? selectedRanges : rasterRegions,
        });
      });
    });

    Promise.all(wanted.map(({ prefix, year, regions }) => (
      getCogCoverage(regions.map((region) => ({ region, years: [year] })), prefix)
        .then((covered) => [prefix, covered])
    ))).then((entries) => {
      if (!cancelled) setCogCoverageByPrefix(Object.fromEntries(entries));
    });

    return () => { cancelled = true; };
  }, [rasterRegions, selectedRanges, activeLayers, moduleYears, selectedYear]);

  // Source id -> "Module / Layer". Ids are built below as
  // `<prefix>-<layerId>-<region>`, and layer ids themselves contain hyphens, so
  // this is a lookup rather than a parse.
  const layerLabelById = useMemo(() => {
    const labels = {};
    MODULES.forEach((module) => {
      module.layers?.forEach((layer) => {
        rasterRegions.forEach((region) => {
          const label = `${module.name} · ${layer.name}`;
          labels[`raster-${layer.id}-${region}`] = label;
          labels[`cog-${layer.id}-${region}`] = label;
        });
      });
    });
    return labels;
  }, [rasterRegions]);

  // Source ids carry a trailing year; the label is the same whichever year is
  // showing, so it is looked up without one.
  const labelForSourceId = useCallback(
    (id) => layerLabelById[id.replace(/-\d{4}$/, '')],
    [layerLabelById],
  );

  // One entry per layer, however many regions are still fetching for it: the
  // user asked which module is loading, not how the request fan-out went.
  const loadingLabel = useMemo(() => {
    const names = [...new Set(loadingSourceIds.map(labelForSourceId).filter(Boolean))];
    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    return `${names[0]} +${names.length - 1} more`;
  }, [loadingSourceIds, labelForSourceId]);

  const maplibreLayers = useMemo(() => {
    if (!USE_MAPLIBRE) return { rasterLayers: [], cogLayers: [] };

    const rasterLayers = [];
    const cogLayers = [];

    MODULES.forEach((module) => {
      (activeLayers[module.id] || []).forEach((layerId) => {
        const layer = module.layers?.find((l) => l.id === layerId);
        // Not `rasterRegions.length === 0`: caribou in range mode draws from the
        // selected ranges and needs no FMU selection at all, so that guard hid
        // the layer entirely when a range was toggled with no FMU chosen. The
        // per-layer region list below is the real emptiness check.
        if (!layer) return;

        const moduleYear = moduleYears[module.id] || selectedYear;

        // Caribou is the one layer whose unit is not the FMU. With ranges
        // selected it draws per RANGE, because an FMU pyramid carries every
        // range crossing it -- troutlake holds Berens, Churchill and Sydney, so
        // asking for Berens through FMU tiles drew all three. Mirrors the same
        // switch in the Leaflet branch below.
        const rangeMode = layer.id === 'caribou-habitat' && selectedRanges.length > 0;
        let layerRegions;
        if (rangeMode) {
          layerRegions = selectedRanges;
        } else if (layer.id === 'caribou-habitat') {
          layerRegions = caribouRasterRegions;
        } else {
          layerRegions = rasterRegions;
        }
        if (layerRegions.length === 0) return;

        // The current year, then the buffer. Buffered years are mounted at zero
        // opacity so MapLibre fetches their tiles for the current viewport
        // before they are needed; when the year advances the source it wants
        // already exists, loaded, instead of starting a fresh round of
        // requests. Only while playing -- doing this during ordinary browsing
        // would triple the requests for no benefit.
        const upcoming = playing
          ? timelineYears.slice(timelineYears.indexOf(moduleYear) + 1, timelineYears.indexOf(moduleYear) + 1 + PREFETCH_YEARS)
          : [];

        [moduleYear, ...upcoming].forEach((renderYear, frameIdx) => {
        const layerOpacity = frameIdx === 0 ? undefined : 0;

        layerRegions.forEach((region) => {
          // Which COG product this layer draws, and whose coverage answers for
          // it. Asking per prefix is what lets wildfire be gated by its own
          // availability rather than clearcut's -- the two hold different
          // region-years, so one shared set would have each hiding the other.
          //
          // Caribou resolves to a different prefix per mode -- range-keyed with
          // ranges selected, FMU-keyed otherwise -- so the mode has to travel
          // with the lookup. Testing FMU ids against range-keyed coverage would
          // match nothing and hide the layer.
          const cogOpts = { caribouRangeMode: rangeMode };
          const cogPrefix = USE_COG ? cogPrefixForLayer(layer.id, cogOpts) : null;
          const coverage = cogPrefix
            ? cogCoverageByPrefix[coveragePrefixForLayer(layer.id, cogOpts)]
            : undefined;

          // Hold off until coverage is known rather than rendering the PNG
          // meanwhile. Falling back eagerly meant every clearcut region fired a
          // full pyramid of tile requests on load, only to be replaced by the
          // COG a moment later once the manifest arrived -- the requests still
          // completed, so it was a burst of downloads for tiles nobody drew.
          // The manifest is a single small file, so the wait is brief.
          if (cogPrefix && coverage === undefined) return;

          // Skip regions with no clearcut product at all. lakehead_2025 has
          // neither a COG nor a tile pyramid, so the PNG fallback was issuing a
          // full request tree per region purely to collect 404s. Clearcut-only:
          // it is derived from clearcut_stats.json.
          if (cogPrefix && module.id === 'clearcut'
              && clearcutRegions && !clearcutRegions.has(region)) return;

          const hasCog = !!coverage && coverage.has(`${region}_${renderYear}`);
          // From the resolved prefix, not the layer id: caribou's id maps to two
          // different products depending on mode.
          const cogUrl = hasCog ? cogUrlForPrefix(cogPrefix, region, renderYear) : null;

          // A sparse COG layer with no raster for this region-year and no PNG to
          // fall back to has nothing to draw, and asking anyway is what produced
          // the 404s. Skip only when the manifest positively says the pyramid
          // lacks this region-year -- an unindexed directory means "unknown", not
          // "absent", and must fall through to the PNG path.
          //
          // tileDirOf() reads one path segment, so tiles/wildlife/caribou/ comes
          // back as `wildlife`, which the manifest never indexes: its tile scan
          // only sees <region>_<year> directly under tiles/<dir>/. Treating that
          // as "no pyramid" hid the caribou layer completely.
          const pngDir = tileDirOf(layer.tileUrl);
          const pngCoverage = pngDir ? tileCoverage[pngDir] : null;
          if (cogPrefix && !hasCog && !TINTED_LAYER_IDS.has(layer.id)
              && pngCoverage && !pngCoverage.has(`${region}_${renderYear}`)) return;

          // A layer whose COG product is complete needs no PNG fallback: absence
          // from coverage means "no data here", not "not converted yet". Caribou
          // says so because every FMU with habitat has a COG, and the 19 FMUs
          // without one are outside the caribou range entirely -- falling back
          // there fetched a full pyramid of 404s, since the PNG set does not
          // cover them either. Clearcut must NOT declare this: only wabigoon is
          // converted, and its fallback is load-bearing.
          if (cogPrefix && !hasCog && layer.cogAuthoritative) return;
          if (cogUrl) {
            // color carries the layer's identity, not the class's: accumulated and
            // annual are both class 2 in the raster, so without it they'd paint the
            // same and the two layers would be indistinguishable when stacked.
            cogLayers.push({
              id: `${layer.id}-${region}-${renderYear}`,
              url: cogUrl,
              color: layer.color,
              opacity: layerOpacity,
              // All undefined for clearcut, which falls back to its own palette
              // and class 2. Wildfire supplies its own table and paints class 1.
              palette: layer.cogPalette,
              visibleClasses: layer.cogClasses,
              colorClass: layer.cogColorClass,
            });
            return;
          }

          // Per region AND year: troutlake has clearcut tiles for 2020 and 2024
          // only, so a region-level check still asked for 2025.
          const tileDir = tileDirOf(layer.tileUrl);
          const covered = tileDir ? tileCoverage[tileDir] : null;
          if (covered && !covered.has(`${region}_${renderYear}`)) return;

          // In range mode `region` is a range id, and the per-range pyramid
          // spells its folders range_<id>_<year> -- the COGs use the bare id, so
          // only the PNG path needs the prefix. Behind CARIBOU_RANGE_TILES
          // because a checkout without those tiles would otherwise ask for a
          // pyramid that is not there.
          if (rangeMode && !CARIBOU_RANGE_TILES) return;
          const template = rangeMode ? CARIBOU_RANGE_TILE_URL : layer.tileUrl;
          const tileRegion = rangeMode ? `range_${region}` : region;

          let tileUrl = template.replace('{year}', renderYear).replace('{region}', tileRegion);

          if (layer.id === 'clearcut-accumulated' && CLEARCUT_SENSOR_SUBFOLDER_YEARS.includes(renderYear)) {
            tileUrl = tileUrl.replace(
              `${TILES_BASE_URL}/tiles/clearcut/${region}_${renderYear}/`,
              `${TILES_BASE_URL}/tiles/clearcut/${region}_${renderYear}/${DEFAULT_CLEARCUT_SENSOR}/`,
            );
          }

          rasterLayers.push({
            // The year is part of the id so a year change REPLACES the source
            // rather than retuning it. react-map-gl calls setTiles when only the
            // URLs change, and reloading a source that is mid-draw leaves a
            // renderable tile whose texture has been returned to the pool --
            // MapLibre then throws "Cannot read properties of undefined
            // (reading 'bind')" from its render loop, on an unguarded bind that
            // no paint setting can avoid. Remove-and-add tears the old tiles
            // down with their layer, so nothing is left pointing at a freed
            // texture.
            id: `${layer.id}-${region}-${renderYear}`,
            opacity: layerOpacity,
            // Routed through the tint protocol for the layers whose PNGs are a
            // flat intensity ramp that <RasterTileLayer> recolors on Leaflet.
            // Clearcut is excluded: it gets its color from the COG palette.
            tileUrl: TINTED_LAYER_IDS.has(layer.id) ? tintedTileUrl(layer.id, tileUrl) : tileUrl,
            tms: layer.tms !== undefined ? layer.tms : true,
          });
        });
        });
      });
    });

    return { rasterLayers, cogLayers };
  }, [activeLayers, rasterRegions, caribouRasterRegions, selectedRanges,
      moduleYears, selectedYear, cogCoverageByPrefix,
      clearcutRegions, tileCoverage, playing, timelineYears]);

  // What the AI agent needs to answer "what's in here" across every layer the
  // user has switched on, not just the module currently in front. Names rather
  // than ids, since these go into a prompt.
  const activeLayerSummary = useMemo(() => (
    MODULES.flatMap((module) => (activeLayers[module.id] || []).map((layerId) => ({
      module: module.name,
      layer: module.layers?.find((l) => l.id === layerId)?.name || layerId,
      year: moduleYears[module.id] || selectedYear,
    })))
  ), [activeLayers, moduleYears, selectedYear]);

  const moduleData = {
    percentage: clearcutPercent,
    opacity: rasterOpacity,
    biomassHistogram,
    activeLayerSummary,
    selectedFMUs,
    selectedYear,
    selectedRanges,
    onToggleRange: handleToggleRange,
    onToggleAllRanges: handleToggleAllRanges,
    // The regions the habitat layer is actually drawing, so the panel's numbers
    // describe what is on the map rather than the FMU selection behind it.
    caribouRegions: caribouRasterRegions,
    // Lets the clearcut module narrow its chart to regions the map can draw.
    useCogClearcut: USE_COG,
  };

  const handleModuleSelect = useCallback((module) => {
    setSelectedModuleId(module.id);
    if (moduleYears[module.id] !== undefined) {
      setSelectedYear(moduleYears[module.id]);
    } else if (module.temporalOptions?.yearRange) {
      const [, maxYear] = module.temporalOptions.yearRange;
      setSelectedYear(maxYear);
    }
  }, [moduleYears]);

  // The year is a property of the view, not of the module being read: the
  // timeline sits on the map and moves everything drawn there. Setting only the
  // selected module's year meant playback animated one layer while the others
  // stayed frozen on whatever year they were last left at -- and, worse, that
  // the map showed several different years at once without saying so.
  //
  // Modules with no data for a year simply draw nothing for it; the tile and COG
  // coverage gates already handle that, so no year needs special-casing here.
  const handleYearChange = useCallback((year) => {
    setSelectedYear(year);
    setModuleYears((prev) => {
      const next = { ...prev };
      MODULES.forEach((module) => { next[module.id] = year; });
      return next;
    });
  }, []);

  const PAGE_MAP = {
    about: AboutPage,
    help: HelpPage,
    news: NewsPage,
    publication: PublicationPage,
    documentation: DocumentationPage,
  };

  if (!showApp) {
    return (
      <LandingPage
        onEnter={() => setShowApp(true)}
        onOpenAbout={() => {
          setShowApp(true);
          setActivePage('about');
        }}
        onOpenNews={() => {
          setShowApp(true);
          setActivePage('news');
        }}
        onOpenDocumentation={() => {
          setShowApp(true);
          setActivePage('documentation');
        }}
      />
    );
  }

  if (activePage) {
    const PageComponent = PAGE_MAP[activePage];
    return (
      <div className="app-wrapper">
        <MobileWarning />
        <TopMenu
          onNavigate={setActivePage}
          onHome={() => setActivePage(null)}
          activePage={activePage}
        />
        {PageComponent && <PageComponent onBack={() => setActivePage(null)} />}
      </div>
    );
  }

  return (
    <div className="app-wrapper">
      <MobileWarning />
      <TopMenu
        onNavigate={setActivePage}
        onHome={() => {
          setShowApp(false);
          setActivePage(null);
        }}
        activePage={activePage}
      />
      <div className="layout-container">
        <ModuleSelector
          modules={MODULES}
          selectedModule={selectedModule}
          onModuleSelect={handleModuleSelect}
          activeLayers={activeLayers}
          onLayerToggle={handleLayerToggle}
          moduleData={moduleData}
          selectedYear={selectedYear}
          selectedFMUs={selectedFMUs}
          selectedSensor={DEFAULT_CLEARCUT_SENSOR}
          drawingContext={drawingContext}
          activeTab={panelTab}
          onTabChange={setPanelTab}
          pendingPrompt={pendingPrompt}
          onPromptConsumed={() => setPendingPrompt(null)}
          onProposeFeatures={setProposedFeatures}
          regionsData={maplibreRegions}
        />

        <div className="map-center">
          <FMUSelector values={selectedFMUs} onChange={setSelectedFMUs} />

          {shouldLimitRasterRegions && (
            <div className="performance-notice" role="status" aria-live="polite">
              <span>
                Showing raster tiles for {RASTER_MULTI_FMU_SOFT_LIMIT} of {selectedFMUs.length} selected areas
                to keep the map responsive.
              </span>
              <button
                type="button"
                className="performance-notice-button"
                onClick={() => setAllowHeavyRaster(true)}
              >
                Load all anyway
              </button>
            </div>
          )}

          {/* The year drives what is drawn, so it lives with the map rather than
              in the module panel -- and stays reachable while the panel is
              showing a chart or the AI agent. */}
          <MapTimeline
            years={timelineYears}
            selectedYear={selectedYear}
            onYearChange={handleYearChange}
            onPlayingChange={setPlaying}
            loading={tilesBusy}
          />

          <MapSourcesInfo onOpenDocumentation={() => setActivePage('documentation')} />

          <button
            className="basemap-toggle-btn"
            onClick={() => setBasemapMode((m) => (m === 'satellite' ? 'light' : 'satellite'))}
            title={basemapMode === 'satellite' ? 'Switch to map view' : 'Switch to satellite view'}
          >
            {basemapMode === 'satellite' ? '🗺️ Map' : '🛰️ Satellite'}
          </button>

          <button
            className="locate-btn"
            onClick={() => handleLocateUser(mapRef)}
            title="Locate Me"
          />

          {/* The label is for screen readers only: the spinner sits over the map
              and a word of text there competes with the data underneath. */}
          <div className="loading-indicator" style={{ display: mapReady ? 'none' : 'flex' }}>
            <span className="loading-spinner" role="status" aria-label="Loading map" />
          </div>

          {/* Centred but small and click-through, so it marks progress without
              standing in front of the data. The status line names what is
              actually being fetched -- "still loading" is far less useful than
              "still loading Wildfire". */}
          <div className="tile-activity" style={{ display: tilesLoading ? 'flex' : 'none' }}>
            <span className="loading-spinner loading-spinner--small" role="status" aria-label="Loading map data" />
          </div>

          {tilesLoading && (
            <div className="load-status" role="status">
              Loading{loadingLabel ? ` ${loadingLabel}` : ' map data'}…
            </div>
          )}

          {USE_MAPLIBRE ? (() => {
            const basemapYear = moduleYears[selectedModule?.id] || selectedYear;
            const { url, attribution } = getBasemapConfig(basemapYear);
            return (
              <React.Suspense fallback={(
                <div className="loading-indicator" style={{ display: 'flex' }}>
                  <span className="loading-spinner" role="status" aria-label="Loading map" />
                </div>
              )}>
              <MapLibreMap
                center={center}
                zoom={TILE_ZOOM_LEVELS[0]}
                minZoom={MAP_MIN_ZOOM}
                maxZoom={mapMaxZoom}
                basemapMode={basemapMode}
                satelliteUrl={url}
                satelliteAttribution={attribution}
                lightBasemap={LIGHT_BASEMAP}
                regionsData={maplibreRegions}
                rangeBoundaries={caribouRangeGeoJson}
                rasterLayers={maplibreLayers.rasterLayers}
                cogLayers={maplibreLayers.cogLayers}
                rasterOpacity={rasterOpacity}
                mapRef={mapRef}
                onMapReady={() => setMapReady(true)}
                onDrawChange={setDrawnFeatures}
                onAskAboutDrawing={askAboutDrawing}
                onLoadingChange={handleLoadingChange}
                proposedFeatures={proposedFeatures}
                drawingEnabled
              />
              </React.Suspense>
            );
          })() : (
          <MapContainer
            center={center}
            zoom={TILE_ZOOM_LEVELS[0]}
            minZoom={MAP_MIN_ZOOM}
            maxZoom={mapMaxZoom}
            zoomControl={false}
            whenCreated={(mapInstance) => {
              console.log('Map created', mapInstance);
              mapRef.current = mapInstance;
            }}
            whenReady={() => {
              setMapReady(true);
            }}
            style={{ width: '100%', height: '100%', zIndex: 0 }}
          >
            {basemapMode === 'satellite' ? (() => {
              const basemapYear = moduleYears[selectedModule?.id] || selectedYear;
              const { url, attribution } = getBasemapConfig(basemapYear);
              return (
                <TileLayer
                  key={`satellite-${basemapYear}`}
                  url={url}
                  attribution={attribution}
                  zIndex={5}
                  pmIgnore={true}
                />
              );
            })() : (
              <React.Fragment key="light">
                <TileLayer
                  url={LIGHT_BASEMAP.baseUrl}
                  attribution={LIGHT_BASEMAP.attribution}
                  zIndex={5}
                  pmIgnore={true}
                />
                <TileLayer
                  url={LIGHT_BASEMAP.referenceUrl}
                  zIndex={6}
                  pmIgnore={true}
                />
              </React.Fragment>
            )}

            {MODULES.flatMap((module) => {
              const moduleActiveLayers = activeLayers[module.id] || [];
              return moduleActiveLayers.flatMap((layerId) => {
                const layer = module.layers?.find((l) => l.id === layerId);
                if (!layer) return null;

                // Range mode addresses tiles by range rather than by FMU, so the
                // region list and the URL template have to change together.
                const useRangeTiles = layer.id === 'caribou-habitat'
                  && CARIBOU_RANGE_TILES
                  && selectedRanges.length > 0;

                let layerRegions;
                if (useRangeTiles) {
                  layerRegions = selectedRanges.map((r) => `range_${r}`);
                } else if (layer.id === 'caribou-habitat') {
                  layerRegions = caribouRasterRegions;
                } else {
                  layerRegions = rasterRegions;
                }
                if (layerRegions.length === 0) return null;

                const templateUrl = useRangeTiles ? CARIBOU_RANGE_TILE_URL : layer.tileUrl;
                const moduleYear = moduleYears[module.id] || selectedYear;

                return layerRegions.map((region) => {
                  let tileUrl = templateUrl.replace('{year}', moduleYear);
                  tileUrl = tileUrl.replace('{region}', region);

                  if (layer.id === 'clearcut-accumulated' && CLEARCUT_SENSOR_SUBFOLDER_YEARS.includes(moduleYear)) {
                    tileUrl = tileUrl.replace(
                      `${TILES_BASE_URL}/tiles/clearcut/${region}_${moduleYear}/`,
                      `${TILES_BASE_URL}/tiles/clearcut/${region}_${moduleYear}/${DEFAULT_CLEARCUT_SENSOR}/`,
                    );
                  }

                  return (
                    <RasterTileLayer
                      key={`${layer.id}-${region}`}
                      onStatsUpdate={
                        layer.id === 'clearcut-accumulated' && region === clearcutStatsRegion
                          ? setClearcutPercent
                          : null
                      }
                      onBiomassHistogramUpdate={setBiomassHistogram}
                      onLoadingChange={handleLoadingChange}
                      opacity={rasterOpacity}
                      tileUrl={tileUrl}
                      layerId={layer.id}
                      region={region}
                      year={moduleYear}
                      tms={layer.tms !== undefined ? layer.tms : true}
                    />
                  );
                });
              });
            })}

            <RegionBoundaries selectedFMUs={selectedFMUs} useOntarioOverview={useOntarioOverview} basemapMode={basemapMode} />
            {/* Selected ranges always outline themselves -- habitat with no
                boundary around it reads as a bug, and that is the only thing the
                old "Outline all ranges" switch was really being used for. Drawn
                only for what is selected, so the map says what you asked for and
                nothing else. */}
            <CaribouRangeBoundaries
              visible={selectedRanges.length > 0}
              selectedRanges={selectedRanges}
            />
            <DrawingTools mapRef={mapRef} onDrawChange={setDrawnFeatures} />
            <ZoomControlPositioner position="bottomleft" />
            <MaxZoomController maxZoom={mapMaxZoom} />
          </MapContainer>
          )}
        </div>

        <div className="module-panel-container">
          <ModulePanel
            module={selectedModule}
            data={moduleData}
            activeLayers={activeLayers[selectedModule?.id] || []}
            selectedYear={selectedYear}
            yearRange={selectedModule?.temporalOptions?.yearRange || [2010, 2024]}
            basemapSynced={
              basemapMode !== 'satellite' ||
              isBasemapSynced(moduleYears[selectedModule?.id] || selectedYear)
            }
          />
          <div className="right-column-logo">
            <img className="logo-image logo-light" src="/rsl-logo.png" alt="Remote Sensing Lab and Saint Louis University" />
            <img className="logo-image logo-dark" src="/rsl-logo-transparent.png" alt="Remote Sensing Lab and Saint Louis University" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
