import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../state/AuthState';

const ROLES = ['admin', 'manager', 'analyst', 'employee', 'viewer'];
const ROLE_HELP = {
  admin: 'Everything, never restricted by data policies.',
  manager: 'Analyst rights + approve actions, manage policies and business knowledge.',
  analyst: 'Upload/connect data, query, reports, Python tool, propose actions.',
  employee: 'Query, charts, exports — confine to own records with a row policy.',
  viewer: 'Query and charts only; sensitive fields are masked.',
};

/** Admin only: users & roles (Feature 22) and the audit log (Feature 24). */
export default function AdminPanel() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [err, setErr] = useState(null);
  const load = () => { api.listUsers().then(setUsers).catch((e) => setErr(e.response?.data?.message || e.message)); api.listAudit(60).then(setAudit).catch(() => {}); };
  useEffect(load, []);

  async function change(id, role) {
    setErr(null);
    try { await api.setUserRole(id, role); load(); } catch (e) { setErr(e.response?.data?.message || e.message); }
  }
  const detail = (d) => { try { const o = typeof d === 'string' ? JSON.parse(d) : d; return o?.question || o?.sql || o?.capability || o?.type || ''; } catch (_) { return ''; } };

  return (
    <div className="panel-scroll">
      {err && <div className="sidebar-error">{err}</div>}
      <section className="panel-section">
        <h3>Users &amp; roles</h3>
        {users.map((u) => (
          <div key={u.user_id} className="action-row">
            <div><strong>{u.name || u.email}</strong> <span className="muted">{u.email}</span></div>
            <div className="extra-card-actions">
              <select className="connect-select" value={ROLES.includes(u.role) ? u.role : 'analyst'} disabled={u.user_id === me?.user_id} onChange={(e) => change(u.user_id, e.target.value)}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <span className="muted">{ROLE_HELP[u.role] || ROLE_HELP.analyst}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="panel-section">
        <h3>Audit log <span className="muted">· latest {audit.length}</span></h3>
        {audit.map((a, i) => (
          <div key={i} className="quality-issue">
            <span className="sev-tag">{a.success ? 'ok' : 'fail'}</span>
            <strong>{a.action}</strong> <span className="muted">{new Date(a.created_at || a.timestamp).toLocaleString()}</span>
            <div className="muted">{detail(a.details)}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
