/**
 * REPORT EXPORTERS (Features 14 & 30): PDF · DOCX · XLSX · CSV · SVG for a management report.
 */
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { buildDocx } = require('./docx.writer');
const { toCsvBuffer } = require('../tools/export.tool');
const { renderChartSvg } = require('./chart.svg');

const pretty = (c) => String(c).replace(/_/g, ' ');
const fmtV = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : +v.toFixed(2)) : String(v));

function reportBlocks(r) {
  const b = [{ type: 'title', text: r.title }, { type: 'note', text: `Generated ${new Date(r.generatedAt).toLocaleString()} by CogniCore. All figures come from executed queries and deterministic statistics.` }];
  b.push({ type: 'h1', text: 'Executive Summary' }, { type: 'p', text: r.executiveSummary });
  b.push({ type: 'h1', text: 'Key Metrics' });
  b.push(r.keyMetrics.length ? { type: 'table', columns: ['Metric', 'Value'], rows: r.keyMetrics.map((k) => ({ Metric: k.label, Value: `${fmtV(k.value)}${/percent/.test(k.format || '') ? '%' : ''}` })) } : { type: 'p', text: 'No key metrics could be derived.' });
  b.push({ type: 'h1', text: 'Major Trends' });
  if (r.trends.length) r.trends.forEach((t) => b.push({ type: 'bullet', text: t.sentence })); else b.push({ type: 'p', text: 'No time dimension was found, so no trend analysis is included.' });
  b.push({ type: 'h1', text: 'Problems Identified' });
  if (r.problems.length) r.problems.forEach((p) => b.push({ type: 'bullet', text: `[${p.severity}] ${p.text}` })); else b.push({ type: 'p', text: 'No problems were detected.' });
  b.push({ type: 'h1', text: 'Anomalies' });
  if (r.anomalies?.length) r.anomalies.forEach((a) => b.push({ type: 'bullet', text: `${a.table}.${a.measure}: ${a.count} unusual value(s); most extreme ${a.top.slice(0, 3).map((t) => fmtV(t.value)).join(', ')} (median ${fmtV(a.median)}).` })); else b.push({ type: 'p', text: 'No statistical anomalies were detected.' });
  b.push({ type: 'h1', text: 'Category Analysis' });
  if (r.categoryAnalysis.length) r.categoryAnalysis.forEach((c) => b.push({ type: 'h2', text: `${pretty(c.measure)} by ${pretty(c.dimension)}` }, { type: 'p', text: c.sentence })); else b.push({ type: 'p', text: 'No suitable category column was found.' });
  b.push({ type: 'h1', text: 'Recommendations / Areas for Investigation' });
  r.recommendations.forEach((x) => b.push({ type: 'bullet', text: x }));
  b.push({ type: 'h1', text: 'Supporting Data' });
  r.supportingData.forEach((s) => b.push({ type: 'h2', text: s.title }, { type: 'table', columns: s.columns, rows: s.rows.slice(0, 40) }));
  if (r.appendix) {
    b.push({ type: 'h1', text: 'Appendix: Evidence & Methodology' });
    r.appendix.methodology.forEach((m) => b.push({ type: 'bullet', text: m }));
    r.appendix.queries.forEach((q) => b.push({ type: 'h2', text: `${q.section} — ${q.label}` }, { type: 'code', text: q.sql }));
  }
  if (r.notes?.length) r.notes.forEach((n) => b.push({ type: 'note', text: n }));
  return b;
}

function toDocx(report) { return buildDocx(reportBlocks(report), { title: report.title }); }

function toPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (const blk of reportBlocks(report)) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      switch (blk.type) {
        case 'title': doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(blk.text); doc.moveDown(0.2); break;
        case 'h1': doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor('#1f2937').text(blk.text); doc.moveDown(0.2); break;
        case 'h2': doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10.5).fillColor('#374151').text(blk.text); break;
        case 'bullet': doc.font('Helvetica').fontSize(10).fillColor('#222').text(`•  ${blk.text}`, { indent: 6 }); break;
        case 'note': doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#666').text(blk.text); break;
        case 'table': drawTable(doc, blk.columns, blk.rows); break;
        default: doc.font('Helvetica').fontSize(10).fillColor('#222').text(blk.text);
      }
    }
    doc.end();
  });
}

function drawTable(doc, columns, rows) {
  const startX = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colW = width / columns.length, rowH = 16;
  let y = doc.y + 2;
  const header = () => {
    doc.rect(startX, y, width, rowH).fill('#2b2b2b'); doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
    columns.forEach((c, i) => doc.text(String(c).slice(0, 22), startX + i * colW + 4, y + 4, { width: colW - 6, ellipsis: true, lineBreak: false }));
    y += rowH;
  };
  header();
  rows.forEach((r, ri) => {
    if (y > doc.page.height - doc.page.margins.bottom - rowH) { doc.addPage(); y = doc.page.margins.top; header(); }
    if (ri % 2) doc.rect(startX, y, width, rowH).fill('#f5f5f5');
    doc.fillColor('#111').font('Helvetica').fontSize(8);
    columns.forEach((c, i) => doc.text(fmtV(r[c]).slice(0, 26), startX + i * colW + 4, y + 4, { width: colW - 6, ellipsis: true, lineBreak: false }));
    y += rowH;
  });
  doc.y = y + 6; doc.x = doc.page.margins.left;
}

function toXlsx(report) {
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31));
  add('Summary', [[report.title], [`Generated ${report.generatedAt}`], [], ['Executive Summary'], [report.executiveSummary], [], ['Recommendations'], ...report.recommendations.map((x) => [x])]);
  add('Key Metrics', [['Table', 'Metric', 'Value', 'Unit'], ...report.keyMetrics.map((k) => [k.table, k.label, k.value, k.format])]);
  add('Problems', [['Severity', 'Issue'], ...report.problems.map((p) => [p.severity, p.text])]);
  add('Anomalies', [['Table', 'Measure', 'Count', 'Median', 'Most extreme'], ...(report.anomalies || []).map((a) => [a.table, a.measure, a.count, a.median, a.top.map((t) => t.value).join(', ')])]);
  add('Appendix', [['Section', 'Label', 'Query'], ...(report.appendix?.queries || []).map((q) => [q.section, q.label, q.sql]), [], ['Methodology'], ...(report.appendix?.methodology || []).map((m) => [m])]);
  report.supportingData.forEach((s, i) => add(`${i + 1} ${s.title.replace(/[\\/?*[\]:]/g, ' ')}`, [s.columns, ...s.rows.map((r) => s.columns.map((c) => r[c]))]));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function toCsv(report) {
  const rows = report.keyMetrics.map((k) => ({ table: k.table, metric: k.label, value: k.value, unit: k.format || '' }));
  return toCsvBuffer({ columns: ['table', 'metric', 'value', 'unit'], rows });
}

/** Analysis (a validated query result) -> multi-sheet Excel with the data, the SQL and any insights. */
function analysisToXlsx({ question, answer, sql, columns, rows, insights = [], sheetName = 'Data' }) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: columns }), sheetName.slice(0, 31));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Question', question || ''], ['Answer', answer || ''], ['Query', sql || ''], [], ['Insights'], ...insights.map((i) => [i.text || i])]), 'Analysis');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function chartSvgFor(spec, result) { return Buffer.from(renderChartSvg(spec, result), 'utf8'); }

module.exports = { toPdf, toDocx, toXlsx, toCsv, analysisToXlsx, chartSvgFor, reportBlocks };
