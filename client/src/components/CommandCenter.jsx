import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import { useAuth } from '../state/AuthState';

const SEV = { red: { icon: '🔴', cls: 'alert-red', label: 'Critical' }, orange: { icon: '🟠', cls: 'alert-orange', label: 'Review' }, green: { icon: '🟢', cls: 'alert-green', label: 'Positive' }, info: { icon: 'ℹ️', cls: 'alert-info', label: 'Note' } };

/** Command Center (blueprint #21/#24): "Today's Intelligence" - proactive alerts across all your datasets. */
export default function CommandCenter({ onAsk, onOpenTab }) {
  const { datasets, setActiveDatasetId } = useAppState();
  const { user } = useAuth();
  const [brief, setBrief] = useState(null);
  const [pending, setPending] = useState(0);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true); setError(null);
    api.getBriefing().then(setBrief).catch((e) => setError(e.response?.data?.message || e.message)).finally(() => setLoading(false));
    api.listActions('pending').then((d) => setPending(d.actions.length)).catch(() => {});
    api.listTraces().then((t) => setRecent(t.slice(0, 5))).catch(() => {});
  };
  useEffect(load, [datasets.length]);

  const ask = (a) => { if (a.dataset_id) setActiveDatasetId(a.dataset_id); onAsk(a.ask); };

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3>Today's Intelligence <button className="link-btn" onClick={load}>↻ Refresh</button></h3>
        <p className="muted">Hello{user?.name ? `, ${user.name}` : ''}. CogniCore checked {datasets.filter((d) => d.status === 'ready').length} dataset(s) for you without being asked.</p>
        {loading && <p className="muted">Analysing your data…</p>}
        {error && <div className="sidebar-error">{error}</div>}
        {brief && (
          <>
            <div className="brief-headline">
              <span className="alert-count alert-red">{brief.counts.red} critical</span>
              <span className="alert-count alert-orange">{brief.counts.orange} to review</span>
              <span className="alert-count alert-green">{brief.counts.green} positive</span>
            </div>
            {brief.alerts.length === 0 && <p className="muted">Nothing to report yet — upload a dataset with dates and numbers and check back.</p>}
            {brief.alerts.map((a, i) => (
              <div key={i} className={`alert-card ${SEV[a.severity].cls}`}>
                <div className="alert-title">{SEV[a.severity].icon} {a.title} <span className="muted">· {a.dataset}</span></div>
                <div className="alert-detail">{a.detail}</div>
                {a.ask && <button className="link-btn" onClick={() => ask(a)}>Investigate: “{a.ask}”</button>}
              </div>
            ))}
          </>
        )}
      </section>

      <section className="panel-section">
        <h3>At a glance</h3>
        <div className="kpi-cards">
          <div className="kpi-card"><div className="kpi-value">{datasets.length}</div><div className="kpi-label">datasets</div></div>
          <div className="kpi-card" onClick={() => onOpenTab('actions')} style={{ cursor: 'pointer' }}><div className="kpi-value">{pending}</div><div className="kpi-label">actions awaiting approval</div></div>
          <div className="kpi-card"><div className="kpi-value">{recent.length}</div><div className="kpi-label">recent AI runs</div></div>
        </div>
      </section>

      {recent.length > 0 && (
        <section className="panel-section">
          <h3>Recent AI activity</h3>
          {recent.map((t) => (
            <div key={t.trace_id} className="quality-issue" style={{ cursor: 'pointer' }} onClick={() => onOpenTab('activity', t.trace_id)}>
              <span className="sev-tag">{t.status}</span>{t.question} <span className="muted">· {t.route}{t.tool ? ` / ${t.tool}` : ''} · {t.total_ms} ms</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
