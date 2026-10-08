/**
 * Loose, format-tolerant date parsing shared by profiling, data-quality,
 * trend analysis and forecasting. Pure functions, no I/O.
 */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function validYMD(y, m, d) {
  if (y < 1000 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** Returns { date: Date, format: string } or null. `dayFirst` resolves 01/02/2026 ambiguity. */
function parseDateLoose(value, { dayFirst = true } = {}) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, format: 'date' };
  const s = String(value).trim();
  if (!s || s.length > 40) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const dt = validYMD(+m[1], +m[2], +m[3]);
    return dt ? { date: dt, format: m[4] ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD' } : null;
  }
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) { const dt = validYMD(+m[1], +m[2], +m[3]); return dt ? { date: dt, format: 'YYYY/MM/DD' } : null; }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let d, mo, fmt;
    if (a > 12) { d = a; mo = b; fmt = 'DD/MM/YYYY'; }
    else if (b > 12) { mo = a; d = b; fmt = 'MM/DD/YYYY'; }
    else if (dayFirst) { d = a; mo = b; fmt = 'DD/MM/YYYY'; }
    else { mo = a; d = b; fmt = 'MM/DD/YYYY'; }
    const dt = validYMD(y, mo, d);
    return dt ? { date: dt, format: fmt } : null;
  }
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) { const dt = validYMD(+m[1], +m[2], 1); return dt ? { date: dt, format: 'YYYY-MM' } : null; }

  m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3,9})[ \-,]*(\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] !== undefined || (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const dt = validYMD(+m[3], mo + 1, +m[1]);
    return dt ? { date: dt, format: 'DD Mon YYYY' } : null;
  }
  m = s.match(/^([A-Za-z]{3,9})[ ,]+(\d{1,2})?,?\s*(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    const dt = validYMD(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()] + 1, m[2] ? +m[2] : 1);
    return dt ? { date: dt, format: m[2] ? 'Mon DD YYYY' : 'Mon YYYY' } : null;
  }
  return null;
}

function toIsoDate(d) { return d.toISOString().slice(0, 10); }

/** Bucket key for a date at a grain: day | week | month | quarter | year */
function bucketKey(date, grain = 'month') {
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  switch (grain) {
    case 'year': return String(y);
    case 'quarter': return `${y}-Q${Math.floor((mo - 1) / 3) + 1}`;
    case 'month': return `${y}-${String(mo).padStart(2, '0')}`;
    case 'week': {
      const d = new Date(Date.UTC(y, date.getUTCMonth(), date.getUTCDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - day + 1);
      return toIsoDate(d);
    }
    default: return toIsoDate(date);
  }
}

/** Pick the coarsest grain that still yields >= minBuckets buckets. */
function chooseGrain(dates, minBuckets = 6) {
  for (const g of ['year', 'quarter', 'month', 'week', 'day']) {
    if (new Set(dates.map((d) => bucketKey(d, g))).size >= minBuckets) return g;
  }
  return 'day';
}

module.exports = { parseDateLoose, toIsoDate, bucketKey, chooseGrain };
