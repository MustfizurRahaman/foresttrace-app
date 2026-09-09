import { useEffect, useRef, useState } from 'react';

/**
 * Collapsed-by-default note on what the clearcut layers are derived from.
 *
 * Modelled on the basemap's own compact attribution control: a map carries its
 * sources with it rather than in a caption beside a chart, and the detail is
 * there for whoever goes looking without taxing everyone who doesn't. The long
 * form -- accumulation rule, comparability, training data -- lives in
 * Documentation; this is the pointer.
 */
function MapSourcesInfo({ onOpenDocumentation = null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Dismiss on outside click and on Escape, the way the attribution popover does.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="map-sources" ref={rootRef}>
      {open && (
        <div className="map-sources-panel" role="dialog" aria-label="Clearcut data sources">
          <p className="map-sources-title">Clearcut detection — sources</p>
          <dl className="map-sources-list">
            <dt>2016–2024</dt>
            <dd>Harmonized Landsat &amp; Sentinel-2 (HLS v2), 30 m — NASA Earthdata</dd>
            <dt>2025</dt>
            <dd>Planet NICFI PlanetScope, 3 m</dd>
            <dt>2010, 2015</dt>
            <dd>Landsat 8 OLI, 30 m — single sensor, not harmonized with HLS</dd>
            <dt>Labels</dt>
            <dd>Ontario MNRF Annual Report harvest blocks; FMU boundaries</dd>
            <dt>Model</dt>
            <dd>6-class U-Net; accumulated = seen in two consecutive years of a 5-year window</dd>
          </dl>
          {onOpenDocumentation && (
            <button
              type="button"
              className="map-sources-link"
              onClick={() => { setOpen(false); onOpenDocumentation(); }}
            >
              Full methodology in Documentation →
            </button>
          )}
        </div>
      )}
      {/* A labelled pill, not another circled "i": the basemap attribution sits
          directly below with exactly that glyph, and two identical marks a few
          pixels apart read as one control repeated rather than two different
          things. The axe matches the Clearcut Detection module's own icon, so
          the button says whose sources these are before it is even opened. */}
      <button
        type="button"
        className="map-sources-btn"
        aria-expanded={open}
        aria-label="Clearcut data sources"
        title="Clearcut data sources"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🪓</span> Sources
      </button>
    </div>
  );
}

export default MapSourcesInfo;
