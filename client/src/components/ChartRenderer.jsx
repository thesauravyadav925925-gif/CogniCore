const COLORS = ['#4fd1c5', '#f0a868', '#e5697a', '#7aa2f7', '#c792ea', '#9ece6a'];
const W = 560, H = 300;
const PAD = { top: 24, right: 20, bottom: 44, left: 52 };

export default function ChartRenderer({ spec }) {
  if (!spec) return null;
  if (spec.chartType === 'bar') return <BarChart spec={spec} />;
  if (spec.chartType === 'line') return <LineChart spec={spec} />;
  if (spec.chartType === 'pie') return <PieChart spec={spec} />;
  if (spec.chartType === 'scatter') return <ScatterChart spec={spec} />;
  return <div className="dataset-empty">Unsupported chart type "{spec.chartType}"</div>;
}

function niceMax(max) {
  if (max <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function ChartFrame({ title, children }) {
  return (
    <div className="chart-frame">
      {title && <div className="chart-title">{title}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">{children}</svg>
    </div>
  );
}

function YAxisGrid({ maxVal, ticks = 4 }) {
  const plotH = H - PAD.top - PAD.bottom;
  const lines = [];
  for (let i = 0; i <= ticks; i++) {
    const v = (maxVal / ticks) * i;
    const y = H - PAD.bottom - (plotH * i) / ticks;
    lines.push(
      <g key={i}>
        <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth="1" />
        <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text-faint)" fontFamily="var(--mono)">
          {formatNum(v)}
        </text>
      </g>
    );
  }
  return <>{lines}</>;
}

function XLabels({ labels }) {
  const plotW = W - PAD.left - PAD.right;
  const step = plotW / labels.length;
  return (
    <>
      {labels.map((l, i) => (
        <text
          key={i}
          x={PAD.left + step * i + step / 2}
          y={H - PAD.bottom + 16}
          textAnchor="middle"
          fontSize="9"
          fill="var(--text-faint)"
        >
          {truncateLabel(l)}
        </text>
      ))}
    </>
  );
}

function BarChart({ spec }) {
  const { labels, series, title } = spec;
  const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const groupWidth = plotW / labels.length;
  const barWidth = Math.min(28, (groupWidth * 0.7) / series.length);

  return (
    <ChartFrame title={title}>
      <YAxisGrid maxVal={maxVal} />
      <XLabels labels={labels} />
      {series.map((s, si) => (
        <g key={s.name}>
          {s.values.map((v, i) => {
            const barH = (v / maxVal) * plotH;
            const groupX = PAD.left + groupWidth * i + groupWidth / 2 - (barWidth * series.length) / 2;
            const x = groupX + si * barWidth;
            const y = H - PAD.bottom - barH;
            return <rect key={i} x={x} y={y} width={barWidth - 2} height={barH} fill={COLORS[si % COLORS.length]} rx="2" />;
          })}
        </g>
      ))}
      {series.length > 1 && <Legend series={series} />}
    </ChartFrame>
  );
}

function LineChart({ spec }) {
  const { labels, series, title } = spec;
  const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / Math.max(1, labels.length - 1 || 1);

  return (
    <ChartFrame title={title}>
      <YAxisGrid maxVal={maxVal} />
      <XLabels labels={labels} />
      {series.map((s, si) => {
        const points = s.values.map((v, i) => {
          const x = labels.length > 1 ? PAD.left + step * i : PAD.left + plotW / 2;
          const y = H - PAD.bottom - (v / maxVal) * plotH;
          return `${x},${y}`;
        });
        return (
          <g key={s.name}>
            <polyline points={points.join(' ')} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth="2" />
            {points.map((p, i) => {
              const [x, y] = p.split(',');
              return <circle key={i} cx={x} cy={y} r="3" fill={COLORS[si % COLORS.length]} />;
            })}
          </g>
        );
      })}
      {series.length > 1 && <Legend series={series} />}
    </ChartFrame>
  );
}

function PieChart({ spec }) {
  const { series, title } = spec;
  const total = series.reduce((sum, s) => sum + Math.max(0, s.value), 0) || 1;
  const cx = W / 2 - 60, cy = H / 2, r = Math.min(H, W) / 2 - 50;
  let angle = -90;

  const slices = series.map((s, i) => {
    const fraction = Math.max(0, s.value) / total;
    const sweep = fraction * 360;
    const path = describeArc(cx, cy, r, angle, angle + sweep);
    angle += sweep;
    return { ...s, path, color: COLORS[i % COLORS.length], pct: Math.round(fraction * 100) };
  });

  return (
    <ChartFrame title={title}>
      {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke="var(--bg)" strokeWidth="1.5" />)}
      <g transform={`translate(${cx * 2 - 10}, ${cy - (slices.length * 16) / 2})`}>
        {slices.map((s, i) => (
          <g key={i} transform={`translate(0, ${i * 16})`}>
            <rect width="9" height="9" fill={s.color} rx="2" />
            <text x="14" y="8" fontSize="9" fill="var(--text-muted)">{truncateLabel(s.label, 16)} ({s.pct}%)</text>
          </g>
        ))}
      </g>
    </ChartFrame>
  );
}

function ScatterChart({ spec }) {
  const { series, title, xField, yFields } = spec;
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return <ChartFrame title={title}><text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--text-faint)">No numeric data to plot</text></ChartFrame>;
  }
  const xMax = niceMax(Math.max(...allPoints.map((p) => p.x)));
  const xMin = Math.min(0, ...allPoints.map((p) => p.x));
  const yMax = niceMax(Math.max(...allPoints.map((p) => p.y)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  return (
    <ChartFrame title={title}>
      <YAxisGrid maxVal={yMax} />
      <text x={PAD.left} y={H - PAD.bottom + 30} fontSize="9" fill="var(--text-faint)">{xField} →</text>
      {series.map((s, si) => (
        <g key={s.name}>
          {s.points.map((p, i) => {
            const x = PAD.left + ((p.x - xMin) / (xMax - xMin || 1)) * plotW;
            const y = H - PAD.bottom - (p.y / yMax) * plotH;
            return <circle key={i} cx={x} cy={y} r="3.5" fill={COLORS[si % COLORS.length]} opacity="0.8" />;
          })}
        </g>
      ))}
    </ChartFrame>
  );
}

function Legend({ series }) {
  return (
    <g transform={`translate(${PAD.left}, 8)`}>
      {series.map((s, i) => (
        <g key={s.name} transform={`translate(${i * 90}, 0)`}>
          <rect width="8" height="8" fill={COLORS[i % COLORS.length]} rx="2" />
          <text x="12" y="8" fontSize="9" fill="var(--text-muted)">{truncateLabel(s.name, 12)}</text>
        </g>
      ))}
    </g>
  );
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function truncateLabel(s, n = 10) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function formatNum(n) {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
