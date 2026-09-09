import React, { useState, useRef, useEffect } from 'react';
import ForestryAIAgent from './ForestryAIAgent';

const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

function ModuleSelector({
  modules,
  selectedModule,
  onModuleSelect,
  activeLayers,
  onLayerToggle,
  moduleData,
  selectedYear,
  selectedFMUs,
  selectedSensor,
  drawingContext,
  activeTab: controlledTab,
  onTabChange,
  pendingPrompt,
  onPromptConsumed,
  onProposeFeatures,
  regionsData,
}) {
  // Controlled when the parent supplies a tab -- the map's "Ask AI" button has
  // to be able to bring this panel to the agent -- and self-managed otherwise,
  // so existing callers keep working.
  const [ownTab, setOwnTab] = useState('modules');
  const activeTab = controlledTab ?? ownTab;
  const setActiveTab = onTabChange ?? setOwnTab;
  const [expandedModules, setExpandedModules] = useState({ [modules[0]?.id]: true });
  const [panelWidth, setPanelWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const moveHandler = useRef(null);
  const upHandler = useRef(null);

  useEffect(() => {
    return () => {
      if (moveHandler.current) document.removeEventListener('mousemove', moveHandler.current);
      if (upHandler.current) document.removeEventListener('mouseup', upHandler.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  function handleResizeMouseDown(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;

    moveHandler.current = (e) => {
      const newWidth = Math.min(Math.max(startWidth + e.clientX - startX, MIN_WIDTH), MAX_WIDTH);
      setPanelWidth(newWidth);
    };

    upHandler.current = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', moveHandler.current);
      document.removeEventListener('mouseup', upHandler.current);
      moveHandler.current = null;
      upHandler.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    setIsResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', moveHandler.current);
    document.addEventListener('mouseup', upHandler.current);
  }

  const handleModuleClick = (module) => {
    onModuleSelect(module);
    setExpandedModules(prev => ({ ...prev, [module.id]: true }));
  };

  const toggleModuleExpand = (moduleId) => {
    setExpandedModules(prev => ({ ...prev, [moduleId]: !prev[moduleId] }));
  };

  return (
    <div className="module-selector" style={{ width: panelWidth }}>
      <div className="selector-header">
        <h3>Explore</h3>
        <div className="selector-tabs">
          <button
            className={`selector-tab ${activeTab === 'modules' ? 'active' : ''}`}
            onClick={() => setActiveTab('modules')}
            type="button"
          >
            Modules
          </button>
          <button
            className={`selector-tab ${activeTab === 'forest-ai' ? 'active' : ''}`}
            onClick={() => setActiveTab('forest-ai')}
            type="button"
          >
            Forestry AI Agent
          </button>
        </div>
      </div>

      {activeTab === 'modules' && (
        <div className="module-list">
          {modules.map((module) => {
            const isExpanded = expandedModules[module.id];
            const moduleActiveLayers = activeLayers[module.id] || [];
            const hasActiveLayers = moduleActiveLayers.length > 0;

            return (
              <div key={module.id} className="module-item">
                <button
                  className={`module-btn ${selectedModule?.id === module.id ? 'active' : ''} ${hasActiveLayers ? 'has-active-layers' : ''}`}
                  onClick={() => handleModuleClick(module)}
                  title={module.description}
                >
                  <span className="module-btn-icon">{module.icon}</span>
                  <span className="module-btn-label">{module.name}</span>
                  <span
                    className="module-expand-indicator"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleModuleExpand(module.id);
                    }}
                  >
                    {isExpanded ? '−' : '+'}
                  </span>
                </button>
                {isExpanded && module.layers && (
                  <div className="module-options" role="group" aria-label={`${module.name} layers`}>
                    {module.layers.map((layer) => (
                      <label key={layer.id} className="module-option">
                        <input
                          type="checkbox"
                          checked={moduleActiveLayers.includes(layer.id)}
                          onChange={() => onLayerToggle(module.id, layer.id)}
                        />
                        {layer.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'forest-ai' && (
        <ForestryAIAgent
          moduleData={moduleData}
          selectedModule={selectedModule}
          selectedYear={selectedYear}
          selectedFMUs={selectedFMUs}
          selectedSensor={selectedSensor}
          drawingContext={drawingContext}
          pendingPrompt={pendingPrompt}
          onPromptConsumed={onPromptConsumed}
          onProposeFeatures={onProposeFeatures}
          regionsData={regionsData}
        />
      )}

      <div
        className={`resize-handle${isResizing ? ' resize-handle--active' : ''}`}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
}

export default ModuleSelector;
