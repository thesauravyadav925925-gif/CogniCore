/**
 * Server-side chart rendering to SVG (Feature 30: charts -> image).
 * SVG is a real image format (and the browser converts it to PNG for download).
 * Input: a spec from analytics/viz.selectChart + { columns, rows }.
 */
const PALETTE = ['#4F46E5', '#059669', '#D97706', '#DC2626', '#0891B2', '#7C3AED', '#DB2777', '#65A30D'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const short = (s, n = 12) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const fmt = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +Number(n).toFixed(2));
const W = 720, H = 420, M = { l: 70, r: 24, t: 48, b: 80 };

function frame(title, inner, legend = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${W / 2}" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#111">${esc(title || '')}</text>${inner}${legend}</svg>`;
}

function axes(maxV, minV = 0) {
  const ticks = 5, ih = H - M.t - M.b;
  let out = '';
  for (let i = 0; i <= ticks; i++) {
    const v = minV + ((maxV - minV) * i) / ticks;
    const y = M.t + ih - (ih * i) / ticks;
    out += `<line x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}" stroke="#e5e7eb"/><text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#555">${fmt(v)}</text>`;
  }
  return out;
}

const scale = (v, lo, hi, a, b) => (hi === lo ? (a + b) / 2 : a + ((v - lo) / (hi - lo)) * (b - a));

