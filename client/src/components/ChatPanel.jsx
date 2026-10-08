import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import MessageBubble from './MessageBubble';

export default function ChatPanel({ onOpenActions, onOpenTrace, pendingQuestion, onPendingConsumed }) {
  const { activeDataset, activeDatasetId, linkedDatasetIds, datasets, sessionId, setSessionId } = useAppState();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [analysisMode, setAnalysisMode] = useState(false);
  const scrollRef = useRef(null);

  // If the user has explicitly checked 2+ datasets, query across all of them
  // (enables hybrid structured+document queries). Otherwise fall back to
  // just the active dataset - identical behavior to Phases 1-3.
  const queryDatasetIds = linkedDatasetIds.length > 0 ? linkedDatasetIds : (activeDatasetId ? [activeDatasetId] : []);
  const queryDatasets = datasets.filter((d) => queryDatasetIds.includes(d.dataset_id));
  const isHybridSelection = queryDatasetIds.length > 1;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // A question chosen elsewhere (Insights tab chips) is sent as soon as the chat is shown.
  useEffect(() => {
    if (pendingQuestion && queryDatasetIds.length > 0 && !sending) { onPendingConsumed?.(); send(pendingQuestion); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion]);

  async function send(override) {
    const question = (typeof override === 'string' ? override : input).trim();
    if (!question || sending) return;
    if (queryDatasetIds.length === 0) return;

    const userMsg = { role: 'user', content: question, id: crypto.randomUUID() };
    const pendingId = crypto.randomUUID();
    setMessages((m) => [...m, userMsg, { role: 'assistant', pending: true, id: pendingId }]);
    setInput('');
    setSending(true);

    try {
      const result = await api.chat({ question, datasetIds: queryDatasetIds, sessionId, analysisMode: analysisMode && !isHybridSelection });
      if (!sessionId) setSessionId(result.sessionId);
      setMessages((m) => m.map((msg) => msg.id === pendingId ? {
        role: 'assistant',
        id: pendingId,
        content: result.answer,
        question,
        evidence: result.evidence,
        generatedSql: result.generatedSql,
        lowConfidence: result.lowConfidence,
        routeType: result.routeType,
        insights: result.insights,
        chart: result.chart,
        suggestions: result.suggestions,
        tool: result.tool,
        followUp: result.followUp,
        repairs: result.repairs,
        recoveryAttempts: result.recoveryAttempts,
        guardrail: result.guardrail,
        redactedFields: result.redactedFields,
        denied: result.denied,
        report: result.report,
        action: result.action,
        datasetId: queryDatasetIds[0],
        confidence: result.confidence,
        provenance: result.provenance,
        qualityWarnings: result.qualityWarnings,
        trace: result.trace,
        question,
      } : msg));
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      setMessages((m) => m.map((message) => message.id === pendingId ? {
        role: 'assistant',
        id: pendingId,
        content: `Something went wrong: ${msg}`,
        isError: true,
      } : message));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (queryDatasetIds.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No dataset selected</div>
        <div className="empty-state-hint">Upload or select a dataset from the sidebar to start asking questions.</div>
      </div>
    );
  }

  const datasetLabel = isHybridSelection
    ? queryDatasets.map((d) => d.name).join(' + ')
    : (queryDatasets[0]?.name || activeDataset?.name || 'dataset');

  return (
    <div className="chat-panel">
      {isHybridSelection && (
        <div className="hybrid-banner">
          Hybrid query across {queryDatasets.length} datasets: {queryDatasets.map((d) => d.name).join(', ')}
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="chat-welcome-title">Ask anything about “{datasetLabel}”</div>
            <div className="chat-welcome-hint">
              CogniCore will generate a query, validate it against the real schema, run it, and explain the result — it never guesses numbers.
            </div>
          </div>
        )}
        {messages.map((m) => <MessageBubble key={m.id} message={m} datasetId={m.datasetId || queryDatasetIds[0]} onAsk={(q) => send(q)} onOpenActions={onOpenActions} onOpenTrace={onOpenTrace} />)}
      </div>

      <div className="chat-input-row">
        <div className="chat-input-stack">
          <textarea
            className="chat-input"
            placeholder={`Ask a question about ${datasetLabel}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <label className={`analysis-toggle ${isHybridSelection ? 'analysis-toggle-disabled' : ''}`} title={isHybridSelection ? 'Deep Analysis works on a single structured dataset only' : 'Break this question into several steps for open-ended analysis (slower, more thorough)'}>
            <input
              type="checkbox"
              checked={analysisMode}
              disabled={isHybridSelection}
              onChange={(e) => setAnalysisMode(e.target.checked)}
            />
            🔍 Deep Analysis
          </label>
        </div>
        <button className="chat-send" onClick={() => send()} disabled={sending || !input.trim()}>
          {sending ? '···' : 'Send'}
        </button>
      </div>
    </div>
  );
}
