import { useState } from 'react';
import { api } from '../services/api';
import ChartRenderer from './ChartRenderer';

const CHART_TYPES = ['bar', 'line', 'pie', 'scatter'];

export default function ToolActions({ evidence, question, answer }) {
  const [chartOpen, setChartOpen] = useState(false);
  const [chartType, setChartType] = useState('bar');
  const [xField, setXField] = useState(evidence.columns[0]);
  const [yField, setYField] = useState(evidence.columns[1] || evidence.columns[0]);
  const [chartSpec, setChartSpec] = useState(null);
  const [chartError, setChartError] = useState(null);
  const [busy, setBusy] = useState(null); // which action is in flight

  async function handleGenerateChart() {
    setChartError(null);
    setBusy('chart');
    try {
      const spec = await api.generateChart({
        datasetId: evidence.dataset_id,
        sql: evidence.query,
        chartType,
        xField,
        yFields: [yField],
      });
      setChartSpec(spec);
    } catch (err) {
      setChartError(err.response?.data?.message || err.message);
      setChartSpec(null);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(format) {
    setBusy(format);
    try {
      await api.exportData({ datasetId: evidence.dataset_id, sql: evidence.query, format, filename: evidence.dataset_name });
    } catch (err) {
      setChartError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleReport() {
    setBusy('report');
    try {
      await api.generateReport({
        datasetId: evidence.dataset_id,
        sql: evidence.query,
        question,
        answer,
        title: `CogniCore Report — ${evidence.dataset_name}`,
      });
    } catch (err) {
      setChartError(err.response?.data?.message || err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tool-actions">
      <div className="tool-actions-row">
        <button className="tool-btn" onClick={() => setChartOpen((o) => !o)}>📊 Chart</button>
        <button className="tool-btn" onClick={() => handleExport('csv')} disabled={busy === 'csv'}>{busy === 'csv' ? '···' : '⬇ CSV'}</button>
        <button className="tool-btn" onClick={() => handleExport('xlsx')} disabled={busy === 'xlsx'}>{busy === 'xlsx' ? '···' : '⬇ Excel'}</button>
        <button className="tool-btn" onClick={handleReport} disabled={busy === 'report'}>{busy === 'report' ? '···' : '📄 PDF Report'}</button>
      </div>

      {chartOpen && (
        <div className="chart-builder">
          <div className="chart-builder-row">
            <select className="connect-select" value={chartType} onChange={(e) => setChartType(e.target.value)}>
              {CHART_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="connect-select" value={xField} onChange={(e) => setXField(e.target.value)}>
              {evidence.columns.map((c) => <option key={c} value={c}>x: {c}</option>)}
            </select>
            <select className="connect-select" value={yField} onChange={(e) => setYField(e.target.value)}>
              {evidence.columns.map((c) => <option key={c} value={c}>y: {c}</option>)}
            </select>
            <button className="tool-btn tool-btn-primary" onClick={handleGenerateChart} disabled={busy === 'chart'}>
              {busy === 'chart' ? 'Building…' : 'Generate'}
            </button>
          </div>
          {chartError && <div className="sidebar-error">{chartError}</div>}
          {chartSpec && <ChartRenderer spec={chartSpec} />}
        </div>
      )}
    </div>
  );
}
