/**
 * The 6-class taxonomy the clearcut U-Net predicts, and its map palette.
 *
 * These class IDs come straight from the model's output raster
 * (utils/multiclass_labels.py in boreal-canada-mapping). The old PNG tile
 * pipeline flattened all of this to one flat white before the tiles were even
 * written -- every class but `clearcut` was discarded at tiling time, and
 * `clearcut` itself kept a color rather than a value. Serving COGs preserves
 * the class IDs, so coloring now happens at draw time, and changing a color no
 * longer means regenerating tiles.
 *
 * Data only. The pixel->RGBA machinery lives in rasterClasses.js, because it is
 * shared with layers that have nothing to do with this model -- see
 * wildfireClasses.js.
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
