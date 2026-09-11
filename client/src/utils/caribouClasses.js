/**
 * Caribou core-habitat size classes, and the ramp the map draws them with.
 *
 * Values come straight from the MSPA rasters
 * (caribou_tiling/source_sieved_5ha/<range>_core_class5_<year>.tif):
 *
 *   255  NoData -- outside the caribou range, never assessed
 *     0  in range but NOT core habitat
 *   1-5  ordinal patch-size classes
 *
 * 0 and 255 both draw transparent, but they are not the same claim: one says
 * "measured, no core habitat here", the other "never looked". Keeping nodata at
 * 255 rather than folding it onto 0 is what preserves that distinction, and it
 * is why `inRangeHa` can be a denominator at all.
 *
 * The ramp is VIRIDIS_5 -- caribou_tiler_v3.py offers a green alternative but
 * defaults to viridis (`CARIBOU_RAMP`), and viridis is what the shipped tiles
 * carry. It must also match SIZE_BINS in caribouStats.js, which is what the
 * panel legend and the size-share swatches draw from: the map and the legend
 * beside it disagreeing is worse than either choice of ramp.
 *
 * Alpha is per class, mirroring ALPHA_BY_CLASS in the tiler. Class 1 renders at
 * 70 rather than 200 because it is 3x3-erosion speckle -- real pixels, but
 * fragments that size do not support a herd, and in some FMUs they are two
 * thirds of the core total (Nipigon 71%, Berens 67%). At full strength they
 * swamp the habitat that matters.
 *
 * Unlike clearcut and wildfire, no single class stands in for the layer: the
 * whole ramp IS the information, so the layer must not override any one entry.
 */

export const CARIBOU_CLASSES = {
  0: { name: 'In range, not core', color: null },
  1: { name: '< 100 ha', color: '#440154', alpha: 70 },
  2: { name: '100 - 500 ha', color: '#3b528b', alpha: 200 },
  3: { name: '500 - 1,000 ha', color: '#21918c', alpha: 200 },
  4: { name: '1,000 - 10,000 ha', color: '#5ec962', alpha: 200 },
  5: { name: '> 10,000 ha', color: '#fde725', alpha: 200 },
};

/** Every size class. Painting fewer is how a "patches over N ha" filter works. */
export const CARIBOU_VISIBLE_CLASSES = [1, 2, 3, 4, 5];

/** Outside the range -- never assessed. */
export const CARIBOU_NODATA = 255;
