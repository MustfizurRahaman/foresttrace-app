/**
 * Geometry the AI agent may put on the map, and the limits on it.
 *
 * The governing constraint: a language model does not know where anything
 * actually is. It cannot recall the outline of a harvest block or the edge of a
 * burn scar, and asked for one it will emit plausible, confident, fabricated
 * coordinates -- which on a map are indistinguishable from a measurement. So
 * the model is never allowed to produce geometry from memory. It may only:
 *
 *   draw_bbox         a box of a stated size around a stated point -- arithmetic
 *                     done here, from numbers the user supplied
 *   draw_polygon      coordinates the USER gave in the conversation
 *   highlight_region  an FMU, drawn from OUR boundary file by id, never from
 *                     coordinates the model wrote
 *   highlight_patches the largest detected clearcut patches, drawn from the
 *                     published patch vectors -- the model chooses the region,
 *                     year and how many, and the geometry comes from the data
 *
 * Everything below is validation of untrusted model output: bounds, size, and
 * count are all capped, and anything failing is dropped rather than corrected,
 * because a silently "fixed" polygon is still a fabricated one.
 */

import { DATA_BASE_URL } from '../config';

// Ontario plus a wide margin. A coordinate outside this is a hallucination or a
// lat/lon swap, and both should be refused rather than drawn.
const BOUNDS = { minLon: -96.5, maxLon: -73.0, minLat: 41.0, maxLat: 57.5 };

const MAX_SHAPES = 5;
// Separate from MAX_SHAPES because one requested shape can expand to many: an
// FMU is a MultiPolygon, so "outline these five" became 26 rings. The cap is on
// what actually reaches the map, not on what was asked for.
const MAX_FEATURES = 60;
const MAX_VERTICES = 200;
// Larger than any FMU. A "polygon" spanning the province is a sign the model
// invented a bounding box rather than using what it was given.
const MAX_SIZE_KM = 400;

// terra-draw validates against a default coordinatePrecision of 9 and rejects
// anything finer -- and it does so through addFeatures' return value rather than
// by throwing, so the failure is silent. Every source here trips it: the FMU
// overview file stores 15 decimal places, and the bbox maths produces full
// float expansions. 6 decimals is ~0.1 m, far beyond what any of this data
// supports, so rounding costs nothing real.
const COORD_PRECISION = 6;

const roundRing = (ring) => ring.map(([x, y]) => [
  Number(x.toFixed(COORD_PRECISION)),
  Number(y.toFixed(COORD_PRECISION)),
]);

/** UUID v4, with a fallback for browsers without crypto.randomUUID. */
function newFeatureId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const inBounds = ([lon, lat]) =>
  Number.isFinite(lon) && Number.isFinite(lat)
  && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon
  && lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat;

/**
 * Extracts a ```map-action fenced block, if the reply carries one.
 * Returns { action, text } with the block stripped from the prose.
 */
export function extractMapAction(text) {
  if (typeof text !== 'string') return { action: null, text };
  const fence = /```map-action\s*([\s\S]*?)```/i;
  const match = text.match(fence);
  if (!match) return { action: null, text };

  let action = null;
  try {
    action = JSON.parse(match[1].trim());
  } catch {
    // Malformed JSON means no action, but the prose is still worth showing.
    action = null;
  }
  return { action, text: text.replace(fence, '').trim() };
}

function bboxFeature(center, sizeKm) {
  const [lat, lon] = center;
  if (!inBounds([lon, lat])) return null;
  if (!Number.isFinite(sizeKm) || sizeKm <= 0 || sizeKm > MAX_SIZE_KM) return null;

  const halfLat = sizeKm / 2 / 110.574;
  const halfLon = sizeKm / 2 / (111.320 * Math.cos((lat * Math.PI) / 180));
  const ring = [
    [lon - halfLon, lat - halfLat],
    [lon + halfLon, lat - halfLat],
    [lon + halfLon, lat + halfLat],
    [lon - halfLon, lat + halfLat],
    [lon - halfLon, lat - halfLat],
  ];
  return ring.every(inBounds) ? ring : null;
}

function polygonRing(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return null;
  if (coordinates.length > MAX_VERTICES) return null;
  const ring = coordinates.map((c) => (Array.isArray(c) ? [Number(c[0]), Number(c[1])] : null));
  if (ring.some((c) => !c || !inBounds(c))) return null;
  // GeoJSON rings must close; models routinely forget.
  const [first] = ring;
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

/**
 * Loose key for region matching.
 *
 * The app's ids are bare ("wabigoon") while its display names are not
 * ("Wabigoon Forest"), and a model writing prose reaches for neither -- it says
 * "Wabigoon FMU". Exact matching rejected all three-quarters of the time, so
 * strip punctuation and the interchangeable words rather than making the model
 * guess our internal spelling.
 */
function regionKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fmu|forest|management|unit|park)\b/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function ringsFromCollection(wanted, collection) {
  const rings = [];
  for (const feature of collection?.features ?? []) {
    const props = feature.properties || {};
    if (regionKey(props.id) !== wanted && regionKey(props.name) !== wanted) continue;
    const geom = feature.geometry;
    if (geom?.type === 'Polygon') rings.push(geom.coordinates[0]);
    else if (geom?.type === 'MultiPolygon') geom.coordinates.forEach((p) => rings.push(p[0]));
  }
  return rings;
}

async function regionRings(regionId, regionsData) {
  const wanted = regionKey(regionId);
  if (!wanted) return [];
  // Prefer the full-detail boundary already loaded for a selected region; fall
  // back to the simplified province-wide overview for everything else.
  const loaded = ringsFromCollection(wanted, regionsData);
  if (loaded.length) return loaded;
  return ringsFromCollection(wanted, await loadOverview());
}

