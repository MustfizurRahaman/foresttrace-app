import { useState, useEffect, useRef } from 'react';
import '../styles/infopage.css';

const NAV_ITEMS = [
  { id: 'clearcut',  label: 'Clearcut Detection' },
  { id: 'imagery',   label: 'Satellite Imagery' },
  { id: 'training',  label: 'Training Data' },
  { id: 'model',     label: 'Model Architecture' },
  { id: 'biomass',   label: 'Biomass Estimation' },
  { id: 'tiles',     label: 'Tile Architecture' },
  { id: 'ai',        label: 'AI Assistant' },
  { id: 'stats',     label: 'Area Statistics' },
  { id: 'crs',       label: 'Coordinate System' },
  { id: 'oss',       label: 'Open Source' },
];

function DefTable({ rows }) {
  return (
    <table className="docs-def-table">
      <tbody>
        {rows.map(([term, def]) => (
          <tr key={term}>
            <td>{term}</td>
            <td>{def}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocumentationPage({ onBack }) {
  const [active, setActive] = useState('clearcut');
  const refs   = useRef({});
  const box    = useRef(null);

  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
      },
      { root, rootMargin: '-10% 0px -65% 0px', threshold: 0 },
    );
    Object.values(refs.current).forEach((el) => { if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, []);

  const s = (id) => (el) => { refs.current[id] = el; };
  const go = (id) => refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="infopage" ref={box}>
      <div className="docs-layout">

        {/* ── Left nav ───────────────────────────────────── */}
        <nav className="docs-nav">
          <p className="docs-nav-heading">Contents</p>
          {NAV_ITEMS.map(({ id, label }) => (
            <button
              key={id}
              className={`docs-nav-link${active === id ? ' docs-nav-link--active' : ''}`}
              onClick={() => go(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* ── Content ────────────────────────────────────── */}
        <div className="docs-content">
          <button className="infopage-back" onClick={onBack}>← Back to Map</button>
          <p className="infopage-tag">Documentation</p>
          <h1 className="infopage-title">Technical Documentation</h1>
          <p className="infopage-lead">
            Details on datasets, processing methods, tile architecture, and statistical
            approaches used in the ForestTrace platform.
          </p>
          <hr className="infopage-divider" />

          {/* ── 1. Clearcut Detection ── */}
          <div id="clearcut" ref={s('clearcut')} className="infopage-section">
            <h2>Clearcut Detection</h2>
            <p>
              Annual clearcut mapping uses a 6-class deep-learning segmentation model trained on
              multi-spectral satellite composites. Each year's output is a binary clearcut mask
              stored as XYZ raster tiles and summarised as per-region hectare values with
              precision/recall uncertainty bounds derived from spatially-blocked validation.
            </p>
            <DefTable rows={[
              ['Detection method',  'Supervised semantic segmentation with a compact U-Net encoder-decoder. Each pixel is assigned one of six classes; only the Clearcut class is exported for display.'],
              ['Primary sensor',    'Harmonized Landsat and Sentinel-2 (HLS v2), 30 m, 2016–2024.'],
              ['2025 sensor',       'Planet NICFI PlanetScope, 3 m (separate model and pipeline; see Satellite Imagery section).'],
              ['2015 baseline',     'Landsat 8 OLI only, 30 m; single-sensor, not directly comparable to HLS years.'],
              ['Temporal range',    '2010–2025 (annual). Pre-HLS years (2010, 2015) use older sensors and are labelled in the in-app timeline accordingly.'],
              ['Output',            'Binary clearcut mask per year, stored as PNG tiles (XYZ scheme, zoom 6–14), clipped to FMU boundaries.'],
              ['Accuracy',          'Per-year precision, recall, F1, and IoU are stored alongside area values. Typical F1: 0.77–0.89 across HLS years (2016–2024). Uncertainty bars in the timeline are asymmetric: lower bound from precision, upper from recall.'],
            ]} />

            <p className="docs-subsection-title">Annual vs accumulated</p>
            <p>
              The timeline stacks two quantities that partition the accumulated total exactly.
              <strong> New clearcut</strong> is area standing this year that was not standing last
              year; <strong>historical</strong> is area that was already standing and still is.
              Together they sum to <strong>accumulated</strong> — standing clearcut as of that year.
            </p>
            <p>
              A third series, the raw per-year classification, records every pixel the model
              judged cut-looking in that year. It is not shown in the timeline: most of those
              pixels were already standing clearcut from earlier years, so plotting it against
              accumulated would conceal how much was genuinely new.
            </p>

            <p className="docs-subsection-title">The accumulation rule</p>
            <p>
              A pixel counts as standing clearcut when it was detected in{' '}
              <strong>two consecutive years</strong> inside a rolling 5-year window, or when it was
              detected in the current year. Regrowth therefore drops out instead of accumulating
              forever, and a single-year detection — what a false positive looks like — cannot
              enter on its own.
            </p>
            <p>
              Corroboration must be consecutive rather than merely twice in the window: a pixel seen
              in 2019 and again in 2023 does not vouch for the four years between. Expiry follows
              from the window — a pair stops qualifying once its earlier year falls outside it. The
              newest year is the exception, admitted uncorroborated because no later year exists yet
              to confirm it; that year therefore carries the full single-year false-positive rate,
              which its error bars reflect.
            </p>
            <p>
              Early years draw on fewer than five years of observations and read low for that reason
              alone. They are shaded in the timeline rather than hidden — they are real
              measurements, just not readable as a trend against mature years. Compare unshaded
              years, or use the new-clearcut series.
            </p>

            <p className="docs-subsection-title">Sensor comparability</p>
            <p>
              2010 and 2015 used <strong>Landsat 8 OLI only</strong> and are not spectrally
              harmonized with HLS (2016 onward). Their area estimates are not directly comparable to
              later years and are excluded from the trend fit. 2015 additionally serves as the
              baseline of the accumulated series, and 2010 has no adjacent year in the record
              (2011–2014 do not exist), so it can never be corroborated and stands alone.
            </p>
          </div>

          <hr className="infopage-divider" />

          {/* ── 2. Satellite Imagery & Basemaps ── */}
          <div id="imagery" ref={s('imagery')} className="infopage-section">
            <h2>Satellite Imagery &amp; Basemaps</h2>
            <p>
              Training and inference use raw satellite composites processed by the research team.
              The in-app basemap is sourced separately and is{' '}
              <strong>not</strong> guaranteed to match the imagery used for model training or
              inference.
            </p>

            <p className="docs-subsection-title">HLS v2 — Primary sensor (2016–2024)</p>
            <DefTable rows={[
              ['Product',       'Harmonized Landsat and Sentinel-2 (HLS) v2, NASA LP DAAC (HLSS30 / HLSL30).'],
              ['Sensors',       'Sentinel-2 MSI (10–20 m native) + Landsat 8/9 OLI (30 m native), resampled to a common 30 m grid.'],
              ['Compositing',   'Annual spring median composite (March 16 – May 31). Cloud-masked at scene level (≤ 30–45 % cloud cover) and at pixel level using the HLS QA_PIXEL band before compositing.'],
              ['Bands used',    'Blue (B02), Green (B03), Red (B04), NIR (B08), SWIR1 (B11), SWIR2 (B12) — 6 bands total. Reflectance scale: DN ÷ 10 000.'],
              ['Label cleaning','Per-stand K-means (2 clusters) on NBR = (NIR − SWIR2) / (NIR + SWIR2) to isolate spectrally pure pixels within training polygons before chip extraction.'],
            ]} />

            <p className="docs-subsection-title">Planet NICFI PlanetScope — 2025</p>
            <DefTable rows={[
              ['Programme',     "Norway's International Climate and Forests Initiative (NICFI) via Planet Labs."],
              ['Sensor',        'PlanetScope (PSScene), 3 m native resolution.'],
              ['Bands used',    'Blue, Red, NIR — 4-band product (no SWIR available). Label cleaning uses NDVI = (NIR − Red) / (NIR + Red) in place of NBR.'],
              ['Coverage',      '~2.3 billion pixels over the Wabigoon FMU (~35 GB float32). Inference uses windowed rasterio disk reads to avoid memory limits.'],
              ['CRS',           'EPSG:32615 (UTM Zone 15N) — differs from HLS tiles which use EPSG:32616 (Zone 16N).'],
            ]} />

            <p className="docs-subsection-title">Landsat 8 OLI — 2015 baseline</p>
            <DefTable rows={[
              ['Sensor',  'Landsat 8 OLI, Collection-2 SR, 30 m; 16-day revisit (not the harmonised ~5-day revisit of HLS).'],
              ['Note',    'Single-sensor baseline year. Results are not directly comparable to HLS years due to differences in revisit frequency, compositing methodology, and cross-calibration status.'],
            ]} />

            <p className="docs-subsection-title">In-App Basemap Sources</p>
            <div className="infopage-callout">
              <p>
                The background satellite imagery displayed in the app is provided for visual
                orientation only. It is <strong>not</strong> the same imagery used to train or run
                the clearcut models. Training used raw HLS composites from NASA Earthdata and Planet
                NICFI mosaics — neither of which is displayed directly in the app.
              </p>
            </div>
            <DefTable rows={[
              ['2018–2024',       'EOX Sentinel-2 cloudless composites (tiles.maps.eox.at) — annually updated, cloud-free mosaics from the Copernicus Sentinel-2 programme.'],
              ['Other years',     'Esri World Imagery — high-resolution commercial mosaic with no guaranteed date match to the selected year.'],
              ['Training source', 'Raw HLS composites accessed via NASA Earthdata (earthaccess library); Planet NICFI mosaics via NICFI API. Neither source is publicly viewable in the basemap.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 3. Training Data & Ontario Datasets ── */}
          <div id="training" ref={s('training')} className="infopage-section">
            <h2>Training Data &amp; Ontario Datasets</h2>
            <p>
              Training labels are derived from provincial geospatial datasets maintained by the
              Ontario Ministry of Natural Resources and Forestry (MNRF) and related agencies.
              Labels are spatially cleaned using per-stand unsupervised clustering before chip
              extraction, and validation is done with spatial blocking to prevent data leakage.
            </p>
            <DefTable rows={[
              ['Forest — FRI',
               'Ontario Forest Resource Inventory (FRI) stand-level polygons. Positive forest samples selected from stands with DEVSTAGE ∈ {FTGNAT, FTGPLANT, FTGSEED} and YRDEP < 2000. Survey vintage: 2008–2012.'],
              ['Clearcut — harvest blocks',
               'Ontario Annual Report harvest block layer (MNRF). Samples from SILVSYS = "CC" (clearcut) and HARVCAT = "REGULAR", AR_YEAR 2002–2024. Covers all of Ontario.'],
              ['Fire disturbance',
               'Ontario Fire Disturbance Area service (MNRF / Land Information Ontario WFS). Actively updated polygon layer; samples drawn from fires within a 6-year recency window of the target year.'],
              ['FMU boundaries',
               'Forest Management Unit (FMU) polygons from MNRF — used to clip tile outputs and define the denominator for clearcut percentage calculations in the app.'],
              ['Label quality control',
               'Each training polygon is split into 2 clusters via K-means on spectral indices (NBR for HLS; NDVI for Planet). Only the cluster whose mean matches the expected class signature is retained, reducing mislabelled pixels from stand boundary errors.'],
              ['Chip extraction',
               '224 × 224 px chips. Spatial validation split on 4 × 4 chip blocks (896 × 896 px); 20 % of blocks assigned to validation so no adjacent chips straddle the train/val boundary.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 4. Model Architecture ── */}
          <div id="model" ref={s('model')} className="infopage-section">
            <h2>Model Architecture</h2>
            <p>
              A compact U-Net (SimpleUNet) performs per-pixel semantic segmentation. Separate
              model instances are trained per year and sensor to account for spectral differences,
              cloud patterns, and land-cover change through time.
            </p>
            <DefTable rows={[
              ['Architecture',
               'SimpleUNet — encoder-decoder with skip connections. 3 encoder blocks (32 → 64 → 128 channels), 1 bottleneck (256 channels), 3 decoder blocks with transposed convolutions (stride 2) and concatenated skip connections. 1 × 1 final convolution to class logits.'],
              ['Block structure',
               '2 × [Conv2d(3 × 3) + BatchNorm2d + ReLU] per block.'],
              ['Input',
               '6-band HLS chip (224 × 224 px); 4-band PlanetScope chip for 2025.'],
              ['Output classes',
               '6 — Background (0), Forest (1), Clearcut (2), Fire (3), Water (4), Other (5). Only Clearcut pixels are exported for display.'],
              ['Loss',
               'CrossEntropyLoss with ignore_index = 0 (Background excluded from gradient). Inverse-frequency class weights, capped at 5.0, to handle class imbalance.'],
              ['Optimizer',
               'AdamW (lr = 1 × 10⁻³, weight_decay = 1 × 10⁻⁴). 30 training epochs. Best checkpoint selected by validation F1 on the Clearcut class.'],
              ['Inference',
               'Sliding window — 224 × 224 px, stride 224 (non-overlapping). Planet composites use windowed rasterio reads from disk due to file size.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 5. Biomass Estimation ── */}
          <div id="biomass" ref={s('biomass')} className="infopage-section">
            <h2>Biomass Estimation</h2>
            <DefTable rows={[
              ['Data source',         'SAR (Synthetic Aperture Radar) and optical imagery fusion.'],
              ['Variable',            'Above-Ground Biomass (AGB) in Mg/ha.'],
              ['Spatial resolution',  '30 m.'],
              ['Method',              'Machine-learning regression calibrated against field plots and airborne LiDAR.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 6. Tile Architecture ── */}
          <div id="tiles" ref={s('tiles')} className="infopage-section">
            <h2>Tile Architecture</h2>
            <DefTable rows={[
              ['Format',          'PNG tiles following the XYZ tile scheme.'],
              ['Zoom levels',     '6 – 14.'],
              ['Hosting',         'Tiles served from Cloudflare R2 via a public bucket URL.'],
              ['URL pattern',     'tiles/<layer>/<region>_<year>/<z>/<x>/<y>.png'],
              ['Sensor subfolders','For years with multiple sensors (e.g. 2025), tiles are stored under hls/ or planet/ subfolders within the year directory.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 7. Forestry AI Assistant ── */}
          <div id="ai" ref={s('ai')} className="infopage-section">
            <h2>Forestry AI Assistant</h2>
            <DefTable rows={[
              ['Provider',        'Groq — a high-throughput LPU (Language Processing Unit) inference platform.'],
              ['Model',           'Meta Llama 3.1 8B Instant (llama-3.1-8b-instant) — an 8-billion parameter instruction-tuned model optimised for low-latency responses.'],
              ['Context injection','Each request includes the active module, selected year, sensor, and region so the model can ground its answers in the current map state.'],
              ['Max tokens',      '1 024 tokens per response.'],
              ['Logging',         'User queries are logged to MongoDB Atlas for research and quality-improvement purposes.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 8. Area Statistics ── */}
          <div id="stats" ref={s('stats')} className="infopage-section">
            <h2>Area Statistics</h2>
            <DefTable rows={[
              ['Pixel counting',
               'Clearcut area is computed by counting red-channel pixels (red > 200, green < 100) in clearcut tiles at zoom 12, then converting to hectares using the latitude-adjusted pixel size.'],
              ['Pixel size at zoom 12',
               '≈ 38.2 m at the equator; adjusted by cos(latitude) for the Wabigoon area (~50°N), yielding ~24.6 m per pixel.'],
              ['Region area',
               'FMU boundary area is computed from the GeoJSON polygon using the spherical shoelace formula (WGS-84 Earth radius), providing a fixed denominator independent of the map viewport.'],
              ['Clearcut %',
               'Clearcut hectares ÷ FMU area hectares × 100. Region-relative — independent of zoom level or viewport position.'],
              ['Precomputation',
               'Per-region hectare values are stored in clearcut_stats.json and committed to the repository so the app works without re-running tile scripts at startup. Accuracy metrics (precision/recall/F1 per year) are stored alongside area values under <region>_<sensor>_accuracy.'],
            ]} />
          </div>

          <hr className="infopage-divider" />

          {/* ── 9. Coordinate System ── */}
          <div id="crs" ref={s('crs')} className="infopage-section">
            <h2>Coordinate Reference System</h2>
            <p>
              All spatial data is served in Web Mercator (EPSG:3857) for map tile compatibility.
              Area calculations account for the latitude-dependent pixel size distortion inherent to
              Web Mercator. Processing CRS: EPSG:32616 (UTM Zone 16N) for HLS data;
              EPSG:32615 (UTM Zone 15N) for Planet 2025 data.
            </p>
          </div>

          {/* ── 10. Open Source ── */}
          <div id="oss" ref={s('oss')} className="infopage-section">
            <h2>Open Source</h2>
            <div className="infopage-callout">
              <p>
                ForestTrace is built with React, Leaflet, Recharts, and react-leaflet. The AI
                assistant runs on Groq inference with Meta Llama 3.1 8B. Processing pipelines use
                Python with rasterio, GDAL, and Google Earth Engine. Source code availability will
                be announced alongside the associated publication.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DocumentationPage;
