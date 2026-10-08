import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../state/AuthState';

const LABELS = { output_format: 'Answer style', detail_level: 'Level of detail', default_chart: 'Preferred chart' };

/** Settings: answer-style memory (formatting only), active sessions, model routing (admin). */
export default function SettingsPanel() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [routing, setRouting] = useState([]);
  const [msg, setMsg] = useState(null);
  const loadSessions = () => api.listSessions().then(setSessions).catch(() => {});
  useEffect(() => {
    api.getPreferences().then(setPrefs).catch(() => {});
    loadSessions();
    if (user?.role === 'admin') api.getModelRouting().then(setRouting).catch(() => {});
  }, [user?.role]);

  async function change(k, v) {
    try { const p = await api.setPreferences({ [k]: v }); setPrefs((s) => ({ ...s, preferences: p })); setMsg('Saved.'); } catch (e) { setMsg(e.response?.data?.message || e.message); }
  }

  return (
    <div className="panel-scroll">
      {prefs && (
        <section className="panel-section">
          <h3>Answer preferences</h3>
          <p className="muted">These only change how answers are written. They can never change data permissions or safety rules.</p>
          <div className="inline-form">
            {Object.keys(prefs.options).map((k) => (
              <label key={k} className="filter-item">{LABELS[k] || k}
                <select className="connect-select" value={prefs.preferences[k]} onChange={(e) => change(k, e.target.value)}>{prefs.options[k].map((v) => <option key={v}>{v}</option>)}</select>
              </label>
            ))}
            {msg && <div className="muted">{msg}</div>}
          </div>
        </section>
      )}
      <section className="panel-section">
        <h3>Your sessions</h3>
        {sessions.map((s) => (
          <div key={s.session_id} className="action-row">
            <div><span className={`status-pill ${s.active ? 'st-ok' : 'st-bad'}`}>{s.active ? (s.current ? 'this device' : 'active') : 'ended'}</span> {s.user_agent || 'unknown device'} <span className="muted">{s.ip || ''} · {new Date(s.created_at).toLocaleString()}</span></div>
            {s.active && !s.current && <button className="link-btn" onClick={() => api.revokeSession(s.session_id).then(loadSessions)}>Sign out this session</button>}
          </div>
        ))}
        {sessions.filter((s) => s.active && !s.current).length > 0 && <button className="link-btn" onClick={() => api.logoutOthers().then(loadSessions)}>Sign out all other sessions</button>}
      </section>
      {routing.length > 0 && (
        <section className="panel-section">
          <h3>Model routing</h3>
          <p className="muted">Which model handles which task. Default is fully local (Ollama); change with OLLAMA_MODEL_SQL / OLLAMA_MODEL_REASONING in .env.</p>
          {routing.map((r) => <div key={r.task} className="quality-issue"><b>{r.task}</b> → {r.provider} · {r.model}</div>)}
        </section>
      )}
    </div>
  );
}
