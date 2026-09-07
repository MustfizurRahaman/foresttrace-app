import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  getCoreHabitatPerYear, getSizeBreakdown, getRangeNames,
  RAMP_STOPS, RAMP_TICKS, CARIBOU_RANGES,
} from '../utils/caribouStats';

// The outputs_v3 MSPA source covers 2015-2025. Listing the real years here
// keeps the chart honest rather than padding it with years never assessed.
// Note 2023-2025 are near-identical: the input disturbance layers do not
// appear to extend past 2023, so that flat tail is missing data, not stability.
const HABITAT_YEARS = [2015, 2016, 2017, 2018, 2019, 2020,
  2021, 2022, 2023, 2024, 2025];

// Two viridis stops, so the chart reads as the same layer as the map. The
// selected year takes the darker teal, which holds up against both themes.
const HABITAT_COLOR = '#5ec962';
const HABITAT_COLOR_ACTIVE = '#21918c';

const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

function CaribouHabitatModule({ data }) {
  const {
    selectedYear, showCaribouRanges, onToggleCaribouRanges,
    selectedRanges, onToggleRange, onToggleAllRanges, caribouRegions,
  } = data;
  const allRangesSelected = (selectedRanges?.length ?? 0) === CARIBOU_RANGES.length;
  // What the habitat layer is drawing: the range FMUs while ranges are on,
  // otherwise the FMU selection. Reading it from one place keeps these numbers
  // describing the map rather than something next to it.
  const selectedFMUs = caribouRegions?.length ? caribouRegions : data.selectedFMUs;
  const rangeMode = (selectedRanges?.length ?? 0) > 0;
  const [rows, setRows] = useState([]);
  const [bins, setBins] = useState([]);
  const [ranges, setRanges] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!selectedFMUs || selectedFMUs.length === 0) {
      setRows([]);
      // Clear the flag here too: an in-flight request's handlers are skipped by
      // the `cancelled` guard, so this is the only path left that can take the
      // panel out of "Loading…".
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    getCoreHabitatPerYear(selectedFMUs, HABITAT_YEARS)
      .then((result) => {
        if (!cancelled) {
          setRows(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFMUs]);

  // Size breakdown and range provenance both depend on the selected year.
  useEffect(() => {
    let cancelled = false;

    if (!selectedFMUs || selectedFMUs.length === 0) {
      setBins([]);
      setRanges([]);
      return undefined;
    }

    Promise.all([
      getSizeBreakdown(selectedFMUs, selectedYear),
      getRangeNames(selectedFMUs, selectedYear),
    ])
      .then(([b, r]) => {
        if (!cancelled) {
          setBins(b);
          setRanges(r);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBins([]);
          setRanges([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFMUs, selectedYear]);

  const current = rows.find((r) => r.year === selectedYear);
  const assessed = rows.some((r) => r.inRangeHa > 0);
  const anyFunctional = rows.some((r) => r.functionalHa > 0);

  // Change over the full record, which is the "increase/decrease per year" the
  // module exists to surface. Computed across the assessed years only.
  const trend = useMemo(() => {
    const withData = rows.filter((r) => r.inRangeHa > 0);
    if (withData.length < 2) return null;
    const first = withData[0];
    const last = withData[withData.length - 1];
    // Measured on the same series the chart draws (>= 100 ha), so the arrow and
    // the bars can never tell different stories.
    const deltaHa = last.functionalHa - first.functionalHa;
    return {
      deltaHa,
      pct: first.functionalHa > 0 ? (deltaHa / first.functionalHa) * 100 : null,
      from: first.year,
      to: last.year,
    };
  }, [rows]);

  const binTotal = useMemo(
    () => bins.reduce((sum, b) => sum + b.areaHa, 0),
    [bins],
  );

  // "Not in caribou range" is a claim about the data, so it must not be shown
  // before the data exists. Loading and no-selection are distinct states and
  // each gets its own message.
  function renderCurrentYear() {
    if (loading) {
      return <p className="stat-sub">Loading…</p>;
    }
    if (!selectedFMUs || selectedFMUs.length === 0) {
      return <p className="no-data">Select a forest management unit.</p>;
    }
    if (!current || current.inRangeHa === 0) {
      return <p className="no-data">Outside the caribou range — not assessed.</p>;
    }

    const pct = current.pct;
    return (
      <div className="stat-item">
        <div className="stat-label">Core Habitat</div>
        <div className="stat-value">{pct === null ? '—' : `${pct.toFixed(1)}%`}</div>
        {pct !== null && (
          <div className="stat-bar">
            <div
              className="stat-fill"
              style={{
                width: `${Math.min(100, Math.max(pct, 0.5))}%`,
                background: HABITAT_COLOR_ACTIVE,
              }}
            />
          </div>
        )}
        <div className="stat-sub" style={{ fontSize: 11, marginTop: 2 }}>
          {fmt(current.coreHa)} ha of {fmt(current.inRangeHa)} ha assessed
        </div>
      </div>
    );
  }

  return (
    <div className="clearcut-module">
      <div className="module-section">
        <p className="stat-sub">
          Core caribou habitat from Morphological Spatial Pattern Analysis (MSPA)
          of undisturbed forest.
        </p>
      </div>

      {/* Seven ranges plus two controls is a lot of switches to leave open above
          the charts, so they collapse. <details> rather than custom state: it
          keeps keyboard and screen-reader behaviour for free. */}
      <div className="module-section">
        <details className="range-dropdown">
          <summary>
            <span>Population Ranges</span>
            <span className="range-summary-count">
              {allRangesSelected ? 'All' : (selectedRanges?.length || 0) || 'None'}
            </span>
          </summary>

          <div className="range-panel">
            {/* Outlines every range including unselected ones, without loading
                their tiles -- a cheap way to see where the ranges are before
                committing to the habitat for one. A selected range outlines
                itself regardless of this. */}
            <label className="switch range-switch" htmlFor="caribou-range-toggle">
              <span className="range-name">Outline all ranges</span>
              <input
                id="caribou-range-toggle"
                type="checkbox"
                role="switch"
                checked={!!showCaribouRanges}
                onChange={(e) => onToggleCaribouRanges?.(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
            </label>

            {/* Unlike the outline toggle above, this loads habitat for all 25
                FMUs the seven ranges span. */}
            <label className="switch range-switch range-switch-all" htmlFor="caribou-range-all">
              <span className="range-name">Habitat for all ranges</span>
              <input
                id="caribou-range-all"
                type="checkbox"
                role="switch"
                checked={allRangesSelected}
                onChange={(e) => onToggleAllRanges?.(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
            </label>

            {/* One switch per range. Turning any on drives the habitat layer from
                the range instead of the FMU selection -- the raster is already
                clipped to the ranges, so its FMU tiles draw the range and no more. */}
            {CARIBOU_RANGES.map(({ id, label, color, colorDark }) => (
              <label className="switch range-switch" key={id} htmlFor={`caribou-range-${id}`}>
                <i
                  className="range-swatch"
                  style={{ '--swatch': color, '--swatch-dark': colorDark }}
                  aria-hidden="true"
                />
                <span className="range-name">{label}</span>
                <input
                  id={`caribou-range-${id}`}
                  type="checkbox"
                  role="switch"
                  checked={selectedRanges?.includes(id) || false}
                  onChange={(e) => onToggleRange?.(id, e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
              </label>
            ))}

            <p className="stat-sub range-mode-note">
              {rangeMode
                ? `Habitat and stats follow the ${selectedRanges.length === 1 ? 'selected range' : `${selectedRanges.length} selected ranges`}, across ${selectedFMUs.length} FMU${selectedFMUs.length === 1 ? '' : 's'}.`
                : 'No range selected — habitat follows the FMU selection.'}
            </p>
          </div>
        </details>
      </div>

      <div className="module-section">
        <h3>Functional Core Habitat by Year (ha)</h3>
        {loading && <div className="biomass-chart-status">Loading…</div>}
        {!loading && !assessed && (
          <p className="stat-sub">
            {selectedFMUs?.length
              ? 'None of the selected units fall inside a caribou range.'
              : 'Select a forest management unit.'}
          </p>
        )}
        {!loading && assessed && !anyFunctional && (
          <p className="stat-sub">
            No core patches reach 100 ha in any year — all core here is under
            that threshold.
          </p>
        )}
        {!loading && assessed && anyFunctional && (
          <div className="biomass-chart">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={rows} margin={{ left: 0, right: 12, top: 6, bottom: 4 }}>
                {/* 11 years will not fit upright in a 268px panel, so label
                    every other one; the tooltip carries the exact year. */}
                <XAxis
                  dataKey="year"
                  tick={{ fontSize: 10 }}
                  height={24}
                  interval={1}
                  tickFormatter={(y) => String(y).slice(2)}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0))}
                  width={44}
                />
                <Tooltip
                  formatter={(value, name, props) => {
                    const { functionalPct } = props.payload;
                    return [
                      `${fmt(value)} ha${functionalPct !== null ? ` — ${functionalPct.toFixed(1)}% of assessed` : ''}`,
                      'Core ≥ 100 ha',
                    ];
                  }}
                  labelFormatter={(label) => `Year ${label}`}
                  labelStyle={{ fontSize: 12 }}
                  itemStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="functionalHa" name="Functional core" radius={[2, 2, 0, 0]}>
                  {rows.map((row) => (
                    <Cell
                      key={row.year}
                      fill={row.year === selectedYear ? HABITAT_COLOR_ACTIVE : HABITAT_COLOR}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {!loading && assessed && anyFunctional && (
          <div className="stat-sub" style={{ fontSize: 11, marginTop: 4 }}>
            Patches under 100 ha are excluded — they are erosion speckle rather
            than usable habitat. Percentages are of the assessed (in-range)
            area, not the whole FMU.
          </div>
        )}
      </div>

      {!loading && assessed && binTotal > 0 && (
        <div className="module-section">
          <h3>Core Patch Size ({selectedYear})</h3>
          {/* Raster values 1-19 are ordinal size classes, so they are counted
              and grouped — never averaged into a "mean class", which would be
              meaningless. Large contiguous patches are what support a herd.

              Hard colour stops rather than a smooth blend: the four bins are
              discrete classes, and a continuous gradient would imply the map
              carries values between them, which it does not. */}
          <div className="habitat-ramp">
            <div
              className="habitat-ramp-bar"
              style={{ background: `linear-gradient(to right, ${RAMP_STOPS.join(', ')})` }}
            />
            <div className="habitat-ramp-ticks">
              {RAMP_TICKS.map((tick) => (
                <span
                  key={tick.label}
                  style={{ left: `${tick.pct}%` }}
                  data-edge={tick.pct === 0 ? 'start' : (tick.pct === 100 ? 'end' : undefined)}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>

          <div className="habitat-shares">
            {bins.map((bin) => (
              <span key={bin.key}>
                <i style={{ background: bin.color, opacity: (bin.alpha ?? 200) / 255 }} />
                <em>{bin.label}</em>
                <strong>{((bin.areaHa / binTotal) * 100).toFixed(0)}%</strong>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="module-section">
        <h3>Habitat ({selectedYear})</h3>
        {renderCurrentYear()}
        {!loading && trend && (
          <div className="stat-sub" style={{ fontSize: 11, marginTop: 6 }}>
            {trend.deltaHa === 0 ? 'No net change' : (
              <>
                {trend.deltaHa < 0 ? '▼' : '▲'} {fmt(Math.abs(trend.deltaHa))} ha
                {trend.pct !== null && ` (${Math.abs(trend.pct).toFixed(1)}%)`}
                {trend.deltaHa < 0 ? ' lost' : ' gained'} (≥100 ha) {trend.from}–{trend.to}
              </>
            )}
          </div>
        )}
      </div>

      {!loading && assessed && ranges.length > 0 && (
        <div className="module-section">
          <h3>Caribou Ranges</h3>
          <p className="stat-sub" style={{ fontSize: 11 }}>
            {ranges.map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

export default CaribouHabitatModule;
