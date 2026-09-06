import { useState, useEffect, useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ErrorBar,
} from 'recharts';
import {
  computeClearcutAreaPerYear,
  computeAnnualClearcutAreaPerYear,
  getAnnualYearsWithData,
  getClearcutAccuracy,
  DEFAULT_CLEARCUT_SENSOR,
} from '../utils/clearcutAreaStats';
import { DATA_BASE_URL } from '../config';

const CLEARCUT_YEARS = [2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// Years that used Landsat 8 OLI only — not spectrally harmonized with HLS.
// Values are not directly comparable to HLS years (2016+).
const LANDSAT_ONLY_YEARS = new Set([2010, 2015]);

// Fallback uncertainty used for years without validation notebooks (±15% HLS benchmark).
const FALLBACK_UNCERTAINTY = 0.15;

function XAxisTick({ x, y, payload }) {
  const isLandsatOnly = LANDSAT_ONLY_YEARS.has(Number(payload.value));
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0} y={0} dy={10}
        textAnchor="end"
        transform="rotate(-45)"
        fill={isLandsatOnly ? '#f59e0b' : 'currentColor'}
        fontSize={10}
      >
        {payload.value}{isLandsatOnly ? '*' : ''}
      </text>
    </g>
  );
}

// Spherical shoelace formula — returns area in hectares for a GeoJSON
// FeatureCollection or Feature (Polygon or MultiPolygon).
function computeGeoJsonAreaHa(geoJson) {
  if (!geoJson) return null;
  const R = 6371000; // Earth radius in metres
  const features = geoJson.type === 'FeatureCollection' ? geoJson.features : [geoJson];
  let totalM2 = 0;
  for (const feature of features) {
    const geom = feature?.geometry;
    if (!geom) continue;
    const rings = geom.type === 'Polygon'
      ? [geom.coordinates[0]]
      : geom.type === 'MultiPolygon'
        ? geom.coordinates.map(p => p[0])
        : [];
    for (const ring of rings) {
      if (ring.length < 3) continue;
      let area = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const dLng = (ring[i + 1][0] - ring[i][0]) * Math.PI / 180;
        const phi1 = ring[i][1]     * Math.PI / 180;
        const phi2 = ring[i + 1][1] * Math.PI / 180;
        area += dLng * (Math.sin(phi1) + Math.sin(phi2));
      }
      totalM2 += Math.abs(area * R * R / 2);
    }
  }
  return totalM2 / 10000;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sumX  = points.reduce((s, p) => s + p.x, 0);
  const sumY  = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY  = sumY / n;
  const ssTot  = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes  = points.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const rSquared = ssTot < 1 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, rSquared };
}