/**
 * Every Ontario FMU, from the overview file the app already ships.
 *
 * Outlining a region deliberately does NOT depend on which FMUs happen to be
 * selected. Tying it to the selection meant "outline Wabigoon" failed whenever
 * Wabigoon wasn't already on screen -- precisely when the user is most likely to
 * ask -- and it made "compare against other FMUs" impossible by construction.
 * The overview is one simplified file covering all 39, which is the right level
 * of detail for an outline anyway.
 */
let _overviewPromise = null;

function loadOverview() {
  if (!_overviewPromise) {
    _overviewPromise = fetch(`${DATA_BASE_URL}/data/regions/ontario-overview.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _overviewPromise;
}

// Patch vectors, one file per region/year, derived from the same accumulated
// masks the map draws. Cached because a conversation revisits the same year.
const _patchCache = new Map();

function loadPatches(region, year) {
  const key = `${region}_${year}`;
  if (!_patchCache.has(key)) {
    _patchCache.set(key, fetch(`${DATA_BASE_URL}/data/patches/${key}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return _patchCache.get(key);
}

/**
 * The N largest clearcut patches for a region/year.
 *
 * This is the answer to "highlight the biggest clearcuts", which the assistant
 * previously had to refuse: it has no way to know where they are, and guessing
 * is the one thing it must not do. Here it chooses only the query; every
 * coordinate comes from the published vectors.
 */
async function patchRings(shape) {
  const region = regionKey(shape.region);
  const year = Number(shape.year);
  if (!region || !Number.isFinite(year)) return [];

  const fc = await loadPatches(region, year);
  if (!fc?.features?.length) return [];

  const count = Math.min(Math.max(Number(shape.count) || 5, 1), 25);
  const rings = [];
  for (const feature of fc.features.slice(0, count)) {
    const geom = feature.geometry;
    if (geom?.type === 'Polygon') rings.push(geom.coordinates[0]);
    else if (geom?.type === 'MultiPolygon') geom.coordinates.forEach((poly) => rings.push(poly[0]));
  }
  return rings;
}

/** Ids the assistant may outline. Falls back to what's loaded if the fetch fails. */
export async function availableRegionIds(regionsData) {
  const overview = await loadOverview();
  const ids = (overview?.features ?? []).map((f) => f.properties?.id).filter(Boolean);
  if (ids.length) return ids;
  return (regionsData?.features ?? []).map((f) => f.properties?.id).filter(Boolean);
}

/**
 * Validates a model-proposed action into drawable features.
 *
 * @returns {{ features: Array, rejected: string|null }} rejected carries a
 *   reason to show the user -- a refusal the reader can see beats geometry that
 *   quietly never appeared.
 */
export async function actionToFeatures(action, regionsData) {
  if (!action || typeof action !== 'object') return { features: [], rejected: null };

  const shapes = Array.isArray(action.shapes) ? action.shapes : [action];
  if (shapes.length > MAX_SHAPES) {
    return { features: [], rejected: `refused: ${shapes.length} shapes exceeds the limit of ${MAX_SHAPES}` };
  }

  const features = [];
  const missingRegions = [];
  for (const shape of shapes) {
    let rings = [];
    switch (shape?.action) {
      case 'draw_bbox': {
        const ring = bboxFeature(shape.center || [], Number(shape.sizeKm));
        if (ring) rings = [ring];
        break;
      }
      case 'draw_polygon': {
        const ring = polygonRing(shape.coordinates);
        if (ring) rings = [ring];
        break;
      }
      case 'highlight_region':
        rings = await regionRings(shape.region, regionsData);
        break;
      case 'highlight_patches':
        rings = await patchRings(shape);
        break;
      default:
        break;
    }

    if (rings.length === 0) {
      // A region we don't hold is a different failure from invented geometry:
      // the request was legitimate, the boundary just isn't loaded because it
      // isn't selected. Skip that one and keep the rest, rather than throwing
      // away a valid "outline Wabigoon" because a second FMU wasn't available.
      if (shape?.action === 'highlight_region') {
        missingRegions.push(String(shape.region || 'unnamed'));
        continue;
      }
      if (shape?.action === 'highlight_patches') {
        return {
          features: [],
          rejected: `refused: no patch data published for ${shape.region} ${shape.year}`,
        };
      }
      return {
        features: [],
        rejected: `refused: "${shape?.action || 'unknown'}" produced no valid geometry `
          + '(coordinates outside Ontario, or an implausible size)',
      };
    }

    rings.forEach((ring) => features.push({
      // terra-draw's default id strategy validates ids as UUIDs and rejects a
      // feature that arrives without one -- silently, since addFeatures returns
      // validation results rather than throwing.
      id: newFeatureId(),
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [roundRing(ring)] },
      properties: {
        mode: 'ai',
        // Carried so the UI can always say where a shape came from. Nothing
        // downstream should treat these as user intent.
        proposedBy: 'assistant',
        label: typeof shape.label === 'string' ? shape.label.slice(0, 80) : undefined,
      },
    }));
  }

  if (features.length > MAX_FEATURES) {
    return {
      features: [],
      rejected: `refused: ${features.length} outlines exceeds the limit of ${MAX_FEATURES} — ask for fewer regions`,
    };
  }

  if (features.length === 0 && missingRegions.length) {
    return {
      features: [],
      rejected: `no boundary loaded for ${missingRegions.join(', ')} — `
        + 'no Ontario FMU matches that name',
    };
  }

  return {
    features,
    rejected: missingRegions.length
      ? `no boundary loaded for ${missingRegions.join(', ')}`
      : null,
  };
}
