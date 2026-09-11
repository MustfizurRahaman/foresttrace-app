function ModulePanel({
  module,
  data,
  selectedYear,
  // yearRange is still read, to know whether the module is time-varying at all.
  // onYearChange and availableYears moved to <MapTimeline> with the control.
  yearRange = [2015, 2024],
  basemapSynced,
  activeLayers = [],
}) {
  if (!module) {
    return (
      <div className="module-panel empty">
        <p>Select a module from the left sidebar</p>
      </div>
    );
  }

  // The year control itself now lives on the map (<MapTimeline>): it changes
  // what is drawn, so it belongs with the drawing, and it stays reachable while
  // this panel is showing a chart or the AI agent. What remains here is the
  // caveat about the year, which only makes sense beside the module's data.
  const showYearNote = yearRange && yearRange.length === 2 && basemapSynced === false;

  // A layer can rename the panel headline while it is the only such layer
  // active -- the Wildlife module hosts several species, so the panel names the
  // species. Opt-in via panelTitle, so modules without it are unaffected.
  const named = (module.layers || []).filter(
    (layer) => layer.panelTitle && activeLayers.includes(layer.id),
  );
  const heading = named.length === 1 ? named[0].panelTitle : module.name;
  const headingIcon = named.length === 1
    ? (named[0].panelIcon || module.icon)
    : module.icon;

  return (
    <div className="module-panel">
      <div className="module-header">
        <h2>{heading}</h2>
        {headingIcon && <span className="module-icon">{headingIcon}</span>}
      </div>
      <div className="module-content">
        {showYearNote && (
          <div className="module-section">
            <div className="basemap-warning">
              Basemap shows current imagery — detections used {selectedYear} satellite data
            </div>
          </div>
        )}

        {module.component && <module.component data={data} />}
      </div>
    </div>
  );
}

export default ModulePanel;
