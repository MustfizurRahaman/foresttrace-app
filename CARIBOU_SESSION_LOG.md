# Caribou habitat work — session record

2026-09-06/07. Written as a handover: what changed, why, what was measured, and
what is still open. Companion docs: `TILE_PERF_NOTES.md` (measurements),
`DEV_SETUP.md` (running it on another machine).

Branch: `feat/caribou-habitat-module`, pushed to `myfork`. `origin` (RSL-SLU)
untouched.

---

## 1. Why the map was blank

The session opened with "the data is not loading like it used to."

The habitat layer requests relative URLs (`/tiles/...`), because
`REACT_APP_TILES_BASE_URL` is deliberately empty — R2's public URL sends no CORS
headers, and `RasterTileLayer` loads tiles with `crossOrigin="anonymous"` so it
can read pixels, so a direct browser fetch is blocked. Something has to make the
request same-origin. That something is `client/src/setupProxy.js`, and it had
been reduced to the 11-line `/api`-only version.

**It was never lost.** `git log --all` showed only two commits ever touching that
file: its creation in June, and a stash. The tile-routing version had lived
exclusively as uncommitted working-tree changes, and `git stash` on 2026-09-04
12:28:17 swept it into `stash@{0}`, which nobody ever popped. The reflog entry
`reset: moving to HEAD` one second later is part of that same stash command, not
a separate action — an early reading of mine that was wrong and worth not
repeating.

The merge that landed on 09-06 was innocent: the code was already in the stash
before it ran.

Recovered with `git stash apply` (not `pop` — the stash is still there).

**Lesson worth keeping:** a clean `git status` is not evidence that nothing is
missing. Config that only ever lives in the working tree is invisible to every
check that would normally catch a loss.

---

## 2. Caribou range mode

Issue #15 asked for range selection in the shared floating FMU panel, and spent
most of its length on the corner cases of mixing a range selection with an FMU
selection. That matrix was avoided by keeping range selection inside the caribou
panel, which is also what #15's own closing line asks for ("effective only for
the caribou module").

Built:

- Seven per-range switches plus "Outline all ranges" and "Habitat for all
  ranges", in a collapsed `<details>` dropdown, switches right-aligned.
- Selecting a range drives the habitat layer from that range rather than from the
  FMU selection. A selected range always draws its own boundary — habitat with no
  outline around it reads as a bug.
- The panel's statistics follow whatever the map is drawing, so the numbers never
  describe something other than what is on screen.

### The correctness bug this exposed

`caribou_tiler_v3.py:354` builds each FMU pyramid from *every* range raster
overlapping that FMU. So `troutlake_2015` contains Berens, Churchill and Sydney
habitat. Range mode's first implementation loaded the FMU pyramids a range spans,
so **selecting Berens also drew Churchill and Sydney** wherever they shared an
FMU. Most FMUs are in two or three ranges; troutlake and whiskeyjack are in
three. This was the normal case, not an edge one.

Fixed by tiling per range instead — see §4.

---

## 3. Colour

The original range palette had Berens bright red and Kesagami bright green. On a
habitat map those read as *bad* and *good*, which a population range is neither.

Replaced with seven hues chosen as a set and validated, not picked by eye. The
validator caught two things that would otherwise have shipped: a brown that
measured as grey (chroma 0.077, below the 0.10 floor), and a sienna/yellow pair
that collapsed in dark mode (ΔE 8.9, below the 15 floor).

Final: blue, orange, violet, magenta, yellow, teal, sienna. Worst adjacent pair
CVD ΔE 16.3 light / 13.2 dark; normal-vision 19.6 / 19.3, against gates of 8
and 15.

Magenta and yellow sit under 3:1 contrast on white, so identity never rests on
colour alone — every swatch carries its name, every outline a tooltip. Seven
categorical colours cannot be mutually distinct in all 21 pairings; that is a
documented limit, and the labels are the mitigation.

Colours live in `CARIBOU_RANGES` (`caribouStats.js`) and override the geojson's
own `color`, so restyling does not mean re-running `make_range_geojson.py`.

---

## 4. Performance

Measured rather than guessed, and several early hypotheses did not survive.

### Source resolution

The MSPA rasters are **30 m**, EPSG:3978. Web Mercator matches 30 m at **z11.7**.
So z12 is the last level carrying real information; z13 is ~2.4x oversampled and
z14 ~4.9x — roughly 24 output pixels per real source pixel.

`caribou_tiler_v3.py` says as much in its own `NATIVE_Z` comment: z14 existed
only because `RasterTileLayer` declared `NATIVE_TILE_ZOOM_LEVELS` up to 14 and
would 404 otherwise.

Capped caribou at `maxNativeZoom` 13 via a per-layer map. z14 is 68% of that
pyramid's tiles and 59% of its bytes, so this unblocks a prune — **which must
wait until the change is deployed**, or production 404s at zoom 14+.