function renderChartSvg(spec, { columns = [], rows = [] } = {}) {
  const type = spec.type;
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  if (type === 'kpi') {
    const cards = spec.cards || [];
    const cw = Math.min(200, (W - 40) / Math.max(cards.length, 1));
    return frame('', cards.map((c, i) => `<rect x="${20 + i * (cw + 10)}" y="120" width="${cw}" height="120" rx="10" fill="#EEF2FF" stroke="#C7D2FE"/><text x="${20 + i * (cw + 10) + cw / 2}" y="175" text-anchor="middle" font-size="26" font-weight="bold" fill="#3730A3">${esc(typeof c.value === 'number' ? fmt(c.value) : c.value)}</text><text x="${20 + i * (cw + 10) + cw / 2}" y="210" text-anchor="middle" font-size="11" fill="#555">${esc(short(c.label, 26))}</text>`).join(''));
  }
  if (type === 'pie') {
    const items = rows.map((r) => ({ label: r[spec.label], v: Math.max(0, num(r[spec.value])) }));
    const total = items.reduce((s, i) => s + i.v, 0) || 1;
    let a0 = -Math.PI / 2; const cx = 250, cy = 230, R = 130;
    const slices = items.map((it, i) => {
      const a1 = a0 + (it.v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = `M ${cx} ${cy} L ${cx + R * Math.cos(a0)} ${cy + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${cx + R * Math.cos(a1)} ${cy + R * Math.sin(a1)} Z`;
      a0 = a1;
      return `<path d="${p}" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff"/>`;
    }).join('');
    const legend = items.map((it, i) => `<rect x="440" y="${90 + i * 24}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/><text x="460" y="${101 + i * 24}" font-size="12" fill="#333">${esc(short(it.label, 22))} — ${((it.v / total) * 100).toFixed(1)}%</text>`).join('');
    return frame(spec.title, slices + legend);
  }
  if (type === 'scatter') {
    const pts = rows.map((r) => [num(r[spec.x]), num(r[spec.y])]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return frame(spec.title, axes(y1, y0) + pts.map(([x, y]) => `<circle cx="${scale(x, x0, x1, M.l, M.l + iw)}" cy="${scale(y, y0, y1, M.t + ih, M.t)}" r="3.5" fill="${PALETTE[0]}" fill-opacity="0.6"/>`).join('') +
      `<text x="${W / 2}" y="${H - 24}" text-anchor="middle" font-size="11" fill="#555">${esc(spec.x)} (${fmt(x0)} – ${fmt(x1)})</text>`);
  }
  if (type === 'histogram') {
    const { histogramBins } = require('../analytics/viz');
    const bins = histogramBins(rows.map((r) => num(r[spec.value])), spec.bins || 10);
    const maxC = Math.max(...bins.map((b) => b.count), 1);
    const bw = iw / bins.length;
    return frame(spec.title, axes(maxC) + bins.map((b, i) => `<rect x="${M.l + i * bw + 1}" y="${M.t + ih - (b.count / maxC) * ih}" width="${bw - 2}" height="${(b.count / maxC) * ih}" fill="${PALETTE[0]}"/><text x="${M.l + i * bw + bw / 2}" y="${H - M.b + 14}" text-anchor="middle" font-size="9" fill="#555" transform="rotate(35 ${M.l + i * bw + bw / 2} ${H - M.b + 14})">${fmt(b.from)}</text>`).join(''));
  }
  if (type === 'line' || type === 'area' || type === 'multi_line') {
    let seriesList;
    let labels;
    if (type === 'multi_line') {
      labels = [...new Set(rows.map((r) => String(r[spec.x])))].sort();
      const groups = [...new Set(rows.map((r) => String(r[spec.series])))];
      seriesList = groups.map((g) => ({ name: g, vals: labels.map((l) => { const r = rows.find((x) => String(x[spec.x]) === l && String(x[spec.series]) === g); return r ? num(r[spec.y]) : null; }) }));
    } else {
      labels = rows.map((r) => String(r[spec.x]));
      seriesList = (Array.isArray(spec.y) ? spec.y : [spec.y]).map((y) => ({ name: y, vals: rows.map((r) => num(r[y])) }));
    }
    const all = seriesList.flatMap((s) => s.vals.filter((v) => v !== null));
    const lo = Math.min(0, ...all), hi = Math.max(...all, 1);
    const xAt = (i) => M.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1));
    const lines = seriesList.map((s, si) => {
      const pts = s.vals.map((v, i) => (v === null ? null : [xAt(i), scale(v, lo, hi, M.t + ih, M.t)])).filter(Boolean);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');
      const area = type === 'area' && pts.length ? `<path d="${d} L ${pts[pts.length - 1][0]} ${M.t + ih} L ${pts[0][0]} ${M.t + ih} Z" fill="${PALETTE[si % PALETTE.length]}" fill-opacity="0.15"/>` : '';
      return area + `<path d="${d}" fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="2.5"/>` + pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${PALETTE[si % PALETTE.length]}"/>`).join('');
    }).join('');
    const step = Math.ceil(labels.length / 10);
    const xl = labels.map((l, i) => (i % step ? '' : `<text x="${xAt(i)}" y="${H - M.b + 16}" text-anchor="middle" font-size="10" fill="#555" transform="rotate(30 ${xAt(i)} ${H - M.b + 16})">${esc(short(l, 10))}</text>`)).join('');
    const legend = seriesList.length > 1 ? seriesList.map((s, i) => `<rect x="${M.l + i * 110}" y="${H - 22}" width="10" height="10" fill="${PALETTE[i % PALETTE.length]}"/><text x="${M.l + i * 110 + 14}" y="${H - 13}" font-size="10" fill="#333">${esc(short(s.name, 12))}</text>`).join('') : '';
    return frame(spec.title, axes(hi, lo) + lines + xl, legend);
  }
  // bar family
  const horizontal = type === 'horizontal_bar';
  const catKey = spec.x;
  const stacked = type === 'stacked_bar';
  let cats, series;
  if (stacked) {
    cats = [...new Set(rows.map((r) => String(r[spec.x])))];
    const groups = [...new Set(rows.map((r) => String(r[spec.series])))];
    series = groups.map((g) => ({ name: g, vals: cats.map((c) => rows.filter((r) => String(r[spec.x]) === c && String(r[spec.series]) === g).reduce((s, r) => s + num(r[spec.y]), 0)) }));
  } else {
    cats = rows.map((r) => String(r[catKey]));
    series = (Array.isArray(spec.y) ? spec.y : [spec.y]).map((y) => ({ name: y, vals: rows.map((r) => num(r[y])) }));
  }
  const totals = cats.map((_, i) => (stacked ? series.reduce((s, x) => s + x.vals[i], 0) : Math.max(...series.map((x) => x.vals[i]))));
  const maxV = Math.max(...totals, 1);
  if (horizontal) {
    const bh = ih / cats.length;
    const bars = cats.map((c, i) => `<text x="${M.l - 6}" y="${M.t + i * bh + bh / 2 + 4}" text-anchor="end" font-size="10" fill="#333">${esc(short(c, 14))}</text><rect x="${M.l}" y="${M.t + i * bh + 3}" width="${(series[0].vals[i] / maxV) * iw}" height="${Math.max(bh - 6, 2)}" fill="${PALETTE[0]}"/><text x="${M.l + (series[0].vals[i] / maxV) * iw + 4}" y="${M.t + i * bh + bh / 2 + 4}" font-size="10" fill="#555">${fmt(series[0].vals[i])}</text>`).join('');
    return frame(spec.title, bars);
  }
  const gw = iw / cats.length;
  const bars = cats.map((c, i) => {
    let inner = '';
    if (stacked) {
      let acc = 0;
      series.forEach((s, si) => { const h = (s.vals[i] / maxV) * ih; inner += `<rect x="${M.l + i * gw + gw * 0.15}" y="${M.t + ih - acc - h}" width="${gw * 0.7}" height="${h}" fill="${PALETTE[si % PALETTE.length]}"/>`; acc += h; });
    } else {
      const bw = (gw * 0.7) / series.length;
      series.forEach((s, si) => { const h = (s.vals[i] / maxV) * ih; inner += `<rect x="${M.l + i * gw + gw * 0.15 + si * bw}" y="${M.t + ih - h}" width="${bw - 1}" height="${h}" fill="${PALETTE[si % PALETTE.length]}"/>` + (series.length === 1 ? `<text x="${M.l + i * gw + gw / 2}" y="${M.t + ih - h - 4}" text-anchor="middle" font-size="9" fill="#555">${fmt(s.vals[i])}</text>` : ''); });
    }
    return inner + `<text x="${M.l + i * gw + gw / 2}" y="${H - M.b + 16}" text-anchor="middle" font-size="10" fill="#333" transform="rotate(30 ${M.l + i * gw + gw / 2} ${H - M.b + 16})">${esc(short(c, 12))}</text>`;
  }).join('');
  const legend = series.length > 1 ? series.map((s, i) => `<rect x="${M.l + i * 110}" y="${H - 22}" width="10" height="10" fill="${PALETTE[i % PALETTE.length]}"/><text x="${M.l + i * 110 + 14}" y="${H - 13}" font-size="10" fill="#333">${esc(short(s.name, 12))}</text>`).join('') : '';
  return frame(spec.title, axes(maxV) + bars, legend);
}

module.exports = { renderChartSvg };
