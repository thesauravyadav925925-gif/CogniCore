const PDFDocument = require('pdfkit');

/**
 * REPORT TOOL
 * Section 26 of the spec: QUERY -> VALIDATED DATA -> ANALYSIS -> CHART ->
 * REPORT BUILDER -> PDF/XLSX/PPTX/CSV. This builds the PDF form.
 * RULE #24: Reports must use validated results - the caller always passes
 * a { columns, rows } that came from resolveValidatedResult(), never raw
 * client input.
 */
function buildPdfReport({ title, question, answer, sql, columns, rows, generatedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Header ---
    doc.fontSize(20).fillColor('#111').text(title || 'CogniCore Report', { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#666').text(`Generated ${generatedAt.toLocaleString()}`);
    doc.moveDown(1);

    // --- Question / Answer ---
    if (question) {
      doc.fontSize(12).fillColor('#111').text('Question', { underline: true });
      doc.fontSize(10).fillColor('#333').text(question);
      doc.moveDown(0.8);
    }
    if (answer) {
      doc.fontSize(12).fillColor('#111').text('Answer', { underline: true });
      doc.fontSize(10).fillColor('#333').text(answer);
      doc.moveDown(0.8);
    }

    // --- Query (provenance) ---
    if (sql) {
      doc.fontSize(12).fillColor('#111').text('Query executed', { underline: true });
      doc.fontSize(8).fillColor('#333').font('Courier').text(sql);
      doc.font('Helvetica');
      doc.moveDown(0.8);
    }

    // --- Data table ---
    if (columns && rows) {
      doc.fontSize(12).fillColor('#111').text(`Data (${rows.length} row${rows.length !== 1 ? 's' : ''})`, { underline: true });
      doc.moveDown(0.3);
      drawTable(doc, columns, rows.slice(0, 200)); // cap rows to keep the PDF sane
      if (rows.length > 200) {
        doc.moveDown(0.3);
        doc.fontSize(8).fillColor('#888').text(`... and ${rows.length - 200} more row(s), truncated for this report.`);
      }
    }

    doc.end();
  });
}

function drawTable(doc, columns, rows) {
  const startX = doc.x;
  const colWidth = Math.min(90, (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columns.length);
  const rowHeight = 16;

  doc.fontSize(8).fillColor('#fff');
  let y = doc.y;
  doc.rect(startX, y, colWidth * columns.length, rowHeight).fill('#333');
  doc.fillColor('#fff');
  columns.forEach((col, i) => {
    doc.text(truncate(col, 14), startX + i * colWidth + 4, y + 4, { width: colWidth - 6, ellipsis: true });
  });
  y += rowHeight;

  doc.fillColor('#111');
  for (const row of rows) {
    if (y > doc.page.height - doc.page.margins.bottom - rowHeight) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    columns.forEach((col, i) => {
      doc.fontSize(8).text(truncate(String(row[col] ?? '—'), 14), startX + i * colWidth + 4, y + 4, { width: colWidth - 6, ellipsis: true });
    });
    y += rowHeight;
  }
  doc.y = y + 4;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { buildPdfReport };
