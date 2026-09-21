// ---------------------------------------------------------------------------
// Rendering helpers: formatting, date ranges, and the small set of chart
// primitives the dashboard needs (stat tile, meter, bar row).
// ---------------------------------------------------------------------------
import { TIMEZONE, STATUSES, APPT_STATUSES } from './config.js?v=47';

/* --- escaping ------------------------------------------------------------ */
// Every value that reaches innerHTML goes through this. Client names and notes
// are free text typed by users; without escaping, a name containing markup
// would be parsed as HTML.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* --- formatting ---------------------------------------------------------- */
const money0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const money2 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export const fmtMoney = n => money0.format(Number(n) || 0);
export const fmtMoneyExact = n => money2.format(Number(n) || 0);
export const fmtNum = n => new Intl.NumberFormat('en-US').format(Number(n) || 0);

// Rates arrive as fractions, and null means "no denominator yet" — which is a
// different fact from 0% and must not render as one.
export function fmtPct(fraction, digits = 1) {
  if (fraction === null || fraction === undefined) return '—';
  return `${(Number(fraction) * 100).toFixed(digits)}%`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  // A bare YYYY-MM-DD is parsed as UTC midnight; formatting that in a western
  // timezone shows the previous day. Split it and build a local date instead.
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/* --- dates --------------------------------------------------------------- */
// "Today" in the reporting timezone, so the browser and Postgres agree on
// which day a sale lands in regardless of where the user is sitting.
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function range(key) {
  const [y, m, d] = today().split('-').map(Number);
  const now = new Date(y, m - 1, d);
  const start = new Date(now);

  switch (key) {
    case 'today': break;
    case 'week': start.setDate(now.getDate() - now.getDay()); break;
    case 'month': start.setDate(1); break;
    case 'quarter': start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); break;
    case 'year': start.setMonth(0, 1); break;
    case 'last30': start.setDate(now.getDate() - 29); break;
    default: start.setDate(1);
  }
  return { start: iso(start), end: iso(now) };
}

