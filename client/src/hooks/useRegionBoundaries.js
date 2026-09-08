import { useEffect, useRef, useState } from 'react';
import { DATA_BASE_URL } from '../config';

/**
 * Loads FMU boundary GeoJSON for the selected regions.
 *
 * Extracted from App.js's <RegionBoundaries> so the Leaflet and MapLibre renderers
 * share one loader instead of two drifting copies -- the fetching, the per-area
 * cache, and the legacy-file fallback are all renderer-agnostic; only the drawing
 * differs between them.
 *
 * Returns a FeatureCollection, or null when nothing is selected or nothing loaded.
 */
export default function useRegionBoundaries(selectedFMUs, useOntarioOverview) {
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

  return regionsData;
}
