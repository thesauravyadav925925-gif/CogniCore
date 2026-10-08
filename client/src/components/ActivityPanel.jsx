import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../state/AuthState';

const ICON = { ok: '✓', warn: '⚠', error: '✗', blocked: '⛔', skipped: '–' };

/** AI Activity (blueprint #25): see exactly what the AI did for each question. */
export default function ActivityPanel({ focusId }) {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(focusId || null);
  const [detail, setDetail] = useState(null);
  const [scope, setScope] = useState('mine');

  useEffect(() => { api.listTraces(scope === 'all' ? 'all' : undefined).then(setList).catch(() => {}); }, [scope]);
  useEffect(() => { if (focusId) setOpen(focusId); }, [focusId]);
  useEffect(() => { if (open) api.getTrace(open).then(setDetail).catch(() => setDetail(null)); else setDetail(null); }, [open]);

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3>AI Activity {user?.role === 'admin' && (
          <select className="connect-select" value={scope} onChange={(e) => setScope(e.target.value)}><option value="mine">My activity</option><option value="all">Everyone</option></select>
        )}</h3>
        <p className="muted">Every question is traced: intent, plan, tool, SQL, validation, timing. Row data is never stored in a trace.</p>
        {list.length === 0 && <p className="muted">No activity yet — ask something in Chat.</p>}
        {list.map((t) => (
          <div key={t.trace_id}>
            <div className={`trace-row ${open === t.trace_id ? 'trace-open' : ''}`} onClick={() => setOpen(open === t.trace_id ? null : t.trace_id)}>
              <span className={`status-pill ${t.status === 'ok' ? 'st-ok' : t.status === 'blocked' ? 'st-pending' : 'st-bad'}`}>{t.status}</span>
              <span className="trace-q">{t.question}</span>
              <span className="muted">{t.route}{t.tool ? ` · ${t.tool}` : ''} · {t.total_ms} ms · {new Date(t.created_at).toLocaleTimeString()}</span>
            </div>
            {open === t.trace_id && detail && (
              <div className="trace-steps">
                {detail.steps.map((s) => (
                  <div key={s.n} className={`trace-step ts-${s.status}`}>
                    <span className="ts-icon">{ICON[s.status] || '•'}</span>
                    <span className="ts-name">{s.name.replace(/_/g, ' ')}</span>
                    <span className="ts-detail">{s.detail}</span>
                    <span className="muted">{s.step_ms !== undefined ? `${s.step_ms} ms` : `+${s.at_ms} ms`}</span>
                  </div>
                ))}
                <div className="muted">Total {detail.total_ms} ms</div>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
