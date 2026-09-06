# Tile & boundary performance — findings, changes, and follow-ups

Working notes from a 2026-09-06 investigation into slow map loading. Kept so the
open items can be filed as GitHub issues with the evidence attached.

Related existing issues: #9 (wildfire tile lag), #10 (caribou module), #15
(caribou range in FMU panel), #16 (per-tile recoloring on main thread).

---

## Measurements

All figures measured, not estimated. Reproduction commands are in each section.

### Source resolution

Read from `outputs_v3/05_mspa_simplified/berens_core_class5_2015.tif`:

| Property | Value |
|---|---|
| Pixel size | **30 x 30 m** |
| CRS | EPSG:3978 (Canada Atlas Lambert) |
| Size | 6393 x 6938, uint8, nodata 255 |

Web Mercator ground resolution at 50N vs that 30 m source:

| Zoom | m/px @ 50N | vs source |
|---|---|---|
| z11 | 49.1 | 1.6x coarser |
| z12 | 24.6 | 1.2x oversampled |
| z13 | 12.3 | 2.4x oversampled |
| z14 | 6.1 | **4.9x oversampled** |

Mercator matches 30 m exactly at **z11.7**. Everything past z12 is
interpolation; z14 manufactures ~24 output pixels per real source pixel.

`caribou_tiler_v3.py` already says this in its `NATIVE_Z` comment — z14 was
built solely because `RasterTileLayer.jsx` requested native tiles there.

### Pyramid cost by zoom (`abitibiriver_2015`)

| Zoom | Tiles | Size |
|---|---|---|
| z14 | 7,292 | 14.17 MB |
| z13 | 2,318 | 5.88 MB |
| z6-z12 | 1,048 | 3.97 MB |

**z14 = 68% of tiles, 59% of bytes.** Across 253 region-years that is roughly
400k of the ~600k files in `caribou_v3_sieved`.

### Tile size: 128 vs 256 vs 512

One 256 px tile covers identical ground to four 128 px tiles, so tile size is a
repackaging choice, not a resolution one. Re-encoded 300 real z13 tiles:

| Encoding | Total | Files |
|---|---|---|
| On disk now (256 px) | 781.1 KB | 300 |
| Re-encoded 256 px, `optimize=True` | 683.5 KB | 300 |
| Re-encoded 128 px | 827.2 KB | 1,200 |

Merging 150 fully-populated 2x2 blocks into 512 px tiles:

| Encoding | Total | Files |
|---|---|---|
| 256 px | 1,593.9 KB | 600 |
| 512 px | 1,463.7 KB | 150 |

- **128 px: +21% bytes, 4x the requests.** PNG per-file overhead is paid four
  times over and the compressor gets less context. Rejected.
- **512 px: -8.2% bytes, 4x fewer requests.** Worth pursuing.
- **Re-optimizing existing 256 px PNGs: -12.5%** with no other change.

### Zoom-out slowness is boundary vectors, not tiles

At low zoom there is almost nothing to fetch — 25 regions at z6 produce 33 tile
requests covering only **4 unique tiles** (8.2x duplication, ~165 KB total).

The cost is `RegionBoundaries` in `App.js`, which fetches full-detail GeoJSON per
selected FMU with no cap:

| FMU | Size |
|---|---|
| wabigoon | 1,109 KB |
| ogoki | 549 KB |
| englishriver | 490 KB |
| troutlake | 258 KB |

8 FMUs = 2.68 MB, so **all 25 ~= 8.4 MB** — roughly 50x the tile payload, and
far more expensive per byte (JSON.parse plus thousands of SVG paths).

Raster layers are already capped at 8 regions
(`RASTER_MULTI_FMU_SOFT_LIMIT`, `App.js:80`). Boundaries are not.

A 460 KB consolidated `ontario-overview.json` exists for exactly this case but is
switched off at `App.js:495-497`:

```js
// Disable overview mode for now because the current simplified overview geometry
// introduces visible boundary artifacts at Ontario-wide scale.
const useOntarioOverview = false;
```

---

## Changed

### Per-layer native zoom cap (`RasterTileLayer.jsx`)

`NATIVE_TILE_ZOOM_LEVELS` was one global constant applied to every layer, so
every pyramid had to be built to z14. Added `LAYER_MAX_NATIVE_ZOOM` plus a
`maxNativeZoomFor(layerId)` helper, and set `caribou-habitat` to **13**.

Past z13 Leaflet upscales the last native level, which is visually identical
because the extra detail was never in the source. Other layers are unchanged.

This is the app-side half of dropping z14 — it stops the requests. The bucket
prune is a separate step, and **must happen after this ships** (see below).

---

## Follow-ups (candidate issues)

### 1. Prune z14 from the caribou pyramid — blocked on deploy

Reclaims ~400k files and ~59% of the caribou pyramid's bytes.

**Sequencing matters.** Production's deployed bundle still requests native tiles
at z14. Pruning before the change above is deployed makes production 404 at
zoom 14+. Order: ship the app change, verify in production, then prune.

Run: `node upload-tiles-bulk.js <local-dir> tiles/wildlife/caribou --prune`
after regenerating locally with `CARIBOU_NATIVE_Z=13`. The `--prune` flag was
written for exactly this (new pyramid smaller than the one it replaces).

### 2. Fix and re-enable the Ontario overview — biggest win for zoom-out

8.4 MB -> 460 KB (18x) and collapses 25 SVG path sets into one. The app side is
already built; the work is regenerating the overview geometry without the
artifacts that got it disabled. Likely wants a topology-preserving simplify
(`simplify_region_geometries.py`) so shared FMU edges stay coincident and do not
open slivers. Consider also capping boundary detail by zoom.

### 3. Re-optimize existing PNGs — no tradeoff

~12.5% across the pyramid via `oxipng`/`pngquant`. No resolution, zoom, or code
change; output is visually identical. Can be done independently of everything
else, though it is a full re-upload.

### 4. Move to 512 px tiles — larger job

-8.2% bytes, 4x fewer requests, and 4x less per-tile client overhead. Needs a
full re-tile plus `tileSize: 512` in `RasterTileLayer.jsx` (the app currently
sets nothing and gets Leaflet's 256 default). Best bundled with any future
re-tile rather than done for its own sake.

### 5. Range-wide stats for the caribou module

The habitat raster is **already clipped to the caribou ranges** (255 = outside
range, never assessed), and the source rasters are named per range
(`berens_core_class5_2015.tif`). FMU tiling is packaging, not science — so no
re-tiling is needed to show a range.

The blocker is `caribou_stats.json`, which is keyed by FMU. `coreHa` is the
FMU's total, so FMUs straddling two ranges cannot be split after the fact.
Fix: run the existing zonal stats in `caribou_stats_v3.py` with the range
polygons as zones and emit a second range-keyed block. That script already notes
the 7 ranges are spatially disjoint, so there is no double-counting.

Re #15: keeping range selection in the caribou panel rather than the shared
floating FMU panel avoids the FMU-vs-range overlap corner cases entirely, and
matches that issue's own "effective only for the caribou module" constraint.

### Note on #16

The worker fix appears to be **already implemented** — `tileWorkerClient.js`
exists and `PROCESSED_LAYER_IDS` routes clearcut, wildfire, and biomass through
it. Caribou skips recoloring outright (`RasterTileLayer.jsx`, `handleTileLoad`)
since its tiles are pre-coloured. Worth re-measuring before doing more there.
