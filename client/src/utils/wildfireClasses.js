/**
 * The wildfire layer's own class table.
 *
 * NBAC gives burn perimeters, not a classification, so there is exactly one
 * meaningful value: the rasteriser writes 1 for burned and leaves 0 as nodata.
 *
 * Deliberately not clearcut's taxonomy. An earlier version wrote burned pixels as
 * that model's class 3 (`fire`), which worked but numbered this layer by a model
 * it has no relationship to.
 *
 * The colour here is the fallback; the layer passes its own through
 * colorOverrides.
 */

export const WILDFIRE_CLASSES = {
  0: { name: 'unburned', color: null }, // nodata -- always transparent
  1: { name: 'burned', color: '#F8420B' },
};

/** The burned class -- the one the layer's own color overrides. */
export const WILDFIRE_CLASS_ID = 1;

/** Only one class exists, so it is also the default view. */
export const WILDFIRE_VISIBLE_CLASSES = [WILDFIRE_CLASS_ID];
