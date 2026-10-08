import { api } from '../services/api';

const TOOL_LABELS = {
  trend: 'Trend analysis', trend_ranking: 'Trend ranking', forecast: 'Forecast', anomaly: 'Anomaly detection', correlation: 'Correlation (Python tool)',
  compare: 'Comparison', data_quality: 'Data quality', kpi: 'KPIs', explore: 'Data exploration',
};

/** Small badges that make the pipeline's work visible: tool used, repairs, recovery, guardrails, masking. */
export function Badges({ message }) {
  const b = [];
  if (message.tool) b.push({ text: `Tool: ${TOOL_LABELS[message.tool] || message.tool}`, cls: 'badge-tool' });
  if (message.followUp) b.push({ text: `Understood as: “${message.followUp.standaloneQuestion}”`, cls: 'badge-follow' });
  if (message.repairs?.length) b.push({ text: `Query auto-corrected (${message.repairs.map((r) => r.type.replace(/_/g, ' ')).join(', ')})`, cls: 'badge-fix' });
  if (message.recoveryAttempts) b.push({ text: `Recovered from an error automatically (${message.recoveryAttempts}×)`, cls: 'badge-fix' });
  if (message.guardrail?.flags?.length) b.push({ text: `Guardrail: ${message.guardrail.flags.join(', ').replace(/_/g, ' ')}`, cls: 'badge-warn' });
  if (message.redactedFields) b.push({ text: `${message.redactedFields} sensitive field(s) masked for your role`, cls: 'badge-warn' });
  if (message.denied) b.push({ text: 'Blocked by data-access policy', cls: 'badge-warn' });
  if (!b.length) return null;
  return <div className="badge-row">{b.map((x, i) => <span key={i} className={`badge ${x.cls}`}>{x.text}</span>)}</div>;
}

/** Report download card (chat "give me a management report"). */
export function ReportCard({ report }) {
  if (!report) return null;
  return (
    <div className="extra-card">
      <div className="extra-card-title">📄 {report.title}</div>
      <div className="extra-card-actions">
        {report.formats.map((f) => (
          <button key={f} className="link-btn" onClick={() => api.downloadReport(report.datasetId, f)}>{f.toUpperCase()}</button>
        ))}
      </div>
    </div>
  );
}

/** Pending-approval action card (chat "email the report to ..."). */
export function ActionCard({ action, onOpenActions }) {
  if (!action) return null;
  return (
    <div className="extra-card extra-card-pending">
      <div className="extra-card-title">⏳ Awaiting approval · {action.action_id}</div>
      <div className="extra-card-body">{action.summary}</div>
      <div className="extra-card-actions"><button className="link-btn" onClick={onOpenActions}>Open Actions tab</button></div>
    </div>
  );
}

const LV = { High: 'conf-high', Medium: 'conf-mid', Low: 'conf-low' };
const COMP_LABEL = { schema: 'Schema match', query: 'Query validity', completeness: 'Data completeness', consistency: 'Result consistency', evidence: 'Evidence quality' };

/** Explained confidence (blueprint #15): level + the five measured components. */
export function ConfidenceBlock({ confidence }) {
  if (!confidence) return null;
  return (
    <details className="conf-block">
      <summary><span className={`conf-pill ${LV[confidence.level]}`}>{confidence.level} confidence</span> <span className="muted">{confidence.summary}</span></summary>
      <div className="conf-grid">
        {Object.entries(confidence.components).map(([k, c]) => (
          <div key={k} className="conf-row"><span>{COMP_LABEL[k] || k}</span><div className="conf-bar"><div style={{ width: `${Math.round(c.score * 100)}%` }} /></div><span className="muted">{c.reason}</span></div>
        ))}
      </div>
    </details>
  );
}

/** Provenance (blueprint #14): where the answer came from. */
export function ProvenanceBlock({ provenance }) {
  if (!provenance) return null;
  return (
    <details className="conf-block">
      <summary className="muted">Where this came from</summary>
      <div className="prov-grid">
        <div><b>Source</b> {provenance.source} ({provenance.source_type})</div>
        <div><b>Tables</b> {provenance.tables.join(', ') || '—'}</div>
        <div><b>Columns</b> {provenance.columns.join(', ') || '—'}</div>
        {provenance.calculation && <div><b>Calculation</b> {provenance.calculation}</div>}
        <div><b>Rows</b> {provenance.rows_scanned?.toLocaleString()} scanned · {provenance.rows_returned} returned</div>
        <div><b>Run at</b> {new Date(provenance.timestamp).toLocaleString()}</div>
      </div>
    </details>
  );
}

export function QualityWarnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="quality-warn">
      <b>⚠ Data quality may affect this answer</b>
      {warnings.map((w, i) => <div key={i}>• {w.message}</div>)}
    </div>
  );
}

export function TraceSummary({ trace, onOpen }) {
  if (!trace) return null;
  return (
    <button className="link-btn" onClick={() => onOpen?.(trace.trace_id)} title="See every step the AI took">
      ⏱ {trace.steps.length} steps · {trace.total_ms} ms — view AI trace
    </button>
  );
}
