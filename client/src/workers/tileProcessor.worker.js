/* eslint-disable no-restricted-globals */
import { BIOMASS_BINS } from '../utils/biomassHistogram';

// Mirrors the color ramp previously computed on the main thread in
// RasterTileLayer — moved here so the per-pixel loop never blocks the UI.
function getColorForBiomassIntensity(rawIntensity) {
  const agb = (rawIntensity / 255) * 1000;
  if (agb < 10) {
    const t = agb / 10;
    return { r: Math.round(220 - (100 * t)), g: Math.round(180 - (95 * t)), b: Math.round(140 - (100 * t)) };
  }
  if (agb < 25) {
    const t = (agb - 10) / 15;
    return { r: Math.round(120 + (135 * t)), g: Math.round(85 + (155 * t)), b: Math.round(40) };
  }
  if (agb < 40) {
    const t = (agb - 25) / 15;
    return { r: Math.round(255), g: Math.round(240 - (50 * t)), b: Math.round(40) };
  }
  if (agb < 50) {
    const t = (agb - 40) / 10;
    return { r: Math.round(255), g: Math.round(190 + (65 * t)), b: Math.round(40) };
  }
  if (agb < 85) {
    const t = (agb - 50) / 35;
    return { r: Math.round(50 * (1 - t)), g: Math.round(220 + (35 * t)), b: Math.round(0) };
  }
  if (agb < 120) {
    const t = (agb - 85) / 35;
    return { r: 0, g: Math.round(255), b: Math.round(20 * t) };
  }
  const t = Math.min(1, (agb - 120) / 30);
  return { r: 0, g: Math.round(255 - (90 * t)), b: Math.round(50 * t) };
}

function getTilePixelAreaHa(z, y) {
  const tilesPerAxis = 2 ** z;
  const centerY = y + 0.5;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * centerY) / tilesPerAxis)));
  const metersPerPixel = (156543.03392 * Math.cos(latRad)) / tilesPerAxis;
  return (metersPerPixel * metersPerPixel) / 10000;
}

// Recolors a tile's pixels in place for the given layer type and tallies the
// stats each layer needs (red-pixel ratio for clearcut/wildfire, an AGB
// histogram for biomass). Returns null redCount/totalCount/histogram fields
// for layer types that don't apply.
function processPixels(layerId, pixels, coords) {
  let redCount = 0;
  let totalCount = 0;
  let histogram = null;

  const isBiomass = layerId === 'biomass-density';
  const pixelAreaHa = isBiomass ? getTilePixelAreaHa(coords.z, coords.y) : 0;
  if (isBiomass) {
    histogram = BIOMASS_BINS.map(() => ({ area: 0, pixels: 0 }));
  }

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    totalCount += 1;

    if (layerId === 'clearcut-accumulated' || layerId === 'clearcut-annual') {
      if (a > 0 && r > 200) redCount += 1;
      if (a === 0) continue;
      const intensity = r / 255;
      if (layerId === 'clearcut-annual') {
        // Yellow tint (#FFD700)
        pixels[i]     = Math.round((r * 0.35) + (255 * intensity * 0.65));
        pixels[i + 1] = Math.round(215 * intensity);
        pixels[i + 2] = Math.round(b * 0.05);
      } else {
        // Red tint for accumulated
        pixels[i]     = Math.round((r * 0.35) + (255 * intensity * 0.65));
        pixels[i + 1] = Math.round(g * 0.18);
        pixels[i + 2] = Math.round(b * 0.18);
      }
      continue;
    }

    if (layerId === 'wildfire-burned') {
      if (a > 0 && r > 200) redCount += 1;
      if (a === 0) continue;
      const intensity = r / 255;
      // Fire red (#F8420B).
      pixels[i]     = Math.round(248 * intensity);
      pixels[i + 1] = Math.round(66 * intensity);
      pixels[i + 2] = Math.round(11 * intensity);
      continue;
    }

    if (isBiomass) {
      if (a === 0) continue;
      const agb = (g / 255) * 1000;
      for (let binIdx = 0; binIdx < BIOMASS_BINS.length; binIdx += 1) {
        const bin = BIOMASS_BINS[binIdx];
        if (agb >= bin.min && agb < bin.max) {
          histogram[binIdx].pixels += 1;
          histogram[binIdx].area += pixelAreaHa;
          break;
        }
      }
      const color = getColorForBiomassIntensity(g);
      pixels[i] = color.r;
      pixels[i + 1] = color.g;
      pixels[i + 2] = color.b;
    }
  }

  return { redCount, totalCount, histogram };
}

self.onmessage = (event) => {
  const { id, layerId, width, height, buffer, coords } = event.data;
  const pixels = new Uint8ClampedArray(buffer);
  const { redCount, totalCount, histogram } = processPixels(layerId, pixels, coords);

  self.postMessage(
    { id, buffer: pixels.buffer, width, height, redCount, totalCount, histogram },
    [pixels.buffer],
  );
};