### The actual cause of slow loading

No cache headers. All 600,000 caribou tiles had been uploaded with a
Content-Type and nothing else, so neither the browser nor Cloudflare kept a copy
and every pan refetched from origin — **131 ms for a 937-byte tile**, because the
cost is the round trip, not the bytes. A viewport of ~400 tiles across several
FMU layers spent most of its time on trips it need not make.

Backfilled all 600,000 via `set-cache-headers.js` (CopyObject with
`MetadataDirective: REPLACE` — metadata only, no re-upload). 0 failures, 49.6
min. `--cache-control` added to the uploader so future uploads never repeat this.

The hazard worth remembering: REPLACE drops any header not restated, so
Content-Type had to be supplied again. Getting that wrong would have served every
tile as `application/octet-stream` and blanked the map.

### Hypotheses that were wrong

- **Smaller tiles (128 px).** Tested by re-encoding 300 real tiles: **+21% bytes
  and 4x the requests** for identical pixels. PNG per-file overhead is paid four
  times and the compressor gets less context. 512 px goes the other way: −8.2%
  bytes, 4x fewer requests.
- **Tile resolution as the cause of zoom-out lag.** At z6, 25 regions request 33
  tiles covering **4 unique coordinates** — about 165 KB. There is nothing there
  to cut. The cost was **8.4 MB of per-FMU boundary GeoJSON**, uncapped, while
  raster layers were already capped at 8. A 460 KB `ontario-overview.json` exists
  for exactly this and is disabled at `App.js:495-497` over geometry artifacts.
  **Still the largest unfixed win.**
- **Per-range tiling as a bytes win.** It is not. Berens 2015 at z6-13: 3,395
  tiles / 7.2 MB against 3,405 / 6.0 MB for the six FMU pyramids — slightly
  *more* bytes, since FMU-clipped edge tiles compress better.

### What per-range tiling actually buys

Request counts, concentrated exactly where the slowness was reported:

| zoom | 6 FMU pyramids | 1 range pyramid | change |
|---|---|---|---|
| z6 | 6 | 2 | −67% |
| z7 | 13 | 3 | −77% |
| z8 | 21 | 8 | −62% |
| z11 | 272 | 225 | −17% |
| z13 | 2,175 | 2,349 | **+8%** |
| total | 3,405 | 3,395 | 0% |

Plus 6 Leaflet layers collapsing to 1 (25 to 7 for all ranges) — separate from
tile counts, that is 6 tile grids, request queues and DOM sets becoming one.

Zoomed in it is a wash or marginally worse. And the snappiness while serving from
local disk is partly an artifact: local 38.7 ms vs R2 132 ms per request.

---

## 5. How GFW does it

Checked against their live tiles rather than from memory:

- **One global tileset.** `tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png`
  — no region in the path. Selecting a country is a filter, not another layer.
  This app mounting one layer per FMU is the structural difference.
- **`cache-control: max-age=31536000`**, behind CloudFront (`x-cache: Hit from
  cloudfront`). Identical to what was just backfilled here — except the
  `pub-*.r2.dev` host returns no `cf-cache-status` at all, so edge caching still
  needs a custom domain.
- **RGB-encoded rasters decoded in a WebGL shader**, which is how they animate 25
  years smoothly. Caribou already sidesteps the equivalent cost by being
  pre-coloured.
- **Vector tiles for boundaries**, against 8.4 MB of GeoJSON here.

---

## 6. State

Done: stash recovered; tile routing restored and made portable; range overlay and
per-range switches; validated palette; z13 cap; 600k cache headers; 77 per-range
pyramids (285,511 tiles, 814 MB) built and uploading to
`tiles/wildlife/caribou-range`.

Everything is caribou-scoped. `LAYER_MAX_NATIVE_ZOOM` names only
`caribou-habitat`; the cache backfill defaults to the caribou prefix; per-range
tiles sit under their own prefix behind `REACT_APP_CARIBOU_RANGE_TILES`.
Clearcut, wildfire and biomass were verified unchanged.

### Open, roughly by value

1. **Fix and re-enable the Ontario overview** — 8.4 MB to 460 KB, the app side is
   already built, the work is regenerating the geometry without the artifacts
   that got it disabled. Wants a topology-preserving simplify.
2. **Prune z14** from the caribou pyramid — ~400k files. **Only after the z13 cap
   is deployed.**
3. **Custom domain on R2** — turns on the edge caching `pub-*.r2.dev` will not do.
4. **Re-optimize the PNGs** — ~12.5%, no tradeoff, independent of everything else.
5. **512 px tiles** — best folded into some future re-tile, not done for itself.

Note on #16: the worker fix appears **already implemented** —
`tileWorkerClient.js` exists and `PROCESSED_LAYER_IDS` routes clearcut, wildfire
and biomass through it. Worth re-measuring before spending more there.
