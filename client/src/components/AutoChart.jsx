import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Automatic visualization (Feature 8). The server picks the chart type from the
 * result's shape (chart.type) and renders it as SVG from live data; this component
 * just shows that image and lets the user download it.
 */
/** Converts the SVG image to a PNG in the browser (no server image library needed). */
function svgUrlToPng(url, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = (img.naturalWidth || 720) * scale; canvas.height = (img.naturalHeight || 420) * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not render the chart'));
    img.src = url;
  });
}

export default function AutoChart({ chart, datasetId, sql, question }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl = null;
    if (!chart || !datasetId || !sql || chart.type === 'kpi') return undefined;
    api.chartSvgUrl({ datasetId, sql, question })
      .then((u) => { objectUrl = u; if (!revoked) setUrl(u); })
      .catch((e) => !revoked && setError(e.response?.status === 422 ? null : 'Chart unavailable'));
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [chart?.type, datasetId, sql, question]);

  if (!chart) return null;
  if (chart.type === 'kpi') {
    return (
      <div className="kpi-cards">
        {chart.cards.map((c) => (
          <div className="kpi-card" key={c.label}>
            <div className="kpi-value">{typeof c.value === 'number' ? c.value.toLocaleString() : String(c.value)}</div>
            <div className="kpi-label">{c.label}</div>
          </div>
        ))}
      </div>
    );
  }
  if (error || !url) return null;
  return (
    <div className="auto-chart">
      <img src={url} alt={chart.title || 'chart'} />
      <div className="auto-chart-bar">
        <span>{chart.title} · {chart.type.replace('_', ' ')}</span>
        <span>
          <button className="link-btn" onClick={async () => { const b = await svgUrlToPng(url); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'chart.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }}>PNG</button>
          <button className="link-btn" onClick={() => api.downloadChartSvg({ datasetId, sql, question })}>SVG</button>
        </span>
      </div>
    </div>
  );
}
