import { useState } from 'react';
import ToolActions from './ToolActions';

function SourceBlock({ evidence, question, answer }) {
  if (evidence.source_type === 'database') {
    return (
      <>
        <div className="evidence-block">
          <div className="evidence-label">
            Source: {evidence.dataset_name} &middot; {evidence.row_count} row{evidence.row_count !== 1 ? 's' : ''}
            {evidence.truncated ? ' (truncated)' : ''}
          </div>
          {evidence.query && <pre className="sql-block">{evidence.query}</pre>}
          {evidence.sample_rows?.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>{evidence.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {evidence.sample_rows.map((row, i) => (
                    <tr key={i}>
                      {evidence.columns.map((c) => <td key={c}>{String(row[c] ?? '—')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ToolActions evidence={evidence} question={question} answer={answer} />
        </div>
        {evidence.issues?.length > 0 && (
          <div className="evidence-issues">
            {evidence.issues.map((issue, i) => <div key={i}>⚠ {issue}</div>)}
          </div>
        )}
      </>
    );
  }

  if (evidence.source_type === 'document') {
    return (
      <div className="evidence-block">
        <div className="evidence-label">
          Source: {evidence.dataset_name} &middot; {evidence.chunks.length} matching passage{evidence.chunks.length !== 1 ? 's' : ''}
        </div>
        <div className="chunk-list">
          {evidence.chunks.map((c, i) => (
            <div className="chunk-card" key={i}>
              <div className="chunk-card-meta">
                {c.page ? `Page ${c.page}` : 'Passage'} {c.score !== null && c.score !== undefined ? `· relevance ${Math.round(c.score * 100)}%` : ''}
              </div>
              <div className="chunk-card-text">{c.text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export default function EvidencePanel({ evidence, generatedSql, question, answer }) {
  const [open, setOpen] = useState(false);
  if (!evidence && !generatedSql) return null;

  const confidence = evidence?.confidence;
  const confidencePct = confidence !== undefined ? Math.round(confidence * 100) : null;
  const isHybrid = evidence?.source_type === 'hybrid';
  const isAnalysis = evidence?.source_type === 'analysis';
  const hasIncomplete = isHybrid && evidence.incomplete?.length > 0;

  return (
    <div className="evidence">
      <button className="evidence-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="evidence-icon">{open ? '▾' : '▸'}</span>
        {isHybrid && `Evidence (${evidence.parts.length}${hasIncomplete ? ` of ${evidence.parts.length + evidence.incomplete.length}` : ''} sources)`}
        {isAnalysis && `🔍 Analysis (${evidence.steps.length} step${evidence.steps.length !== 1 ? 's' : ''})`}
        {!isHybrid && !isAnalysis && 'Evidence'}
        {confidencePct !== null && (
          <span className={`confidence-pill ${confidencePct < 50 ? 'confidence-low' : 'confidence-ok'}`}>
            {confidencePct}% confidence
          </span>
        )}
      </button>

      {open && (
        <div className="evidence-body">
          {!isHybrid && !isAnalysis && generatedSql && evidence?.source_type !== 'database' && (
            <div className="evidence-block">
              <div className="evidence-label">Query executed</div>
              <pre className="sql-block">{generatedSql}</pre>
            </div>
          )}

          {hasIncomplete && (
            <div className="evidence-issues">
              {evidence.incomplete.map((inc, i) => (
                <div key={i}>
                  ⚠ {inc.source_type === 'database' ? '🗄' : '📄'} "{inc.dataset_name}" could not be used: {inc.reason}
                </div>
              ))}
            </div>
          )}

          {isAnalysis && evidence.steps.map((step, i) => (
            <div key={i} className="hybrid-source-group">
              <div className="hybrid-source-tag">
                Step {i + 1}: {step.question}
                {step.failed && <span className="analysis-step-failed"> — could not be answered</span>}
              </div>
              {step.failed ? (
                <div className="evidence-issues">⚠ {step.failureReason}</div>
              ) : (
                <SourceBlock evidence={step.evidence} question={step.question} answer={answer} />
              )}
            </div>
          ))}

          {isHybrid && evidence.parts.map((part, i) => (
            <div key={i} className="hybrid-source-group">
              <div className="hybrid-source-tag">{part.source_type === 'database' ? '🗄 Database' : '📄 Document'}</div>
              <SourceBlock evidence={part} question={question} answer={answer} />
            </div>
          ))}

          {!isHybrid && !isAnalysis && evidence && <SourceBlock evidence={evidence} question={question} answer={answer} />}
        </div>
      )}
    </div>
  );
}
