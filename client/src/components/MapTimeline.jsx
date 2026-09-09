import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Year timeline across the bottom of the map, with playback.
 *
 * Lives over the map rather than in the module panel because the year applies
 * to what is *drawn*, not to the module being read: it belongs with the thing it
 * changes, and it stays reachable while the panel shows a chart or the AI agent.
 *
 * Ticks are positioned by index, not by year, so the gap between 2010 and 2015
 * does not stretch a quarter of the track across years that have no data. That
 * makes the axis non-linear in time, which is the right trade for a record with
 * a five-year hole in it -- every stop is a year you can actually select.
 */

// How long a fully-drawn frame is held before advancing. Playback waits for
// tiles on top of this, so the real frame time is this plus whatever the year
// took to load.
const FRAME_MS = 1200;

// Ceiling on that wait. A year whose tiles error, or a source that never
// reports itself settled, would otherwise park playback forever -- better to
// advance on a visibly incomplete frame than to appear frozen.
const MAX_WAIT_MS = 8000;

function MapTimeline({ years, selectedYear, onYearChange, loading = false, disabled = false }) {
  const [playing, setPlaying] = useState(false);
  // The tick the pointer is over, so the label can preview it without the map
  // reloading on the way past.
  const [hoverIndex, setHoverIndex] = useState(null);

  const index = Math.max(0, years.indexOf(selectedYear));
  const onYearChangeRef = useRef(onYearChange);
  onYearChangeRef.current = onYearChange;

  // Playback stops at the end rather than looping: a loop makes it ambiguous
  // whether the last frame is the newest year or a rerun of the first.
  //
  // Frames advance only once the map has finished loading. A fixed clock
  // outran the tiles on a cold cache and animated a sequence of half-drawn
  // years -- which is worse than a slower animation, because the viewer cannot
  // tell a partially-loaded year from a year with less clearcut in it.
  useEffect(() => {
    if (!playing) return undefined;
    if (index >= years.length - 1) {
      setPlaying(false);
      return undefined;
    }

    const advance = () => onYearChangeRef.current(years[index + 1]);

    if (!loading) {
      const timer = setTimeout(advance, FRAME_MS);
      return () => clearTimeout(timer);
    }

    const bail = setTimeout(advance, MAX_WAIT_MS);
    return () => clearTimeout(bail);
  }, [playing, index, years, loading]);

  useEffect(() => {
    if (disabled) setPlaying(false);
  }, [disabled]);

  const togglePlay = useCallback(() => {
    setPlaying((was) => {
      if (was) return false;
      // Restart from the beginning when parked on the last year, so the button
      // never appears to do nothing.
      if (index >= years.length - 1) onYearChangeRef.current(years[0]);
      return true;
    });
  }, [index, years]);

  const step = useCallback((delta) => {
    setPlaying(false);
    const next = Math.min(years.length - 1, Math.max(0, index + delta));
    if (next !== index) onYearChangeRef.current(years[next]);
  }, [index, years]);

  if (!years?.length) return null;

  const shown = hoverIndex === null ? selectedYear : years[hoverIndex];
  // Waiting is a distinct state from playing: the year has changed and the map
  // is catching up, so the button says "working" rather than "paused".
  const waiting = playing && loading;
  const progress = years.length > 1 ? (index / (years.length - 1)) * 100 : 0;

  return (
    <div className="map-timeline" role="group" aria-label="Year timeline">
      <button
        type="button"
        className="timeline-btn"
        onClick={() => step(-1)}
        disabled={disabled || index === 0}
        title="Previous year"
        aria-label="Previous year"
      >
        {'◀'}
      </button>

      <button
        type="button"
        className="timeline-btn timeline-btn--play"
        onClick={togglePlay}
        disabled={disabled}
        title={waiting ? 'Waiting for tiles…' : (playing ? 'Pause' : 'Play through the years')}
        aria-label={waiting ? 'Waiting for tiles' : (playing ? 'Pause' : 'Play through the years')}
      >
        {waiting
          ? <span className="loading-spinner loading-spinner--tiny" aria-hidden="true" />
          : (playing ? '⏸' : '▶')}
      </button>

      <button
        type="button"
        className="timeline-btn"
        onClick={() => step(1)}
        disabled={disabled || index >= years.length - 1}
        title="Next year"
        aria-label="Next year"
      >
        {'▶'}
      </button>

      <span className={`timeline-year${hoverIndex !== null ? ' timeline-year--preview' : ''}`}>
        {shown}
      </span>

      <div className="timeline-track" onMouseLeave={() => setHoverIndex(null)}>
        <div className="timeline-fill" style={{ width: `${progress}%` }} />

        {/* A tick per year, both as the visible scale and as the hit target --
            clicking a year is more direct than dragging to it. */}
        {years.map((year, i) => (
          <button
            key={year}
            type="button"
            className={`timeline-tick${i === index ? ' timeline-tick--active' : ''}`}
            style={{ left: `${years.length > 1 ? (i / (years.length - 1)) * 100 : 50}%` }}
            onClick={() => { setPlaying(false); onYearChange(year); }}
            onMouseEnter={() => setHoverIndex(i)}
            disabled={disabled}
            title={String(year)}
            aria-label={String(year)}
            aria-current={i === index}
          />
        ))}

        {/* The range input sits invisibly over the ticks so the control is
            keyboard- and drag-operable, which a row of buttons is not. */}
        <input
          type="range"
          className="timeline-range"
          min={0}
          max={years.length - 1}
          value={index}
          disabled={disabled}
          onChange={(e) => {
            setPlaying(false);
            onYearChange(years[parseInt(e.target.value, 10)]);
          }}
          aria-label="Year"
        />
      </div>

      <span className="timeline-bounds">{years[0]}–{years[years.length - 1]}</span>
    </div>
  );
}

export default MapTimeline;
