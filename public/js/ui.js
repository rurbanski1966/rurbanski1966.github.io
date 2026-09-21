// ---------------------------------------------------------------------------
// Rendering helpers: formatting, date ranges, and the small set of chart
// primitives the dashboard needs (stat tile, meter, bar row).
// ---------------------------------------------------------------------------
import { TIMEZONE, STATUSES, APPT_STATUSES } from './config.js?v=52';

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
   Opens the report as its own real document in a new tab and hands it to the
   browser's native print, instead of screenshotting it with html2canvas.
   Three straight attempts at fixing this the html2canvas way each fixed one
   symptom and broke something else — it has to guess at capture region,
   scroll offset, and viewport reflow, and every guess turned out fragile in
   a way that was impossible to verify without a real browser. Printing has
   none of that: the report is a completely separate document (its own
   <html>/<body>, no overlay on the live app's DOM, no positioning to get
   wrong), and the browser's own layout and pagination engine — the same
   thing that prints any other web page correctly — lays it out. The only
   difference for whoever generates it: they pick "Save as PDF" as the
   destination in the print dialog instead of getting an automatic download.
   -------------------------------------------------------------------------- */
export async function exportHtmlToPdf(html, filename) {
  const win = window.open('', '_blank');
  if (!win) {
    toast('Could not open the report — allow pop-ups for this site and try again.', 'error');
    return;
  }

  win.document.open();
  win.document.write(html);
  win.document.close();
  // The print dialog's suggested filename is the document title.
  win.document.title = filename.replace(/\.pdf$/i, '');

  await new Promise(resolve => {
    if (win.document.readyState === 'complete') resolve();
    else win.addEventListener('load', resolve, { once: true });
  });

  win.focus();
  win.print();
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
