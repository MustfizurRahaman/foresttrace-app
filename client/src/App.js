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
import ClearcutDetection from './modules/ClearcutDetection';
import BiomassModule from './modules/BiomassModule';
import WildfireModule from './modules/WildfireModule';
import RasterTileLayer from './components/RasterTileLayer';
import { handleLocateUser, handlePlaceChanged } from './utils/mapUtils';
import { CLEARCUT_SENSOR_SUBFOLDER_YEARS, DEFAULT_CLEARCUT_SENSOR } from './utils/clearcutAreaStats';
import { createEmptyBiomassHistogram } from './utils/biomassHistogram';
import { getFireYearsForRegions } from './utils/wildfireYears';
import { TILES_BASE_URL, clearcutCogUrl } from './config';
import useRegionBoundaries from './hooks/useRegionBoundaries';
import { TINTED_LAYER_IDS, tintedTileUrl } from './utils/tintedTileProtocol';
import { summarizeDrawing } from './utils/drawnShapeContext';

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

const center = [49.80318325874751, -92.8087780822145];

// Renders the MapLibre map instead of the Leaflet one. Off by default: the
// MapLibre path is still being brought to parity (stats tallying, biomass
// histograms and the wildfire layers still run through <RasterTileLayer>), so
// the Leaflet map stays the shipping one until those land.
//   REACT_APP_USE_MAPLIBRE=true npm start
const USE_MAPLIBRE = process.env.REACT_APP_USE_MAPLIBRE === 'true';

// Serve clearcut from COGs rather than PNG pyramids. Independent of the renderer
// flag so the two can be evaluated separately -- though COGs only render on
// MapLibre, so this does nothing while USE_MAPLIBRE is off.
const USE_COG_CLEARCUT = process.env.REACT_APP_USE_COG_CLEARCUT === 'true';
const TILE_ZOOM_LEVELS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const TILE_ZOOM_RANGE = {
  min: Math.min(...TILE_ZOOM_LEVELS),
  max: Math.max(...TILE_ZOOM_LEVELS),
};

// Esri's Light Gray Canvas cache stops at level 16 — deeper requests just
// re-serve the same overzoomed level-16 tile, so cap zoom there in light mode.
const LIGHT_BASEMAP_MAX_ZOOM = 16;

// How far the viewport may zoom out, which is NOT where the tile pyramid starts.
// The two were the same value, so the map was pinned to the tiles' floor of z6 --
// too close to fit Ontario, which spans ~15 degrees of latitude and needs about
// z4. Below z6 the raster overlays simply stop drawing (their sources declare
// minzoom 6); the basemap and FMU boundaries still do, which is what makes a
// province-wide view worth having.
const MAP_MIN_ZOOM = 4;
const RASTER_MULTI_FMU_SOFT_LIMIT = 8;
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
    description: 'Track birds and wildlife species distribution',
    component: ClearcutDetection,
    temporalOptions: {
      yearRange: [2015, 2025],
    },
    layers: [
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
  const maplibreLayers = useMemo(() => {
    if (!USE_MAPLIBRE) return { rasterLayers: [], cogLayers: [] };

    const rasterLayers = [];
    const cogLayers = [];

    MODULES.forEach((module) => {
      (activeLayers[module.id] || []).forEach((layerId) => {
        const layer = module.layers?.find((l) => l.id === layerId);
        if (!layer || rasterRegions.length === 0) return;

        const moduleYear = moduleYears[module.id] || selectedYear;

        rasterRegions.forEach((region) => {
          const cogUrl = USE_COG_CLEARCUT ? clearcutCogUrl(layer.id, region, moduleYear) : null;
          if (cogUrl) {
            // color carries the layer's identity, not the class's: accumulated and
            // annual are both class 2 in the raster, so without it they'd paint the
            // same and the two layers would be indistinguishable when stacked.
            cogLayers.push({ id: `${layer.id}-${region}`, url: cogUrl, color: layer.color });
            return;
          }

          let tileUrl = layer.tileUrl.replace('{year}', moduleYear).replace('{region}', region);

          if (layer.id === 'clearcut-accumulated' && CLEARCUT_SENSOR_SUBFOLDER_YEARS.includes(moduleYear)) {
            tileUrl = tileUrl.replace(
              `${TILES_BASE_URL}/tiles/clearcut/${region}_${moduleYear}/`,
              `${TILES_BASE_URL}/tiles/clearcut/${region}_${moduleYear}/${DEFAULT_CLEARCUT_SENSOR}/`,
            );
          }

          rasterLayers.push({
            id: `${layer.id}-${region}`,
            // Routed through the tint protocol for the layers whose PNGs are a
            // flat intensity ramp that <RasterTileLayer> recolors on Leaflet.
            // Clearcut is excluded: it gets its color from the COG palette.
            tileUrl: TINTED_LAYER_IDS.has(layer.id) ? tintedTileUrl(layer.id, tileUrl) : tileUrl,
            tms: layer.tms !== undefined ? layer.tms : true,
          });
        });
      });
    });

    return { rasterLayers, cogLayers };
  }, [activeLayers, rasterRegions, moduleYears, selectedYear]);

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
    // Lets the clearcut module narrow its chart to regions the map can draw.
    useCogClearcut: USE_COG_CLEARCUT,
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
          drawingContext={drawingContext}
          activeTab={panelTab}
          onTabChange={setPanelTab}
          pendingPrompt={pendingPrompt}
          onPromptConsumed={() => setPendingPrompt(null)}
          onProposeFeatures={setProposedFeatures}
          regionsData={maplibreRegions}
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

          <div className="loading-indicator" style={{ display: mapReady ? 'none' : 'block' }}>
            Loading map...
          </div>

          <div className="loading-indicator" style={{ display: tilesLoading ? 'block' : 'none' }}>
            Loading...
          </div>

          {USE_MAPLIBRE ? (() => {
            const basemapYear = moduleYears[selectedModule?.id] || selectedYear;
            const { url, attribution } = getBasemapConfig(basemapYear);
            return (
              <React.Suspense fallback={<div className="loading-indicator">Loading map…</div>}>
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
                rasterLayers={maplibreLayers.rasterLayers}
                cogLayers={maplibreLayers.cogLayers}
                rasterOpacity={rasterOpacity}
                mapRef={mapRef}
                onMapReady={() => setMapReady(true)}
                onDrawChange={setDrawnFeatures}
                onAskAboutDrawing={askAboutDrawing}
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
                if (rasterRegions.length === 0) return null;

                const moduleYear = moduleYears[module.id] || selectedYear;

                return rasterRegions.map((region) => {
                  let tileUrl = layer.tileUrl.replace('{year}', moduleYear);
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
