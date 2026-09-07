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
import ClearcutDetection from './modules/ClearcutDetection';
import BiomassModule from './modules/BiomassModule';
import WildfireModule from './modules/WildfireModule';
import CaribouHabitatModule from './modules/CaribouHabitatModule';
import RasterTileLayer from './components/RasterTileLayer';
import { handleLocateUser, handlePlaceChanged } from './utils/mapUtils';
import { CLEARCUT_SENSOR_SUBFOLDER_YEARS, DEFAULT_CLEARCUT_SENSOR } from './utils/clearcutAreaStats';
import { createEmptyBiomassHistogram } from './utils/biomassHistogram';
import { getFireYearsForRegions } from './utils/wildfireYears';
import { getFmusForRanges, rangeColor, CARIBOU_RANGES } from './utils/caribouStats';
import { TILES_BASE_URL, DATA_BASE_URL } from './config';

import './styles/map.css';
import './styles/topmenu.css';
import './styles/menu.css';
import './styles/layout.css';

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

const center = [49.80318325874751, -92.8087780822145];
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

function DrawingTools({ mapRef }) {
  const map = useMap();
  mapRef.current = map;

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

    const onCreate = (e) => {
      console.log('Shape created:', e.layer.toGeoJSON());
    };
    map.on('pm:create', onCreate);

    return () => {
      map.off('pm:create', onCreate);
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

function RegionBoundaries({ selectedFMUs, useOntarioOverview, basemapMode }) {
  const [regionsData, setRegionsData] = useState(null);
  const legacyRegionsRef = useRef(null);
  const perAreaCacheRef = useRef(new Map());
  const overviewCacheRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const loadLegacyIfNeeded = async () => {
      if (legacyRegionsRef.current) return legacyRegionsRef.current;
      const res = await fetch(`${DATA_BASE_URL}/data/regions-simplified.json`);
      if (!res.ok) throw new Error(`regions-simplified.json: HTTP ${res.status}`);
      const data = await res.json();
      legacyRegionsRef.current = data;
      return data;
    };

    const normalizeFeatureCollection = (data) => {
      if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) return null;
      return data;
    };

    const loadSelectedBoundaries = async () => {
      if (selectedFMUs.length === 0) {
        if (!cancelled) setRegionsData(null);
        return;
      }

      if (useOntarioOverview) {
        try {
          if (!overviewCacheRef.current) {
            const overviewRes = await fetch(`${DATA_BASE_URL}/data/regions/ontario-overview.json`);
            if (!overviewRes.ok) {
              throw new Error(`ontario-overview.json: HTTP ${overviewRes.status}`);
            }
            overviewCacheRef.current = normalizeFeatureCollection(await overviewRes.json());
          }

          if (!cancelled) {
            setRegionsData(overviewCacheRef.current);
          }
          return;
        } catch (err) {
          console.warn('Failed to load Ontario overview boundaries; falling back to per-area boundaries.', err);
        }
      }

      const mergedFeatures = [];

      for (const fmu of selectedFMUs) {
        const id = String(fmu || '').toLowerCase();
        if (!id) continue;

        if (perAreaCacheRef.current.has(id)) {
          const cached = perAreaCacheRef.current.get(id);
          if (cached?.features) mergedFeatures.push(...cached.features);
          continue;
        }

        let loaded = null;

        // Preferred source: one JSON per FMU at /data/regions/<id>.json
        try {
          const areaRes = await fetch(`${DATA_BASE_URL}/data/regions/${id}.json`);
          if (areaRes.ok) {
            loaded = normalizeFeatureCollection(await areaRes.json());
          }
        } catch {
          loaded = null;
        }

        // Backward-compatible fallback: filter from legacy simplified file.
        if (!loaded) {
          try {
            const legacy = await loadLegacyIfNeeded();
            const features = (legacy.features || []).filter((feature) => {
              const regionId = feature?.properties?.id?.toLowerCase();
              return regionId === id;
            });
            loaded = { type: 'FeatureCollection', features };
          } catch (err) {
            console.error('Failed to load region boundaries:', err);
            loaded = { type: 'FeatureCollection', features: [] };
          }
        }

        perAreaCacheRef.current.set(id, loaded);
        if (loaded?.features) mergedFeatures.push(...loaded.features);
      }

      if (!cancelled) {
        setRegionsData(
          mergedFeatures.length
            ? { type: 'FeatureCollection', features: mergedFeatures }
            : null,
        );
      }
    };

    loadSelectedBoundaries();

    return () => {
      cancelled = true;
    };
  }, [selectedFMUs, useOntarioOverview]);

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
  const searchRef = useRef(null);
  const autocompleteRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [clearcutPercent, setClearcutPercent] = useState(null);
  const [tilesLoading, setTilesLoading] = useState(false);
  const hidingTimerRef = useRef(null);
  const handleLoadingChange = useCallback((loading) => {
    if (loading) {
      clearTimeout(hidingTimerRef.current);
      setTilesLoading(true);
    } else {
      hidingTimerRef.current = setTimeout(() => setTilesLoading(false), 300);
    }
  }, []);
  const [biomassHistogram, setBiomassHistogram] = useState(createEmptyBiomassHistogram());
  const [rasterOpacity, setRasterOpacity] = useState(1);
  const [showCaribouRanges, setShowCaribouRanges] = useState(false);
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

  const availableYearsForPanel = selectedModule?.id === 'wildfire'
    ? wildfireYearOptions
    : selectedModule?.temporalOptions?.availableYears;

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

  useEffect(() => {
    const initAutocomplete = () => {
      if (!searchRef.current || !window.google?.maps?.places) return;
      autocompleteRef.current = new window.google.maps.places.Autocomplete(searchRef.current);
      autocompleteRef.current.addListener('place_changed', () => {
        handlePlaceChanged(autocompleteRef, mapRef);
      });
    };

    if (window.google?.maps?.places) {
      initAutocomplete();
      return;
    }

    const apiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.warn('Missing REACT_APP_GOOGLE_MAPS_API_KEY. Google Places search will be disabled.');
      return;
    }

    const scriptId = 'google-maps-places-script';
    if (document.getElementById(scriptId)) return;

    const script = document.createElement('script');
    script.id = scriptId;
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.onload = initAutocomplete;
    document.head.appendChild(script);
  }, []);

  const mapMaxZoom = basemapMode === 'satellite' ? TILE_ZOOM_RANGE.max : LIGHT_BASEMAP_MAX_ZOOM;

  const moduleData = {
    percentage: clearcutPercent,
    opacity: rasterOpacity,
    biomassHistogram,
    selectedFMUs,
    selectedYear,
    showCaribouRanges,
    onToggleCaribouRanges: setShowCaribouRanges,
    selectedRanges,
    onToggleRange: handleToggleRange,
    onToggleAllRanges: handleToggleAllRanges,
    // The regions the habitat layer is actually drawing, so the panel's numbers
    // describe what is on the map rather than the FMU selection behind it.
    caribouRegions: caribouRasterRegions,
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

  const handleYearChange = useCallback((year) => {
    setSelectedYear(year);
    if (selectedModule?.id) {
      setModuleYears((prev) => ({
        ...prev,
        [selectedModule.id]: year,
      }));
    }
  }, [selectedModule]);

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
        />

        <div className="map-center">
          <div className="search-container">
            <span className="search-icon" aria-hidden="true">🔍</span>
            <input
              className="search-box"
              placeholder="Search a place"
              ref={searchRef}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handlePlaceChanged(autocompleteRef, mapRef);
              }}
            />
          </div>

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

          <div className="loading-indicator" style={{ display: mapReady ? 'none' : 'block' }}>
            Loading map...
          </div>

          <div className="loading-indicator" style={{ display: tilesLoading ? 'block' : 'none' }}>
            Loading...
          </div>

          <MapContainer
            center={center}
            zoom={TILE_ZOOM_LEVELS[0]}
            minZoom={TILE_ZOOM_RANGE.min}
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
            {/* A selected range always draws its own outline -- selecting one and
                getting habitat with no boundary reads as a bug. The toggle is
                then only about the ranges that are NOT selected. */}
            <CaribouRangeBoundaries
              visible={showCaribouRanges || selectedRanges.length > 0}
              selectedRanges={showCaribouRanges ? [] : selectedRanges}
            />
            <DrawingTools mapRef={mapRef} />
            <ZoomControlPositioner position="bottomleft" />
            <MaxZoomController maxZoom={mapMaxZoom} />
          </MapContainer>
        </div>

        <div className="module-panel-container">
          <ModulePanel
            module={selectedModule}
            data={moduleData}
            activeLayers={activeLayers[selectedModule?.id] || []}
            selectedYear={selectedYear}
            onYearChange={handleYearChange}
            yearRange={selectedModule?.temporalOptions?.yearRange || [2010, 2024]}
            availableYears={availableYearsForPanel}
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