function ClearcutDetection({ data }) {
  const [yearlyStats, setYearlyStats] = useState(null);
  const [annualDataYears, setAnnualDataYears] = useState(new Set());
  const [accuracy, setAccuracy] = useState({});
  const [regionAreaHa, setRegionAreaHa] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  // Stable string key for the selected FMU list — used as effect dependency.
  const regionsKey = (Array.isArray(data?.selectedFMUs) && data.selectedFMUs.length > 0
    ? data.selectedFMUs
    : ['wabigoon']
  ).join(',');

  const regions = useMemo(() => regionsKey.split(','), [regionsKey]);

  const selectedSensor = data?.selectedSensor ?? DEFAULT_CLEARCUT_SENSOR;
  const selectedYear   = data?.selectedYear;

  // Sum GeoJSON areas for all selected regions.
  useEffect(() => {
    setRegionAreaHa(null);
    Promise.all(
      regions.map(r =>
        fetch(`${DATA_BASE_URL}/data/regions/${r}.json`)
          .then(res => res.ok ? res.json() : null)
          .then(geoJson => geoJson ? computeGeoJsonAreaHa(geoJson) : 0)
          .catch(() => 0)
      )
    ).then(areas => {
      const total = areas.reduce((sum, a) => sum + (a ?? 0), 0);
      if (total > 0) setRegionAreaHa(total);
    });
  }, [regionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sum clearcut stats across all selected regions.
  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    Promise.all(
      regions.map(r =>
        Promise.all([
          computeClearcutAreaPerYear(r, CLEARCUT_YEARS, null, selectedSensor),
          computeAnnualClearcutAreaPerYear(r, CLEARCUT_YEARS, selectedSensor),
          getAnnualYearsWithData(r, selectedSensor),
          getClearcutAccuracy(r, selectedSensor),
        ])
      )
    )
      .then(results => {
        // Sum accumulated and annual ha across all regions per year.
        const accumulated = {};
        const annual = {};
        CLEARCUT_YEARS.forEach(y => {
          accumulated[y] = results.reduce((sum, [acc]) => sum + (acc[y] ?? 0), 0);
          annual[y]      = results.reduce((sum, [, ann]) => sum + (ann[y] ?? 0), 0);
        });

        // Intersection of annual data years — trend only covers years where
        // ALL selected regions have comparable annual detection data.
        const dataYears = results.reduce(
          (inter, [,, years]) => new Set([...inter].filter(y => years.has(y))),
          results[0][2]
        );
        setAnnualDataYears(dataYears);

        // Average accuracy metrics across regions that have validation data.
        const mergedAccuracy = {};
        CLEARCUT_YEARS.forEach(y => {
          const yearAccs = results.map(([,,, acc]) => acc[String(y)]).filter(Boolean);
          if (yearAccs.length > 0) {
            mergedAccuracy[String(y)] = {
              precision: yearAccs.reduce((s, a) => s + a.precision, 0) / yearAccs.length,
              recall:    yearAccs.reduce((s, a) => s + a.recall, 0) / yearAccs.length,
              f1:        yearAccs.reduce((s, a) => s + a.f1, 0) / yearAccs.length,
              iou:       yearAccs.reduce((s, a) => s + a.iou, 0) / yearAccs.length,
            };
          }
        });
        setAccuracy(mergedAccuracy);

        setYearlyStats(
          CLEARCUT_YEARS.map(y => {
            const totalHa      = parseFloat((accumulated[y] ?? 0).toFixed(1));
            const annualHa     = parseFloat((annual[y] ?? 0).toFixed(1));
            const historicalHa = parseFloat(Math.max(0, totalHa - annualHa).toFixed(1));
            return { year: y.toString(), historical: historicalHa, annual: annualHa };
          })
        );
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [regionsKey, selectedSensor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Linear regression over annual clearcut values (non-zero years only).
  const trend = useMemo(() => {
    if (!yearlyStats || annualDataYears.size < 2) return null;
    const pts = yearlyStats
      .map(d => ({ x: parseInt(d.year), y: d.historical + d.annual }))
      .filter(p => annualDataYears.has(p.x));
    if (pts.length < 2) return null;
    return linearRegression(pts);
  }, [yearlyStats, annualDataYears]);

  const chartData = useMemo(() => {
    const base = yearlyStats ?? CLEARCUT_YEARS.map(y => ({
      year: y.toString(), historical: 0, annual: 0,
    }));
    return base.map(d => {
      const yr  = parseInt(d.year);
      const acc = accuracy[String(yr)];
      // Asymmetric error bars derived from per-year precision/recall:
      //   lower error = annualHa × (1 − precision)  — false positives inflate the count
      //   upper error = annualHa × (1/recall − 1)   — missed pixels deflate the count
      // Falls back to ±FALLBACK_UNCERTAINTY when no validation data exists for the year.
      const lowerErr = acc
        ? parseFloat((d.annual * (1 - acc.precision)).toFixed(1))
        : parseFloat((d.annual * FALLBACK_UNCERTAINTY).toFixed(1));
      const upperErr = acc
        ? parseFloat((d.annual * (1 / acc.recall - 1)).toFixed(1))
        : parseFloat((d.annual * FALLBACK_UNCERTAINTY).toFixed(1));
      return {
        ...d,
        annualError: [lowerErr, upperErr],
        accF1: acc?.f1 ?? null,
        trendLine: trend && annualDataYears.has(yr)
          ? parseFloat(Math.max(0, trend.intercept + trend.slope * yr).toFixed(1))
          : undefined,
      };
    });
  }, [yearlyStats, accuracy, trend, annualDataYears]);

  const hasData = yearlyStats && yearlyStats.some(d => d.historical > 0 || d.annual > 0);

  const clearcutPercent = useMemo(() => {
    if (!yearlyStats || !regionAreaHa || !selectedYear) return null;
    const row = yearlyStats.find(d => d.year === String(selectedYear));
    if (!row) return null;
    const totalHa = row.historical + row.annual;
    if (totalHa <= 0) return null;
    return ((totalHa / regionAreaHa) * 100).toFixed(1);
  }, [yearlyStats, regionAreaHa, selectedYear]);

  const trendColor = trend?.slope >= 0 ? '#e53e3e' : '#38a169';

  return (
    <div className="clearcut-module">
      <div className="module-section">
        <h3>Detection Results ({selectedYear})</h3>
        {clearcutPercent !== null ? (
          <div className="stat-item">
            <div className="stat-label">Clearcut Area</div>
            <div className="stat-value">{clearcutPercent}%</div>
            <div className="stat-bar">
              <div className="stat-fill" style={{ width: `${Math.min(100, clearcutPercent)}%` }} />
            </div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
              of total FMU area
              {regionAreaHa && ` (${(regionAreaHa / 1000).toFixed(0)}k ha)`}
            </div>
          </div>
        ) : (
          <p className="no-data">
            {regionAreaHa === null ? 'Loading region boundary…' : 'No clearcut data for this region/year.'}
          </p>
        )}
      </div>

      <div className="module-section">
        <h3>Annual vs Accumulated Clearcut Area — Timeline</h3>
        {loading && <div className="biomass-chart-status">Loading…</div>}
        <div className="biomass-chart">
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ left: 0, right: 12, top: 6, bottom: 4 }}>
              <XAxis
                dataKey="year"
                tick={<XAxisTick />}
                interval={0}
                height={40}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}
                label={{ value: 'ha', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 11 } }}
                width={42}
              />
              <Tooltip
                formatter={(v, name, props) => {
                  const fmt = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
                  if (name === 'trendLine') return [`${fmt(v)} ha`, 'Forest loss trend'];
                  if (name === 'annual') {
                    const acc = accuracy[props.payload?.year];
                    const note = acc
                      ? `F1=${acc.f1.toFixed(2)}, P=${acc.precision.toFixed(2)}, R=${acc.recall.toFixed(2)}`
                      : `±${(FALLBACK_UNCERTAINTY * 100).toFixed(0)}% (estimated)`;
                    return [`${fmt(v)} ha  [${note}]`, 'New clearcut'];
                  }
                  return [`${fmt(v)} ha`, 'Historical'];
                }}
                labelFormatter={label => `Year ${label}`}
                labelStyle={{ fontSize: 12 }}
                itemStyle={{ fontSize: 12 }}
              />
              <Bar dataKey="historical" stackId="a" fill="#ff4444" name="historical" />
              <Bar dataKey="annual" stackId="a" fill="#FFD700" name="annual" radius={[2, 2, 0, 0]}>
                <ErrorBar dataKey="annualError" width={3} strokeWidth={1.5} stroke="#a07800" direction="y" />
              </Bar>
              {trend && (
                <Line
                  dataKey="trendLine"
                  type="linear"
                  stroke={trendColor}
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  name="trendLine"
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {trend && (
          <div style={{ fontSize: 11, marginTop: 4 }}>
            <span style={{ color: trendColor }}>
              {trend.slope >= 0 ? '▲ Forest loss increasing' : '▼ Forest loss decreasing'}{' '}
              · {Math.abs(trend.slope).toFixed(0)} ha/yr &nbsp;(R²={trend.rSquared.toFixed(2)})
            </span>
          </div>
        )}

        {fetchError && (
          <div className="biomass-chart-status">Could not load clearcut_stats.json — check console.</div>
        )}
        {!fetchError && !hasData && !loading && (
          <div className="biomass-chart-status">No clearcut tile data found for this region.</div>
        )}
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          Area from leaf-level tiles · {selectedSensor.toUpperCase()}
          · Error bars: precision/recall from validation notebooks (fallback ±{(FALLBACK_UNCERTAINTY * 100).toFixed(0)}%)
        </div>
        <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 2 }}>
          * 2010 &amp; 2015 used Landsat 8 OLI only — not spectrally harmonized with HLS (2016+).
          Area estimates are not directly comparable to later years and are excluded from the trend.
        </div>
      </div>

      <div className="module-section">
        <h3>Display Options</h3>
        <div className="control-group">
          <label htmlFor="opacity-slider">Overlay Opacity</label>
          <input
            id="opacity-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.50"
            className="slider"
            onChange={(e) => {
              window.dispatchEvent(new CustomEvent('opacityChange', {
                detail: { opacity: parseFloat(e.target.value) },
              }));
            }}
          />
        </div>
      </div>

      <div className="module-section">
        <h3>Legend</h3>
        <div className="legend-item">
          <span className="legend-color red" />
          <span>Accumulated Clearcut Area</span>
        </div>
        <div className="legend-item">
          <span className="legend-color yellow" />
          <span>New Clearcut Area (error bars from precision/recall)</span>
        </div>
        <div className="legend-item">
          <span style={{ display: 'inline-block', width: 16, height: 0, borderTop: '2px dashed #888', marginRight: 6, verticalAlign: 'middle' }} />
          <span>Annual clearcut trend (red = increasing · green = decreasing)</span>
        </div>
      </div>
    </div>
  );
}

export default ClearcutDetection;
