const XLSX = require('xlsx');

/**
 * EXPORT TOOL
 * Produces a downloadable file buffer from validated { columns, rows }.
 * Mechanical only - no LLM involvement, no re-formatting of values beyond
 * what's needed for a valid CSV/XLSX file.
 */
function toCsvBuffer({ columns, rows }) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // CSV/formula injection guard: text cells that a spreadsheet would execute are neutralised.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

function toXlsxBuffer({ columns, rows }, sheetName = 'Data') {
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31)); // Excel sheet name limit
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { toCsvBuffer, toXlsxBuffer };
