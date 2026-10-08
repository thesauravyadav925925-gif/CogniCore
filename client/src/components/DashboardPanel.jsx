import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import AutoChart from './AutoChart';

const fmt = (v, unit) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit === 'percent' || unit === 'percent_change' ? `${n}%` : n;
};

/** Auto-generated dashboard with filters and drill-down (blueprint #20, #24). Panels re-query live data. */
export default function DashboardPanel() {
  const { activeDataset } = useAppState();
  const id = activeDataset?.dataset_id;
  const [dash, setDash] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [filters, setFilters] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => { setFilters({}); setKpis(null); if (id) api.getKpis(id).then(setKpis).catch(() => {}); }, [id]);
  useEffect(() => {
    if (!id) return;
    setError(null);
    api.getDashboard(id, filters).then(setDash).catch((e) => { setDash(null); setError(e.response?.data?.message || e.message); });
  }, [id, JSON.stringify(filters)]);

  if (!activeDataset) return <div className="empty-state"><div className="empty-state-title">Select a dataset to see its dashboard</div></div>;
  const setFilter = (col, val) => setFilters((f) => { const n = { ...f }; if (!val) delete n[col]; else n[col] = val; return n; });

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3>Dashboard <span className="muted">· {activeDataset.name}</span></h3>
        {error && <div className="panel-note">{error}</div>}
        {dash?.filters?.length > 0 && (
          <div className="filter-bar">
            {dash.filters.map((f) => (
              <label key={f.column} className="filter-item">{f.column.replace(/_/g, ' ')}
                <select className="connect-select" value={filters[f.column] || ''} onChange={(e) => setFilter(f.column, e.target.value)}>
                  <option value="">All</option>
                  {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
            {Object.keys(filters).length > 0 && <button className="link-btn" onClick={() => setFilters({})}>Clear filters</button>}
          </div>
        )}
        {kpis && (
          <div className="kpi-cards">
            {kpis.flatMap((g) => g.kpis).filter((k) => k.value !== null && !/unique|completeness/i.test(k.label)).slice(0, 6).map((k) => (
              <div className="kpi-card" key={k.id}><div className="kpi-value">{fmt(k.value, k.format)}</div><div className="kpi-label">{k.label}</div></div>
            ))}
          </div>
        )}
        <div className="dash-grid">
          {dash?.panels.map((p) => (
            <div key={`${p.id}-${JSON.stringify(filters)}`} className="dash-panel">
              <div className="dash-title">{p.title}</div>
              <AutoChart chart={{ type: 'auto', title: p.title }} datasetId={id} sql={p.sql} question={p.question} />
            </div>
          ))}
        </div>
        {dash && dash.panels.length === 0 && <p className="muted">Not enough date or numeric columns to build panels for this dataset.</p>}
        {Object.keys(filters).length > 0 && <p className="muted">Showing a drill-down: {Object.entries(filters).map(([k, v]) => `${k} = ${v}`).join(', ')}.</p>}
      </section>
    </div>
  );
}
