// ---------------------------------------------------------------------------
// Rendering helpers: formatting, date ranges, and the small set of chart
// primitives the dashboard needs (stat tile, meter, bar row).
// ---------------------------------------------------------------------------
import { TIMEZONE, STATUSES, APPT_STATUSES } from './config.js?v=43';

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
