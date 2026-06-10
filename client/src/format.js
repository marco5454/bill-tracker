// Formatting + DOM helpers. All HTML insertion goes through escapeHtml.

const ESCAPE_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};

export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

export function formatCurrency(amount, currency = '\u20b1') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${currency}0.00`;
  return `${currency}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function monthShort(idx) { return MONTHS_SHORT[idx] || ''; }
export function monthLong(idx)  { return MONTHS_LONG[idx] || ''; }

export function formatDate(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function todayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function ymKey(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function ymLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[(m || 1) - 1]} ${y}`;
}

export function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

export function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86_400_000);
}

// CSV cell escape — quotes wrap if field contains comma, quote, or newline; internal quotes doubled.
export function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
