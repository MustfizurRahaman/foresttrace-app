import { useState, useRef, useEffect } from 'react';
import { extractMapAction, actionToFeatures, availableRegionIds } from '../utils/mapActions';

function renderContent(text) {
  return text.split(/\*\*(.*?)\*\*/gs).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part
  );
}

const SUGGESTIONS = [
  'What does this clearcut data tell us?',
  'How does this year compare to historical averages?',
  'What are the ecological impacts of this clearcut rate?',
  'What actions can forest managers take?',
];

function buildContext(moduleData, selectedModule, selectedYear, selectedFMUs, selectedSensor, drawingContext, availableRegions) {
  return {
    module: selectedModule?.name || 'Clearcut Detection',
    region: selectedFMUs?.length ? selectedFMUs.join(', ') : 'All regions',
    year: selectedYear,
    sensor: selectedSensor,
    clearcut: moduleData?.percentage ?? null,
    // Every layer currently switched on, so "what's in here" can speak to all
    // of them rather than only the module in front.
    activeLayers: moduleData?.activeLayerSummary?.length
      ? moduleData.activeLayerSummary
      : undefined,
    // The regions whose boundaries are loaded -- the only ones the assistant can
    // outline, so it can be told rather than left to guess and be refused.
    availableRegions,
    // Only the populated bins: an all-zero histogram means the biomass tiles
    // haven't been tallied for this view, and sending twelve zeroes invites the
    // model to describe an absence of data as a finding.
    biomass: moduleData?.biomassHistogram?.some((b) => b.area > 0)
      ? moduleData.biomassHistogram
          .filter((b) => b.area > 0)
          .map((b) => ({ range: b.label, areaHa: Math.round(b.area) }))
      : undefined,
    // Omitted entirely when nothing is drawn, so the prompt doesn't carry an
    // empty section the model might try to reason about.
    drawing: drawingContext || undefined,
  };
}

function ForestryAIAgent({
  moduleData, selectedModule, selectedYear, selectedFMUs, selectedSensor,
  drawingContext, pendingPrompt, onPromptConsumed, onProposeFeatures, regionsData,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  // Holds the latest send(). The effect below must not depend on send()'s
  // identity, which changes every render and would re-fire the prompt.
  const sendRef = useRef(null);
  // Resolved once from the province-wide overview, so the assistant is told the
  // full list of FMUs it can outline rather than only those on screen.
  const [availableRegions, setAvailableRegions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    availableRegionIds(regionsData).then((ids) => {
      if (!cancelled) setAvailableRegions(ids);
    });
    return () => { cancelled = true; };
  }, [regionsData]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // A question handed in from outside -- the map's "Ask AI" button. Consumed
  // before sending so a re-render can't fire it twice.
  useEffect(() => {
    if (!pendingPrompt || loading) return;
    if (onPromptConsumed) onPromptConsumed();
    sendRef.current?.(pendingPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt]);

  const context = buildContext(
    moduleData, selectedModule, selectedYear, selectedFMUs, selectedSensor, drawingContext,
    availableRegions);
  const hasClearcut = context.clearcut !== null && context.clearcut !== undefined;

  // Assigned on every render so the ref always points at the current closure.
  sendRef.current = send;

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setError(null);

    const outgoing = [...messages, { role: 'user', content: trimmed }];
    setMessages(outgoing);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: outgoing, context }),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server error (${res.status}) — check API key and server logs`);
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Geometry the model proposed rides in a fenced block. Strip it from the
      // prose either way -- raw JSON in the transcript helps nobody -- and only
      // draw what survives validation.
      const { action, text } = extractMapAction(data.content);
      let note = '';
      if (action && onProposeFeatures) {
        const { features, rejected } = await actionToFeatures(action, regionsData);
        // Not exclusive: a request for several regions can succeed for the ones
        // that are loaded and fail for the rest, and the user needs both halves.
        // Success needs no note: the shapes are on the map, and the model has
        // already said in prose what it drew. Counting rings ("26 areas") was
        // actively misleading anyway -- one FMU is many rings.
        if (features.length) onProposeFeatures(features);
        if (rejected) {
          // Surfaced rather than swallowed: a proposal that silently fails to
          // appear reads as a broken map.
          note += `\n\n_(map action ${rejected})_`;
        }
      }
      setMessages([...outgoing, { role: 'assistant', content: text + note }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="ai-panel">
      <div className="ai-context-bar">
        {context.region && <span className="ai-ctx-chip">{context.region}</span>}
        {context.year && <span className="ai-ctx-chip">{context.year}</span>}
        {context.sensor && <span className="ai-ctx-chip">{context.sensor}</span>}
        {hasClearcut && (
          <span className="ai-ctx-chip ai-ctx-chip--clearcut">
            {Number(context.clearcut).toFixed(1)}% cleared
          </span>
        )}
      </div>

      <div className="ai-messages">
        {messages.length === 0 && !loading && (
          <div className="ai-empty">
            <p>Ask about the current clearcut visualization.</p>
            <div className="ai-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-suggestion-btn" onClick={() => send(s)} type="button">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-message ai-message--${msg.role}`}>
            <div className="ai-message-bubble">{renderContent(msg.content)}</div>
          </div>
        ))}

        {loading && (
          <div className="ai-message ai-message--assistant">
            <div className="ai-message-bubble ai-typing">
              <span /><span /><span />
            </div>
          </div>
        )}

        {error && <div className="ai-error">{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-input-area">
        <textarea
          className="ai-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about the forest data… (Enter to send)"
          rows={2}
          disabled={loading}
        />
        <button
          className="ai-send-btn"
          onClick={() => send(input)}
          disabled={!input.trim() || loading}
          type="button"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ForestryAIAgent;
