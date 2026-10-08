import { useRef, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';
import { useAuth } from '../state/AuthState';
import ConnectDatabaseForm from './ConnectDatabaseForm';

const STATUS_META = {
  ready: { label: 'Ready', className: 'status-ready' },
  processing: { label: 'Processing', className: 'status-processing' },
  error: { label: 'Error', className: 'status-error' },
};

const TYPE_LABEL = {
  sqlite: 'SQLite',
  csv: 'CSV',
  xlsx: 'Excel',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  json: 'JSON',
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'Text',
};

export default function Sidebar() {
  const { datasets, activeDatasetId, setActiveDatasetId, linkedDatasetIds, toggleLinkedDataset, refreshDatasets, loadingDatasets } = useAppState();
  const { user, logout } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('upload'); // 'upload' | 'connect'
  const inputRef = useRef(null);

  async function handleFiles(files) {
    if (!files || !files.length) return;
    setUploading(true);
    setError(null);
    setProgress(0);
    try {
      for (const file of files) {
        const dataset = await api.uploadFile(file, setProgress);
        await refreshDatasets();
        setActiveDatasetId(dataset.dataset_id);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setUploading(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleDelete(e, id) {
    e.stopPropagation();
    if (!confirm('Remove this dataset?')) return;
    await api.deleteDataset(id);
    await refreshDatasets();
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">CC</span>
        <div>
          <div className="brand-name">CogniCore</div>
          <div className="brand-tagline">Data Intelligence Platform</div>
        </div>
      </div>

      <div className="source-mode-toggle">
        <button className={`mode-btn ${mode === 'upload' ? 'mode-btn-active' : ''}`} onClick={() => setMode('upload')}>Upload file</button>
        <button className={`mode-btn ${mode === 'connect' ? 'mode-btn-active' : ''}`} onClick={() => setMode('connect')}>Connect database</button>
      </div>

      {mode === 'upload' ? (
        <>
          <div
            className={`dropzone ${uploading ? 'dropzone-busy' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3,.csv,.xlsx,.xls,.json,.pdf,.docx,.txt,.md"
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
            {uploading ? (
              <div className="dropzone-progress">
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
                <span>Ingesting… {progress}%</span>
              </div>
            ) : (
              <>
                <div className="dropzone-title">Upload dataset</div>
                <div className="dropzone-hint">SQLite · CSV · Excel · JSON · PDF · DOCX · TXT — drop or click</div>
              </>
            )}
          </div>
          {error && <div className="sidebar-error">{error}</div>}
        </>
      ) : (
        <ConnectDatabaseForm onDone={() => setMode('upload')} />
      )}

      <div className="sidebar-section-label">Datasets {loadingDatasets && '· loading'}</div>
      {datasets.length > 1 && (
        <div className="hybrid-hint">Check 2+ datasets to ask a question spanning both (e.g. a spreadsheet + a policy document).</div>
      )}

      <div className="dataset-list">
        {datasets.length === 0 && !loadingDatasets && (
          <div className="dataset-empty">No datasets yet. Upload one to get started.</div>
        )}
        {datasets.map((ds) => {
          const meta = STATUS_META[ds.status] || STATUS_META.processing;
          const active = ds.dataset_id === activeDatasetId;
          const linked = linkedDatasetIds.includes(ds.dataset_id);
          return (
            <div
              key={ds.dataset_id}
              className={`dataset-item ${active ? 'dataset-item-active' : ''}`}
              onClick={() => setActiveDatasetId(ds.dataset_id)}
            >
              <div className="dataset-item-row">
                <label className="dataset-checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={linked}
                    disabled={ds.status !== 'ready'}
                    onChange={() => toggleLinkedDataset(ds.dataset_id)}
                  />
                </label>
                <span className="dataset-name">{ds.name}</span>
                <button className="dataset-remove" onClick={(e) => handleDelete(e, ds.dataset_id)} title="Remove dataset">×</button>
              </div>
              <div className="dataset-item-meta">
                <span className="type-pill">{TYPE_LABEL[ds.type] || ds.type}</span>
                <span className={`status-dot ${meta.className}`} />
                <span className="status-text">{meta.label}</span>
                {ds.status === 'ready' && ds.schema?.tables && (
                  <span className="dataset-table-count">
                    {ds.schema.tables.length} table{ds.schema.tables.length !== 1 ? 's' : ''}
                  </span>
                )}
                {ds.status === 'ready' && ds.schema?.documentProfile && (
                  <span className="dataset-table-count">
                    {ds.schema.documentProfile.chunkCount ?? ds.profile?.chunkCount ?? 0} chunks
                  </span>
                )}
              </div>
              {ds.status === 'error' && ds.error_message && (
                <div className="dataset-error-msg">{ds.error_message}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="user-badge">
          <div className="user-avatar">{(user?.name || user?.email || '?')[0].toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{user?.name || user?.email}</div>
            <div className="user-role">{user?.role}</div>
          </div>
        </div>
        <button className="logout-btn" onClick={logout} title="Sign out">⏻</button>
      </div>
    </aside>
  );
}
