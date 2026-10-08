import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import { useAuth } from '../state/AuthState';

const SEV = { high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };
const fmt = (v, unit) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit === 'percent' || unit === 'percent_change' ? `${n}%` : n;
};

/** Data health & overview: quality score + issues, KPIs, "what can I ask?", and the management report. */
export default function InsightsPanel({ onAsk }) {
  const { activeDataset } = useAppState();
  const { user } = useAuth();
  const [state, setState] = useState({ loading: true });
  const id = activeDataset?.dataset_id;
  const canReport = ['admin', 'manager', 'analyst', 'user'].includes(user?.role);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ loading: true });
    Promise.allSettled([api.getQuality(id), api.getKpis(id), api.getExploreQuestions(id)]).then(([q, k, e]) => {
      if (!live) return;
      setState({ loading: false, quality: q.value, kpis: k.value, questions: e.value, notes: [q, k, e].filter((r) => r.status === 'rejected').map((r) => r.reason?.response?.data?.message).filter(Boolean) });
    });
    return () => { live = false; };
  }, [id]);

  if (!activeDataset) return <div className="empty-state"><div className="empty-state-title">No dataset selected</div></div>;
  if (state.loading) return <div className="empty-state"><div className="empty-state-title">Analysing {activeDataset.name}…</div></div>;
  const { quality, kpis, questions, notes } = state;

  return (
    <div className="panel-scroll">
      {notes?.length > 0 && <div className="panel-note">{notes[0]}</div>}

      {quality && (
        <section className="panel-section">
          <h3>Data quality <span className={`score-pill ${quality.overallScore >= 85 ? 'score-good' : quality.overallScore >= 60 ? 'score-mid' : 'score-bad'}`}>{quality.overallScore}/100</span></h3>
          {quality.tables.map((t) => (
            <div key={t.name} className="quality-table">
              <div className="quality-table-name">{t.name} <span className="muted">· {t.rowCount} rows · {t.summary}</span></div>
              {t.issues.map((i, k) => (
                <div key={k} className={`quality-issue ${SEV[i.severity]}`}>
                  <span className="sev-tag">{i.severity}</span> {i.message}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      {kpis && (
        <section className="panel-section">
          <h3>Key metrics</h3>
          {kpis.map((g) => (
            <div key={g.table}>
              <div className="quality-table-name">{g.table}</div>
              <div className="kpi-cards">
                {g.kpis.filter((k) => k.value !== null).map((k) => (
                  <div className="kpi-card" key={k.id} title={k.sql || 'computed during ingestion'}>
                    <div className="kpi-value">{fmt(k.value, k.format)}</div>
                    <div className="kpi-label">{k.label}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {questions && (
        <section className="panel-section">
          <h3>What can I ask about this dataset?</h3>
          <div className="suggestion-chips">
            {questions.map((q) => <button key={q.question} className="suggestion-chip" onClick={() => onAsk(q.question)}>{q.question}</button>)}
          </div>
        </section>
      )}

      {canReport && (
        <section className="panel-section">
          <h3>Management report</h3>
          <p className="muted">Executive summary, key metrics, trends, problems, category analysis, recommendations and supporting data — all computed from your data.</p>
          <div className="extra-card-actions">
            {['pdf', 'docx', 'xlsx', 'csv'].map((f) => (
              <button key={f} className="link-btn" onClick={() => api.downloadReport(id, f, `${activeDataset.name}-report`).catch((e) => alert(e.response?.data?.message || e.message))}>Download {f.toUpperCase()}</button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
