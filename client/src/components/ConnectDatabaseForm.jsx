import { useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import ApiConnectForm from './ApiConnectForm';

const DEFAULTS = {
  type: 'postgres',
  name: '',
  host: 'localhost',
  port: '5432',
  database: '',
  user: '',
  password: '',
  ssl: false,
};

export default function ConnectDatabaseForm({ onDone }) {
  const { refreshDatasets, setActiveDatasetId } = useAppState();
  const [form, setForm] = useState(DEFAULTS);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((f) => {
      const next = { ...f, [field]: value };
      // Swap the default port when the DB type changes, unless the user already customized it.
      if (field === 'type') {
        next.port = value === 'postgres' ? '5432' : '3306';
      }
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.host || !form.database || !form.user) return;
    setConnecting(true);
    setError(null);
    try {
      const dataset = await api.connectDatabase({
        ...form,
        port: form.port ? parseInt(form.port, 10) : undefined,
      });
      await refreshDatasets();
      setActiveDatasetId(dataset.dataset_id);
      setForm(DEFAULTS);
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setConnecting(false);
    }
  }

  if (form.type === 'api') {
    return (
      <div>
        <div className="connect-form" style={{ paddingBottom: 0 }}>
          <select className="connect-select" value={form.type} onChange={(e) => update('type', e.target.value)}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="api">REST / GraphQL API</option>
          </select>
        </div>
        <ApiConnectForm onDone={() => { update('type', 'postgres'); onDone?.(); }} />
      </div>
    );
  }

  return (
    <form className="connect-form" onSubmit={handleSubmit}>
      <div className="connect-form-row">
        <select className="connect-select" value={form.type} onChange={(e) => update('type', e.target.value)}>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL / MariaDB</option>
          <option value="api">REST / GraphQL API</option>
        </select>
        <input
          className="connect-input"
          placeholder="Display name (optional)"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
        />
      </div>

      <div className="connect-form-row">
        <input className="connect-input connect-input-wide" placeholder="Host" value={form.host} onChange={(e) => update('host', e.target.value)} />
        <input className="connect-input connect-input-narrow" placeholder="Port" value={form.port} onChange={(e) => update('port', e.target.value)} />
      </div>

      <input className="connect-input" placeholder="Database name" value={form.database} onChange={(e) => update('database', e.target.value)} />

      <div className="connect-form-row">
        <input className="connect-input" placeholder="Username" value={form.user} onChange={(e) => update('user', e.target.value)} />
        <input className="connect-input" type="password" placeholder="Password" value={form.password} onChange={(e) => update('password', e.target.value)} />
      </div>

      <label className="connect-checkbox-row">
        <input type="checkbox" checked={form.ssl} onChange={(e) => update('ssl', e.target.checked)} />
        Use SSL
      </label>

      {error && <div className="sidebar-error">{error}</div>}

      <button className="connect-submit" type="submit" disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
      <div className="connect-hint">Credentials stay on the server — they're never sent back to this browser.</div>
    </form>
  );
}