export const RANGES = [
  { value: 'today',   label: 'Today' },
  { value: 'week',    label: 'This week' },
  { value: 'month',   label: 'This month' },
  { value: 'last30',  label: 'Last 30 days' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year',    label: 'This year' },
];

export const monthStart = () => today().slice(0, 8) + '01';

/* --- toasts -------------------------------------------------------------- */
export function toast(message, kind = 'ok') {
  const host = document.getElementById('toaster');
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/* --- chart primitives ---------------------------------------------------- */

// Stat tile — the right form for a single headline number. A one-bar bar
// chart would say the same thing with more ink.
export function statTile({ label, value, note = '', meter = null }) {
  let meterHtml = '';
  if (meter) {
    const pct = Math.min(100, Math.max(0, meter.pct));
    const good = pct >= 100 ? ' meter__fill--good' : '';
    meterHtml =
      `<div class="meter" role="img" aria-label="${esc(meter.aria)}">` +
      `<div class="meter__fill${good}" style="width:${pct}%"></div></div>`;
  }
  return `
    <div class="kpi">
      <div class="kpi__label">${esc(label)}</div>
      <div class="kpi__value">${esc(value)}</div>
      ${meterHtml}
      ${note ? `<div class="kpi__note">${note}</div>` : ''}
    </div>`;
}

// Horizontal bar row. Bars are scaled against the largest value in the set,
// never against each row's own max, so lengths stay comparable down the column.
export function barRow({ rank, label, sub, value, display, max, color, highlight = false }) {
  const pct = max > 0 ? Math.max(1.5, (Number(value) / max) * 100) : 0;
  const style = color ? ` style="width:${pct}%;background:${color}"` : ` style="width:${pct}%"`;
  return `
    <div class="bar${highlight ? ' is-me' : ''}">
      <div class="bar__rank">${rank != null ? esc(rank) : ''}</div>
      <div class="bar__label">${esc(label)}${sub ? `<span class="bar__sub">${esc(sub)}</span>` : ''}</div>
      <div class="bar__track"><div class="bar__fill"${style}></div></div>
      <div class="bar__value">${esc(display)}</div>
    </div>`;
}

export function legend(items) {
  return `<div class="legend">${items
    .map(i => `<span class="legend__item"><span class="legend__swatch" style="background:${i.color}"></span>${esc(i.label)}</span>`)
    .join('')}</div>`;
}

// Multi-series line chart over a fixed set of x labels (one point per bucket).
// A null value means "no calls that bucket" — never drawn as zero and never
// bridged by a line to its neighbors, since a gap and a bad score are
// different facts and a connecting line would claim data that isn't there.
// viewBox scaling (not a fixed pixel width) is what makes this responsive
// down to phone width without a resize handler.
export function lineChart({ series, labels, min = 0, max = 100, height = 220 }) {
  const width = 640;
  const padL = 32, padR = 12, padT = 12, padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const n = labels.length;
  const xFor = i => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1));
  const yFor = v => padT + innerH - ((v - min) / (max - min)) * innerH;

  const gridLines = [0, 25, 50, 75, 100]
    .filter(v => v >= min && v <= max)
    .map(v => `
      <line x1="${padL}" y1="${yFor(v)}" x2="${width - padR}" y2="${yFor(v)}" class="chart-grid" />
      <text x="${padL - 6}" y="${yFor(v) + 4}" text-anchor="end" class="chart-axis">${v}</text>`)
    .join('');

  const xLabels = labels
    .map((l, i) => `<text x="${xFor(i)}" y="${height - 4}" text-anchor="middle" class="chart-axis">${esc(l)}</text>`)
    .join('');

  const seriesSvg = series.map(s => {
    // Split into runs of consecutive non-null points — each run is its own
    // polyline, so a gap breaks the line instead of interpolating through it.
    const runs = [];
    let run = [];
    s.values.forEach((v, i) => {
      if (v == null) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push([xFor(i), yFor(v)]);
      }
    });
    if (run.length) runs.push(run);

    const dash = s.dashed ? ' stroke-dasharray="5,4"' : '';
    const lines = runs
      .map(r => `<polyline points="${r.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2"${dash} />`)
      .join('');
    const dots = s.values
      .map((v, i) => (v == null ? '' : `<circle cx="${xFor(i)}" cy="${yFor(v)}" r="3" fill="${s.color}" />`))
      .join('');
    return lines + dots;
  }).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="linechart" role="img" aria-label="Trend chart">
      ${gridLines}
      ${seriesSvg}
      ${xLabels}
    </svg>`;
}

// Up/down/flat indicator comparing the latest bucket to the one before it.
// Text alongside the arrow, never color alone, same reasoning as statusChip.
export function trendDelta(current, previous, { higherIsBetter = true, digits = 1, suffix = '' } = {}) {
  if (current == null || previous == null) return '<span class="muted">—</span>';
  const delta = Number(current) - Number(previous);
  const rounded = Math.abs(delta).toFixed(digits);
  if (Math.abs(delta) < Math.pow(10, -digits) / 2) {
    return `<span class="trend trend--flat">→ flat</span>`;
  }
  const up = delta > 0;
  const good = up === higherIsBetter;
  const arrow = up ? '▲' : '▼';
  return `<span class="trend trend--${good ? 'good' : 'bad'}">${arrow} ${rounded}${suffix} vs prior</span>`;
}

/* --- PDF export ------------------------------------------------------------
   Loaded from cdnjs on first use rather than bundled, since only a couple of
   views ever generate a PDF and most sessions never touch this path — cached
   so a second export on any view reuses the same <script> tag instead of
   injecting it again.
   -------------------------------------------------------------------------- */
let html2pdfReady = null;
export function loadHtml2Pdf() {
  if (window.html2pdf) return Promise.resolve();
  if (html2pdfReady) return html2pdfReady;
  html2pdfReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js';
    s.onload = () => resolve();
    s.onerror = () => { html2pdfReady = null; reject(new Error('Could not load the PDF library — check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return html2pdfReady;
}

// Renders a self-contained HTML document string (its own <style>, its own
// <body>) to a PDF, opened in a new tab and downloaded. The document's CSS
// still targets `body` — scoped to .lana-pdf-root here instead, or it would
// leak onto the real app body while the render container is attached.
//
// html2canvas only captures pixels the browser actually paints —
// position:fixed with a large negative offset and an overflow:hidden
// ancestor both render blank, so the container goes in normal flow, appended
// last, and is gone again before this function returns. table-layout:fixed
// plus overflow-wrap on the document's own cells is still the caller's job —
// this only rasterizes what it's given, so a table that overflows the fixed
// 860px width still gets clipped on the right by html2canvas either way.
export async function exportHtmlToPdf(html, filename) {
  await loadHtml2Pdf();

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const scopedCss = (parsed.querySelector('style')?.textContent || '')
    .replace(/\bbody\b/g, '.lana-pdf-root');

  const container = document.createElement('div');
  container.className = 'lana-pdf-root';
  container.style.cssText = 'width:860px; background:#fff;';
  container.innerHTML = `<style>${scopedCss}</style>${parsed.body.innerHTML}`;
  document.body.appendChild(container);

  try {
    const pdf = await window.html2pdf()
      .set({
        margin: 24,
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'pt', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(container)
      .toPdf()
      .get('pdf');

    const win = window.open(pdf.output('bloburl'), '_blank');
    if (!win) toast('PDF generated, but the pop-up was blocked — allow pop-ups to view it, or check your downloads.', 'error');
    pdf.save(filename);
  } finally {
    container.remove();
  }
}

// Status chips carry an icon and a word, so state never rides on color alone.
function chip(set, value) {
  const s = set.find(x => x.value === value);
  if (!s) return esc(value);
  return `<span class="chip chip--${s.tone}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
}

export const statusChip = status => chip(STATUSES, status);
export const apptChip = status => chip(APPT_STATUSES, status);

export const empty = msg => `<div class="empty">${esc(msg)}</div>`;
export const spinner = () => `<div class="spinner">Loading…</div>`;

export function selectField(id, label, options, selected) {
  return `
    <label class="field">
      <span>${esc(label)}</span>
      <select id="${esc(id)}">
        ${options.map(o =>
          `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`
        ).join('')}
      </select>
    </label>`;
}
