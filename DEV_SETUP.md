# Running ForestTrace on a second machine

Written while moving the caribou work from a Windows box to a Mac. Three things
do not travel with a `git clone`, and each has to be handled deliberately.

---

## 1. Code — push, then clone

Local commits live on one machine until they are pushed. Push the working branch
to your fork (not `origin`, which is the lab repo):

```bash
git push myfork feat/caribou-habitat-module
```

Then on the other machine:

```bash
git clone https://github.com/MustfizurRahaman/foresttrace-app.git
cd foresttrace-app
git checkout feat/caribou-habitat-module
npm install
cd client && npm install
```

Node 18+ works; the repo was last run on 18.20.4.

---

## 2. Secrets and local config — copy by hand

`.env.r2` and `client/.env` are gitignored, so they are absent after a clone and
have to be recreated. That is deliberate — one holds credentials, the other
holds absolute paths that are wrong anywhere else.

**`.env.r2`** (repo root) — only needed to run the tile upload scripts, not to
run the app. Copy `.env.r2.example` and fill it from the Cloudflare dashboard,
or copy the file across by hand.

**`client/.env`** — start from `client/.env.template`. The important part is
what to leave *out*: every `*_TILES_DIR` is optional, and unset means the layer
is fetched from R2 instead of disk. A machine with no local pyramids should set
none of them, which is also the closest thing to what production serves.

A minimal working `client/.env` on a second machine:

```
REACT_APP_GOOGLE_MAPS_API_KEY=<your key>
REACT_APP_CARIBOU_RANGE_TILES=true
```

The flag is what makes range mode ask for the per-range pyramids. It only works
if those tiles are in R2 (see below); without them, drop the flag and range mode
falls back to the per-FMU tiles.

---

## 3. Tiles — the part that does not fit in git

Tile pyramids are hundreds of thousands of files and are gitignored. There are
two ways to get a second machine drawing them.

**Preferred: serve everything from R2.** Set no `*_TILES_DIR` at all. Every
layer then proxies to the bucket through `setupProxy.js`, so nothing has to be
copied and both machines see the same tiles. This requires the per-range
pyramids to have been uploaded:

```bash
node upload-tiles-bulk.js <local-range-dir> tiles/wildlife/caribou-range --cache-control
```

`--cache-control` matters. Without it, tiles arrive with no cache headers and
every pan refetches them from the origin — about 131 ms for a tile under 1 KB,
since the cost is the round trip rather than the bytes.

**Alternative: copy the pyramids.** Only worth it for a pyramid being actively
regenerated, where uploading each iteration would be slower than reading it off
disk. Copy the directory, then point the matching var at it using that machine's
path — `/Users/you/data/...` on a Mac, not `F:/...`.

Directories currently in use on the Windows machine:

| Variable | Contents |
|---|---|
| `CARIBOU_RANGE_TILES_DIR` | per-range caribou pyramids, 77 sets, ~814 MB |
| `CARIBOU_TILES_DIR` | per-FMU caribou pyramids (also in R2) |
| `WILDFIRE_TILES_DIR` | NBAC wildfire pyramids (also in R2) |
| `WILDFIRE_BASELINE_TILES_DIR` | pre-simplification wildfire set, local verification aid only |

---

## 4. Run it

```bash
cd client && npm start          # http://localhost:3000
```

The ForestryAI panel additionally needs the Express server, which nothing else
depends on:

```bash
node index.js                   # port 3001
```

---

## Checking it worked

Tiles are the thing most likely to be misconfigured, and a blank layer looks the
same whether the URL is wrong or the data is missing. Ask the dev server
directly rather than squinting at the map:

```bash
curl -I http://localhost:3000/tiles/wildlife/caribou-range/range_berens_2025/11/482/669.png
```

- `200` with `content-type: image/png` — working.
- `404` — the layer has no local directory and no copy in the bucket. Check
  whether the prefix was uploaded before assuming the path is wrong.

The Python tiling scripts under `caribou_tiling/code/` are a separate concern:
they need `geopandas`, `rasterio`, `shapely` and `Pillow`, and are only required
to regenerate pyramids, never to run the app.
