function ModulePanel({
  module,
  data,
  selectedYear,
  // yearRange is still read, to know whether the module is time-varying at all.
  // onYearChange and availableYears moved to <MapTimeline> with the control.
  yearRange = [2015, 2024],
  basemapSynced,
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

  return (
    <div className="module-panel">
      <div className="module-header">
        <h2>{module.name}</h2>
        {module.icon && <span className="module-icon">{module.icon}</span>}
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
