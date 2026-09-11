/**
 * Turns a class-valued raster into pixels, for maplibre-cog-protocol's
 * setColorFunction.
 *
 * The mechanism only -- it holds no taxonomy. Each layer supplies its own
 * palette, because the vocabularies are unrelated: wildfire comes from NBAC
 * polygons and has nothing to do with the clearcut model, so inheriting that
 * model's numbering would let a renumbering there change what wildfire draws.
 */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Builds a pixel->RGBA function.
 *
 * Called once per pixel per tile, so the palette is resolved into a flat lookup
 * table up front rather than doing hex parsing or object lookups in the loop.
 *
 * @param {Object} opts
 * @param {Object<number,{name:string,color:?string,alpha:?number}>} opts.palette
 *   the layer's own class table. Required -- no default, so a layer cannot
 *   silently borrow another module's numbering. A class may carry its own alpha.
 * @param {number[]} opts.visibleClasses class IDs to paint; everything else is
 *   transparent.
 * @param {number} [opts.alpha=255] 0-255 opacity for classes that declare none.
 * @param {Object<number,string>} [opts.colorOverrides] per-class hex overrides.
 *   Clearcut's accumulated and annual layers render the SAME class (2) from
 *   different rasters, so the palette alone would paint both identically.
 */
export function buildClassColorFunction({
  palette,
  visibleClasses,
  alpha = 255,
  colorOverrides = {},
}) {
  if (!palette) throw new Error('buildClassColorFunction: palette is required');

  // Index = class ID, value = [r,g,b,a]. Sized past any plausible taxonomy, so an
  // unexpected value reads as undefined and is drawn transparent rather than
  // silently aliasing onto a real class.
  const lut = new Array(256).fill(null);
  (visibleClasses || []).forEach((id) => {
    const color = colorOverrides[id] ?? palette[id]?.color;
    if (!color) return;
    lut[id] = [...hexToRgb(color), palette[id]?.alpha ?? alpha];
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
