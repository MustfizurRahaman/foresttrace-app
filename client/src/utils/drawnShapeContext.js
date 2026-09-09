import { computeGeoJsonAreaHa } from './regionArea';

/**
 * Turns drawn map features into a compact context object for the AI agent.
 *
 * Two constraints shape this. First, the payload rides in the chat request's
 * system prompt, and Groq counts it against the same per-minute token budget
 * that already forced max_tokens down -- so a 400-vertex polygon cannot go over
 * verbatim. Second, a bare coordinate list is nearly useless to a language
 * model: what it can reason about is where the shape is, how big it is, and
 * which FMU it falls in. So the summary leads with derived facts and includes
 * only a sampled outline.
 */

// Vertices kept per shape. Enough to convey rough form; a rectangle or circle
// survives intact, a hand-drawn polygon is sampled evenly.
const MAX_VERTICES = 12;

// Coordinate precision. 5 decimals is ~1 m at this latitude -- far finer than a
// 30 m HLS pixel, so nothing meaningful is lost and the string is halved.
const COORD_DP = 5;

const round = (n) => Number(n.toFixed(COORD_DP));

function outerRing(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates[0];
  if (geom.type === 'MultiPolygon') return geom.coordinates[0]?.[0];
  return null;
}

function pointCoord(geom) {
  if (geom?.type !== 'Point') return null;
  const [x, y] = geom.coordinates || [];
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Evenly-spaced sample, always keeping the first and last vertex. */
function sampleRing(ring) {
  if (ring.length <= MAX_VERTICES) return ring.map(([x, y]) => [round(x), round(y)]);
  const step = (ring.length - 1) / (MAX_VERTICES - 1);
  return Array.from({ length: MAX_VERTICES }, (_, i) => {
    const [x, y] = ring[Math.round(i * step)];
    return [round(x), round(y)];
  });
}

function bboxOf(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

const bboxesOverlap = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Ray casting on the outer ring. Holes are ignored, as elsewhere in the app. */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = (yi > y) !== (yj > y);
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * FMUs a drawn shape touches.
 *
 * Reported at two strengths because they answer different questions and the
 * cheap test alone would overstate: bbox overlap is a *candidate* (two shapes
 * can have overlapping bounding boxes and no common ground, and FMU polygons
 * are famously irregular -- Wabigoon covers ~35% of its own bbox), while a
 * centroid inside the polygon is solid evidence the shape is really there.
 */
function regionsTouched(shapeBbox, shapeCentroid, regionsData) {
  const candidates = [];
  const containing = [];

  for (const feature of regionsData?.features ?? []) {
    const ring = outerRing(feature.geometry);
    if (!ring) continue;
    const id = feature.properties?.id || feature.properties?.name;
    if (!id) continue;

    if (!bboxesOverlap(shapeBbox, bboxOf(ring))) continue;
    if (!candidates.includes(id)) candidates.push(id);
    if (pointInRing(shapeCentroid, ring) && !containing.includes(id)) containing.push(id);
  }
  return { candidates, containing };
}

/**
 * @param {Array} features drawn GeoJSON features
 * @param {Object|null} regionsData FeatureCollection of FMU boundaries
 * @returns {Object|null} null when nothing is drawn, so callers can omit the key
 */
export function summarizeDrawing(features, regionsData) {
  if (!Array.isArray(features) || features.length === 0) return null;

  const shapes = [];
  const allCandidates = [];
  const allContaining = [];

  features.forEach((feature, i) => {
    // A pin is a location, not an area. Handled first and separately: forcing it
    // through the ring path would report a zero-area polygon, and the model
    // would then reason about "a 0 ha region" instead of a point of interest.
    const point = pointCoord(feature?.geometry);
    if (point) {
      const at = [round(point[0]), round(point[1])];
      const { candidates, containing } = regionsTouched([at[0], at[1], at[0], at[1]], at, regionsData);
      candidates.forEach((r) => !allCandidates.includes(r) && allCandidates.push(r));
      containing.forEach((r) => !allContaining.includes(r) && allContaining.push(r));
      shapes.push({ id: i + 1, kind: 'point', centroid: at });
      return;
    }

    const ring = outerRing(feature?.geometry);
    if (!ring || ring.length < 3) return;

    const bbox = bboxOf(ring);
    const centroid = [round((bbox[0] + bbox[2]) / 2), round((bbox[1] + bbox[3]) / 2)];
    const { candidates, containing } = regionsTouched(bbox, centroid, regionsData);

    candidates.forEach((r) => !allCandidates.includes(r) && allCandidates.push(r));
    containing.forEach((r) => !allContaining.includes(r) && allContaining.push(r));

    shapes.push({
      id: i + 1,
      // terra-draw records the tool used; geoman shapes arrive without one.
      kind: feature?.properties?.mode || feature?.geometry?.type || 'polygon',
      areaHa: Math.round(computeGeoJsonAreaHa(feature) ?? 0),
      centroid,
      bbox: bbox.map(round),
      vertexCount: ring.length,
      outline: sampleRing(ring),
      sampled: ring.length > MAX_VERTICES,
    });
  });

  if (shapes.length === 0) return null;

  return {
    shapes,
    // Pins contribute no area, so they must not dilute the total -- a question
    // about "the area I marked" should reflect only the areas.
    totalAreaHa: shapes.reduce((sum, s) => sum + (s.areaHa || 0), 0),
    pointCount: shapes.filter((s) => s.kind === 'point').length,
    regionsContaining: allContaining,
    regionsNearby: allCandidates.filter((r) => !allContaining.includes(r)),
  };
}
