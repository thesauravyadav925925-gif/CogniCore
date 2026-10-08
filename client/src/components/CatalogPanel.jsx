import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import { useAuth } from '../state/AuthState';

/** Semantic data catalog (blueprint #4): dataset card, entities, attributes and editable business meanings. */
export default function CatalogPanel() {
  const { activeDataset } = useAppState();
  const { user } = useAuth();
  const id = activeDataset?.dataset_id;
  const canEdit = ['admin', 'manager'].includes(user?.role);
  const [cat, setCat] = useState(null);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => { if (id) api.getCatalog(id).then(setCat).catch((e) => setError(e.response?.data?.message || e.message)); }, [id]);
  useEffect(() => { setCat(null); setError(null); load(); }, [load]);

  if (!activeDataset) return <div className="empty-state"><div className="empty-state-title">Select a dataset</div></div>;
  if (error) return <div className="panel-scroll"><div className="sidebar-error">{error}</div></div>;
  if (!cat) return <div className="empty-state"><div className="empty-state-title">Loading catalog…</div></div>;
  const d = cat.dataset;

  async function save(entity, attr) {
    try { await api.setMeaning(id, { table: entity, column: attr, meaning: edit.text }); setEdit(null); load(); } catch (e) { setError(e.response?.data?.message || e.message); }
  }

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3>{d.name} <span className="muted">· {d.type}</span></h3>
        <div className="kpi-cards">
          <div className="kpi-card"><div className="kpi-value">{d.tables}</div><div className="kpi-label">entities (tables)</div></div>
          <div className="kpi-card"><div className="kpi-value">{d.total_rows.toLocaleString()}</div><div className="kpi-label">rows</div></div>
          <div className="kpi-card"><div className="kpi-value">{d.quality_score ?? '—'}</div><div className="kpi-label">quality score</div></div>
          <div className="kpi-card"><div className="kpi-value">{d.annotated_attributes}</div><div className="kpi-label">business meanings</div></div>
        </div>
        <div className="prov-grid">
          <div><b>Owner</b> {d.owner ? `${d.owner.name} (${d.owner.email})` : '—'}</div>
          <div><b>Source</b> {d.source.kind}{d.source.host ? ` · ${d.source.host}` : ''}</div>
          <div><b>Ingested</b> {d.freshness.ingested_at ? new Date(d.freshness.ingested_at).toLocaleString() : '—'}</div>
          <div><b>Latest record</b> {d.freshness.latest_record_date || '—'}</div>
        </div>
      </section>
      {cat.entities.map((e) => (
        <section key={e.entity} className="panel-section">
          <h3>{e.entity} <span className="muted">· {e.rows.toLocaleString()} rows{e.key ? ` · key: ${e.key}` : ''}</span></h3>
          {e.relationships.length > 0 && <div className="muted">Relationships: {e.relationships.map((r) => `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`).join(' · ')}</div>}
          <table className="catalog-table">
            <thead><tr><th>Attribute</th><th>Role</th><th>Meaning</th><th>Missing</th></tr></thead>
            <tbody>
              {e.attributes.map((a) => (
                <tr key={a.name}>
                  <td><b>{a.name}</b>{a.pii ? <span className="badge badge-warn">{a.pii}</span> : null}</td>
                  <td>{a.role}</td>
                  <td>
                    {edit?.entity === e.entity && edit?.attr === a.name ? (
                      <span><input className="connect-input" value={edit.text} onChange={(ev) => setEdit({ ...edit, text: ev.target.value })} placeholder="What does this column mean?" />
                        <button className="link-btn" onClick={() => save(e.entity, a.name)}>Save</button><button className="link-btn" onClick={() => setEdit(null)}>Cancel</button></span>
                    ) : (
                      <span>{a.business_meaning || <span className="muted">{a.auto_description}{a.values?.length ? ` (${a.values.join(', ')})` : ''}</span>}
                        {canEdit && <button className="link-btn" onClick={() => setEdit({ entity: e.entity, attr: a.name, text: a.business_meaning || '' })}>✎</button>}
                        {canEdit && a.business_meaning && <button className="link-btn" onClick={() => api.removeMeaning(id, e.entity, a.name).then(load)}>✕</button>}</span>
                    )}
                  </td>
                  <td>{a.missing || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {cat.document && <section className="panel-section"><h3>Document</h3><div className="muted">{cat.document.pages ?? '?'} pages/slides · sections: {(cat.document.sections || []).slice(0, 12).join(', ') || 'none detected'}</div></section>}
    </div>
  );
}
