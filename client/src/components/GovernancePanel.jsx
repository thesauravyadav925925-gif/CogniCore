import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';

/** Data-level security (column/row policies) + organizational knowledge (business definitions). */
export default function GovernancePanel() {
  const { activeDataset } = useAppState();
  const id = activeDataset?.dataset_id;
  const [pol, setPol] = useState({ policies: [], roles: [] });
  const [kn, setKn] = useState({ entries: [], kinds: [] });
  const [pf, setPf] = useState({ role: 'viewer', kind: 'deny_column', columnName: '', op: '=', value: '' });
  const [kf, setKf] = useState({ term: '', definition: '', kind: 'glossary', scopeDataset: true });
  const [err, setErr] = useState(null);

  const reload = useCallback(() => {
    if (!id) return;
    api.listPolicies(id).then(setPol).catch((e) => setErr(e.response?.data?.message || e.message));
    api.listKnowledge(id).then(setKn).catch(() => {});
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (!activeDataset) return <div className="empty-state"><div className="empty-state-title">No dataset selected</div></div>;
  const columns = [...new Set((activeDataset.schema?.tables || []).flatMap((t) => t.columns.map((c) => c.name)))];

  async function addPolicy(e) {
    e.preventDefault(); setErr(null);
    try {
      await api.addPolicy(id, { role: pf.role, kind: pf.kind, columnName: pf.columnName, ...(pf.kind === 'row_filter' ? { op: pf.op, value: pf.value } : {}) });
      setPf({ ...pf, columnName: '', value: '' }); reload();
    } catch (er) { setErr(er.response?.data?.message || er.message); }
  }
  async function addKnowledge(e) {
    e.preventDefault(); setErr(null);
    try { await api.addKnowledge({ scope: kf.scopeDataset ? id : '*', kind: kf.kind, term: kf.term, definition: kf.definition }); setKf({ ...kf, term: '', definition: '' }); reload(); }
    catch (er) { setErr(er.response?.data?.message || er.message); }
  }

  return (
    <div className="panel-scroll">
      {err && <div className="sidebar-error">{err}</div>}
      <section className="panel-section">
        <h3>Access policies <span className="muted">· {activeDataset.name}</span></h3>
        <p className="muted">Enforced in the data layer on every query, chart and export — not by the AI. Admins are never restricted. Use <code>{'{{user.name}}'}</code> or <code>{'{{user.email}}'}</code> in a row filter to confine people to their own records.</p>
        <form className="inline-form" onSubmit={addPolicy}>
          <div className="connect-form-row">
            <select className="connect-select" value={pf.role} onChange={(e) => setPf({ ...pf, role: e.target.value })}>{pol.roles.map((r) => <option key={r} value={r}>{r === '*' ? 'everyone (non-admin)' : r}</option>)}</select>
            <select className="connect-select" value={pf.kind} onChange={(e) => setPf({ ...pf, kind: e.target.value })}><option value="deny_column">Hide column</option><option value="row_filter">Limit rows</option></select>
          </div>
          <input className="connect-input" list="gov-cols" placeholder="Column" value={pf.columnName} onChange={(e) => setPf({ ...pf, columnName: e.target.value })} />
          <datalist id="gov-cols">{columns.map((c) => <option key={c} value={c} />)}</datalist>
          {pf.kind === 'row_filter' && (
            <div className="connect-form-row">
              <select className="connect-select" value={pf.op} onChange={(e) => setPf({ ...pf, op: e.target.value })}><option>=</option><option>!=</option><option>IN</option></select>
              <input className="connect-input" placeholder="Value or {{user.name}}" value={pf.value} onChange={(e) => setPf({ ...pf, value: e.target.value })} />
            </div>
          )}
          <button className="connect-submit" disabled={!pf.columnName}>Add policy</button>
        </form>
        {pol.policies.map((p) => (
          <div key={p.policy_id} className="action-row">
            <div><strong>{p.role === '*' ? 'everyone' : p.role}</strong>: {p.kind === 'deny_column' ? `cannot see “${p.column_name}”` : `sees only rows where ${p.column_name} ${p.op} ${p.value}`}</div>
            <button className="link-btn" onClick={() => api.deletePolicy(id, p.policy_id).then(reload)}>Remove</button>
          </div>
        ))}
      </section>

      <section className="panel-section">
        <h3>Business knowledge</h3>
        <p className="muted">Definitions the AI must follow, e.g. “Active customer = at least one order in the last 90 days”. They persist across sessions and users.</p>
        <form className="inline-form" onSubmit={addKnowledge}>
          <div className="connect-form-row">
            <input className="connect-input" placeholder="Term (e.g. Revenue)" value={kf.term} onChange={(e) => setKf({ ...kf, term: e.target.value })} />
            <select className="connect-select" value={kf.kind} onChange={(e) => setKf({ ...kf, kind: e.target.value })}>{kn.kinds.map((k) => <option key={k}>{k}</option>)}</select>
          </div>
          <textarea className="connect-input" rows={2} placeholder="Definition" value={kf.definition} onChange={(e) => setKf({ ...kf, definition: e.target.value })} />
          <label className="check-row"><input type="checkbox" checked={kf.scopeDataset} onChange={(e) => setKf({ ...kf, scopeDataset: e.target.checked })} /> Only for this dataset</label>
          <button className="connect-submit" disabled={!kf.term || !kf.definition}>Save definition</button>
        </form>
        {kn.entries.map((k) => (
          <div key={k.id} className="action-row">
            <div><strong>{k.term}</strong> <span className="muted">({k.kind}{k.scope === '*' ? ', org-wide' : ''})</span><div>{k.definition}</div></div>
            <button className="link-btn" onClick={() => api.deleteKnowledge(k.id).then(reload)}>Remove</button>
          </div>
        ))}
      </section>
    </div>
  );
}
