import { useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';

export default function ApiConnectForm({ onDone }) {
  const { refreshDatasets, setActiveDatasetId } = useAppState();
  const [form, setForm] = useState({ name: '', url: '', method: 'GET', recordsPath: '', headerName: '', headerValue: '', graphql: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (!form.url) return;
    setBusy(true); setError(null);
    try {
      const payload = { url: form.url, name: form.name || undefined, recordsPath: form.recordsPath || undefined };
      if (form.headerName && form.headerValue) payload.headers = { [form.headerName]: form.headerValue };
      if (form.graphql.trim()) payload.graphql = { query: form.graphql };
      else payload.method = form.method;
      const dataset = await api.connectApi(payload);
      await refreshDatasets();
      setActiveDatasetId(dataset.dataset_id);
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally { setBusy(false); }
  }

  return (
    <form className="connect-form" onSubmit={submit}>
      <input className="connect-input" placeholder="https://api.example.com/orders" value={form.url} onChange={(e) => set('url', e.target.value)} />
      <div className="connect-form-row">
        <input className="connect-input" placeholder="Display name (optional)" value={form.name} onChange={(e) => set('name', e.target.value)} />
        <select className="connect-select" value={form.method} onChange={(e) => set('method', e.target.value)} disabled={!!form.graphql.trim()}>
          <option>GET</option><option>POST</option>
        </select>
      </div>
      <input className="connect-input" placeholder='Records path, e.g. data.items (optional)' value={form.recordsPath} onChange={(e) => set('recordsPath', e.target.value)} />
      <div className="connect-form-row">
        <input className="connect-input" placeholder="Header name (e.g. Authorization)" value={form.headerName} onChange={(e) => set('headerName', e.target.value)} />
        <input className="connect-input" type="password" placeholder="Header value" value={form.headerValue} onChange={(e) => set('headerValue', e.target.value)} />
      </div>
      <textarea className="connect-input" rows={3} placeholder="GraphQL query (optional — leave empty for REST)" value={form.graphql} onChange={(e) => set('graphql', e.target.value)} />
      {error && <div className="sidebar-error">{error}</div>}
      <button className="connect-submit" type="submit" disabled={busy}>{busy ? 'Fetching…' : 'Import from API'}</button>
      <div className="connect-hint">The API is fetched once and loaded like an upload. Header values are used for that single request and never stored.</div>
    </form>
  );
}
