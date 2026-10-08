import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';

const STATUS_CLS = { pending: 'st-pending', executed: 'st-ok', failed: 'st-bad', rejected: 'st-bad', approved: 'st-ok' };

/** Human-approval workflow for actions (Feature 34). Nothing runs until a manager/admin approves. */
export default function ActionsPanel() {
  const { activeDatasetId } = useAppState();
  const [data, setData] = useState({ actions: [], canApprove: false });
  const [form, setForm] = useState({ to: '', subject: 'CogniCore management report', attach: true, format: 'pdf' });
  const [msg, setMsg] = useState(null);
  const reload = useCallback(() => api.listActions().then(setData).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);

  async function propose(e) {
    e.preventDefault(); setMsg(null);
    try {
      await api.proposeAction({ type: 'send_email', params: { to: form.to.split(/[,\s]+/).filter(Boolean), subject: form.subject, attach: form.attach && activeDatasetId ? { datasetId: activeDatasetId, format: form.format } : null } });
      setForm((f) => ({ ...f, to: '' })); setMsg({ ok: true, text: 'Submitted for approval.' }); reload();
    } catch (err) { setMsg({ ok: false, text: err.response?.data?.message || err.message }); }
  }
  async function decide(id, approve) {
    const note = approve ? null : (window.prompt('Reason for rejecting (optional)') || null);
    try { approve ? await api.approveAction(id) : await api.rejectAction(id, note); } catch (err) { setMsg({ ok: false, text: err.response?.data?.message || err.message }); }
    reload();
  }

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3>Propose an action</h3>
        <form onSubmit={propose} className="inline-form">
          <input className="connect-input" placeholder="Recipient emails (comma separated)" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          <input className="connect-input" placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <label className="check-row"><input type="checkbox" checked={form.attach} onChange={(e) => setForm({ ...form, attach: e.target.checked })} /> Attach management report for the active dataset</label>
          {form.attach && <select className="connect-select" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}><option value="pdf">PDF</option><option value="docx">Word</option><option value="xlsx">Excel</option></select>}
          <button className="connect-submit" type="submit" disabled={!form.to.trim()}>Submit for approval</button>
          {msg && <div className={msg.ok ? 'panel-note' : 'sidebar-error'}>{msg.text}</div>}
        </form>
        <p className="muted">You can also ask in chat: “Email the management report to finance@company.com”. Actions never run until a manager or admin approves them.</p>
      </section>

      <section className="panel-section">
        <h3>{data.canApprove ? 'All requests' : 'Your requests'}</h3>
        {data.actions.length === 0 && <p className="muted">No actions yet.</p>}
        {data.actions.map((a) => (
          <div key={a.action_id} className="action-row">
            <div><span className={`status-pill ${STATUS_CLS[a.status]}`}>{a.status}</span> <strong>{a.type.replace('_', ' ')}</strong> <span className="muted">{a.action_id} · {new Date(a.created_at).toLocaleString()}</span></div>
            <div>{a.summary}</div>
            {a.result && <div className="muted">{a.result.note || a.result.error || JSON.stringify(a.result)}</div>}
            {data.canApprove && a.status === 'pending' && (
              <div className="extra-card-actions">
                <button className="link-btn" onClick={() => decide(a.action_id, true)}>Approve &amp; run</button>
                <button className="link-btn" onClick={() => decide(a.action_id, false)}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
