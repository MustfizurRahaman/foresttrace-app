/**
 * The 6-class taxonomy the clearcut U-Net predicts, and its map palette.
 *
 * These class IDs come straight from the model's output raster
 * (utils/multiclass_labels.py in boreal-canada-mapping). The old PNG tile
 * pipeline flattened all of this to one flat white before the tiles were even
 * written -- every class but `clearcut` was discarded at tiling time, and
 * `clearcut` itself kept a color rather than a value. Serving COGs preserves
 * the class IDs, so coloring now happens here, at draw time, and changing a
 * color no longer means regenerating tiles.
 *
 * Colors match the notebooks' own QA figures so the app and the papers agree.
 */

export const CLEARCUT_CLASSES = {
  0: { name: 'background', color: null }, // nodata -- always transparent
  1: { name: 'forest', color: '#1baf7a' },
  2: { name: 'clearcut', color: '#eda100' },
  3: { name: 'fire', color: '#d62728' },
  4: { name: 'water', color: '#1f77b4' },
  5: { name: 'other', color: '#9467bd' },
};

/** The clearcut class itself -- the one a layer's own color overrides. */
export const CLEARCUT_CLASS_ID = 2;

/** Classes shown by default: the disturbance signal, not the land-cover context. */
export const DEFAULT_VISIBLE_CLASSES = [CLEARCUT_CLASS_ID];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Builds a pixel->RGBA function for maplibre-cog-protocol's setColorFunction.
 *
 * Called once per pixel per tile, so the palette is resolved into a flat lookup
 * table up front rather than doing hex parsing or object lookups in the loop.
 *
 * @param {number[]} visibleClasses class IDs to paint; everything else is transparent
 * @param {number} alpha 0-255 opacity for painted pixels
 * @param {Object<number,string>} colorOverrides per-class hex overrides. The
 *   accumulated and annual layers render the SAME class (2 = clearcut) from
 *   different rasters, so the taxonomy palette alone would paint both identically
 *   -- the layer, not the class, is what distinguishes them on screen.
 */
export function buildClassColorFunction(
  visibleClasses = DEFAULT_VISIBLE_CLASSES,
  alpha = 255,
  colorOverrides = {},
) {
  // Index = class ID, value = [r,g,b,a]. Sized to the taxonomy, so an
  // out-of-range value from a future model reads as undefined and is drawn
  // transparent rather than silently aliasing onto a real class.
  const lut = new Array(256).fill(null);
  visibleClasses.forEach((id) => {
    const color = colorOverrides[id] ?? CLEARCUT_CLASSES[id]?.color;
    if (!color) return;
    lut[id] = [...hexToRgb(color), alpha];
  });

  return function classColorFunction(pixel, color, metadata) {
    const value = pixel[0];
    if (value === metadata.noData) {
      color.set([0, 0, 0, 0]);
      return;
    }
    const rgba = lut[value];
    if (rgba) {
      color.set(rgba);
    } else {
      color.set([0, 0, 0, 0]);
    }
  };
}
