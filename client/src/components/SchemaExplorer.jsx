import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAppState } from '../state/AppState';

export default function SchemaExplorer() {
  const { activeDataset, activeDatasetId } = useAppState();
  const [schemaData, setSchemaData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewTable, setPreviewTable] = useState(null);
  const [docChunks, setDocChunks] = useState(null);

  useEffect(() => {
    if (!activeDatasetId || activeDataset?.status !== 'ready') { setSchemaData(null); setDocChunks(null); return; }
    setLoading(true);
    api.getSchema(activeDatasetId).then((data) => {
      setSchemaData(data);
      if (data.isDocument) {
        api.preview(activeDatasetId, null, 6).then((p) => setDocChunks(p.documentChunks));
      }
    }).finally(() => setLoading(false));
    setPreview(null);
    setPreviewTable(null);
  }, [activeDatasetId, activeDataset?.status]);

  async function loadPreview(tableName) {
    setPreviewTable(tableName);
    setPreview(null);
    const data = await api.preview(activeDatasetId, tableName, 10);
    setPreview(data);
  }

  if (!activeDataset) {
    return <div className="empty-state"><div className="empty-state-title">No dataset selected</div></div>;
  }
  if (activeDataset.status !== 'ready') {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Dataset is {activeDataset.status}</div>
        {activeDataset.error_message && <div className="empty-state-hint">{activeDataset.error_message}</div>}
      </div>
    );
  }
  if (loading || !schemaData) {
    return <div className="empty-state"><div className="empty-state-title">Loading schema…</div></div>;
  }

  if (schemaData.isDocument) {
    const p = schemaData.documentProfile || {};
    return (
      <div className="schema-panel">
        <div className="schema-summary">
          <SummaryStat label="Pages" value={p.pageCount ?? '—'} />
          <SummaryStat label="Chunks" value={p.chunkCount ?? '—'} />
          <SummaryStat label="Characters" value={p.charCount ?? '—'} />
        </div>
        <div className="schema-side-label">Indexed chunks (sample)</div>
        <div className="chunk-list">
          {(docChunks || []).map((c) => (
            <div className="chunk-card" key={c.chunk_index}>
              <div className="chunk-card-meta">
                Chunk {c.chunk_index}{c.page_number ? ` · page ${c.page_number}` : ''}
              </div>
              <div className="chunk-card-text">{c.text.slice(0, 320)}{c.text.length > 320 ? '…' : ''}</div>
            </div>
          ))}
          {docChunks && docChunks.length === 0 && <div className="dataset-empty">No chunks indexed.</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="schema-panel">
      <div className="schema-summary">
        <SummaryStat label="Tables" value={schemaData.summary.tableCount} />
        <SummaryStat label="Columns" value={schemaData.summary.columnCount} />
        <SummaryStat label="Relationships" value={schemaData.summary.relationshipCount} />
      </div>

      <div className="schema-columns">
        <div className="schema-tables">
          {schemaData.schema.tables.map((table) => (
            <div className="schema-table-card" key={table.name}>
              <div className="schema-table-header" onClick={() => loadPreview(table.name)}>
                <span className="schema-table-name">{table.name}</span>
                <span className="schema-table-rows">{table.rowCount} rows</span>
              </div>
              <table className="column-table">
                <tbody>
                  {table.columns.map((col) => (
                    <tr key={col.name}>
                      <td className="col-name">
                        {col.name}
                        {col.primaryKey && <span className="pk-badge">PK</span>}
                      </td>
                      <td className="col-type">{col.type}</td>
                      <td className="col-tag">{schemaData.semanticTags?.[table.name]?.[col.name]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div className="schema-side">
          <div className="schema-side-label">Detected relationships</div>
          {schemaData.relationships.length === 0 && (
            <div className="dataset-empty">No relationships detected between tables.</div>
          )}
          {schemaData.relationships.map((rel, i) => (
            <div className="relationship-card" key={i}>
              <span className="rel-endpoint">{rel.fromTable}.{rel.fromColumn}</span>
              <span className="rel-arrow">→</span>
              <span className="rel-endpoint">{rel.toTable}.{rel.toColumn}</span>
              <span className="rel-method">{rel.method === 'declared_foreign_key' ? 'declared FK' : 'inferred'}</span>
            </div>
          ))}

          {previewTable && (
            <>
              <div className="schema-side-label" style={{ marginTop: 24 }}>Preview: {previewTable}</div>
              {!preview ? (
                <div className="dataset-empty">Loading…</div>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i}>{preview.columns.map((c) => <td key={c}>{String(row[c] ?? '—')}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }) {
  return (
    <div className="summary-stat">
      <div className="summary-stat-value">{value}</div>
      <div className="summary-stat-label">{label}</div>
    </div>
  );
}
