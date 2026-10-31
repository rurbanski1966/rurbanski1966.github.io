// ---------------------------------------------------------------------------
// Agent-facing views: dashboard, my sales.
// Every view exports render(main, ctx) and wires its own listeners.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=81';
import { CATEGORIES } from './config.js?v=81';
import {
  esc, fmtMoney, fmtMoneyExact, fmtNum, fmtPct, fmtDate,
  toast, statusChip, empty, spinner, selectField, legend, AGENCY_COLORS,
} from './ui.js?v=81';

const SERIES = {
  mapd:      'var(--series-1)',
  ancillary: 'var(--series-2)',
  combined:  'var(--series-3)',
};

/* === Dashboard ============================================================ */
// Every agency a cost can land in, in the palette's fixed slot order — a
// color follows its agency everywhere (cards, chart, tooltip, table), never
// its rank. The three slots validate all-pairs in both themes (dataviz
// validator). Unassigned is a neutral gray, not a fourth hue: it's a to-do,
// not an agency. `m` is the my_metrics() column prefix.
const AGENCIES = [
  { key: 'SMC',  color: AGENCY_COLORS.SMC,  m: 'smc' },
  { key: 'EWSS', color: AGENCY_COLORS.EWSS, m: 'ewss' },
  { key: 'SBA',  color: AGENCY_COLORS.SBA,  m: 'sba' },
];
const UNASSIGNED = { key: 'Unassigned', color: 'var(--agency-none)', m: 'unassigned' };

const PERIODS = [
  { key: 'daily',   label: 'Today' },
  { key: 'weekly',  label: 'This week' },
  { key: 'monthly', label: 'This month' },
  { key: 'yearly',  label: 'Year to date' },
];
const spendOf = (m, prefix, period) => Number(m[`${prefix ? `${prefix}_` : ''}${period}_spend`] ?? 0);

export async function dashboard(main, ctx) {
  const isAdmin = ctx.profile.role === 'admin';

  main.innerHTML = `
    <div class="page__head">
      <div>
        <h1>Dashboard</h1>
        <div class="page__sub">${esc(ctx.profile.full_name)} · AI spend by agency</div>
      </div>
    </div>
    <div id="spend-overview">${spinner()}</div>
    <div class="card" id="spend-chart">${spinner()}</div>
    ${isAdmin ? `<div class="card" id="agent-spend">${spinner()}</div>` : ''}
    <div class="card" id="recent">${spinner()}</div>`;

  const [m, mine, agentSpend, unassignedCalls] = await Promise.all([
    db.myMetrics(),
    db.mySubmissions({ limit: 8 }),
    isAdmin ? db.agentSpendReport() : Promise.resolve(null),
    isAdmin ? db.unassignedCostCalls() : Promise.resolve([]),
  ]);

  document.getElementById('spend-overview').innerHTML = overviewHtml(m, isAdmin);
  drawSpendChart(document.getElementById('spend-chart'));

  const recent = document.getElementById('recent');
  recent.innerHTML = `
    <div class="card__head">
      <h2>Recent submissions</h2>
      <a class="linkbtn" href="#/my-sales">View all</a>
    </div>
    ${mine.length === 0
      ? empty('No submissions yet.')
      : `<div class="tablewrap"><table>
          <thead><tr>
            <th>Date</th><th>Client</th><th>Product</th>
            <th class="num">AP</th><th>Status</th>
          </tr></thead>
          <tbody>${mine.map(rowHtml).join('')}</tbody>
        </table></div>`}`;

  if (isAdmin) drawAgentSpend(agentSpend);
  if (isAdmin && unassignedCalls.length) drawUnassignedCalls(unassignedCalls);
}

// Spend that belongs to none of SMC, EWSS or SBA. Its card shows only when
// there is some, as a prompt to fix it: every cost is meant to land in one.
const hasUnassigned = m => PERIODS.some(p => spendOf(m, 'unassigned', p.key) > 0);

function overviewHtml(m, isAdmin) {
  const groups = hasUnassigned(m) ? [...AGENCIES, UNASSIGNED] : AGENCIES;
  const monthTotal = spendOf(m, '', 'monthly');
  return `
    <section class="card spend-total">
      <div class="card__head">
        <h2>Total AI spend</h2>
        <span class="muted">All agencies</span>
      </div>
      <div class="spend-total__grid">
        ${PERIODS.map(p => `
          <div class="spend-stat">
            <div class="spend-stat__label">${esc(p.label)}</div>
            <div class="spend-stat__value">${esc(fmtMoneyExact(spendOf(m, '', p.key)))}</div>
          </div>`).join('')}
      </div>
    </section>
    <div class="agency-grid">
      ${groups.map(a => agencyCardHtml(a, m, monthTotal, isAdmin)).join('')}
    </div>
    <p class="dash-note muted">
      AI costs = coaching-rubric scoring, Medicare scorecard grading, and AI review summaries, billed per agency.
      A call's cost goes to its Agency Assigned, or the agent's own team if none was set. Transcription isn't tracked per call.
    </p>`;
}

function agencyCardHtml(a, m, monthTotal, isAdmin) {
  const month = spendOf(m, a.m, 'monthly');
  const share = monthTotal > 0 ? month / monthTotal : 0;
  const isUn = a === UNASSIGNED;
  return `
    <section class="agency-card" style="--agency:${a.color}">
      <header class="agency-card__head">
        <span class="agency-card__swatch" aria-hidden="true"></span>
        <h3>${esc(a.key)}</h3>
        <span class="agency-card__share">${esc(fmtPct(share, 0))} of this month</span>
      </header>
      <div class="agency-card__label">This month</div>
      <div class="agency-card__value">${esc(fmtMoneyExact(month))}</div>
      <div class="agency-card__meter" role="img" aria-label="${esc(a.key)}: ${esc(fmtPct(share, 0))} of this month's AI spend">
        <div style="width:${(share * 100).toFixed(1)}%"></div>
      </div>
      <dl class="agency-card__periods">
        ${PERIODS.filter(p => p.key !== 'monthly').map(p => `
          <div><dt>${esc(p.label)}</dt><dd>${esc(fmtMoneyExact(spendOf(m, a.m, p.key)))}</dd></div>`).join('')}
      </dl>
      ${isUn ? `
        <p class="agency-card__flag">
          <span class="chip chip--warning"><span aria-hidden="true">!</span>Needs an agency</span>
          <span class="muted">${isAdmin ? 'Calls listed below.' : 'Ask an admin to set Agency Assigned.'}</span>
        </p>` : ''}
    </section>`;
}

/* --- Spend by agency chart ------------------------------------------------ */
// One line per agency over a chosen range, bucketed so the line has a
// readable number of points: daily for 30 days, weekly for 90, monthly for
// the year. Hover (or arrow keys) shows every agency's value for that
// bucket; the table view is the same numbers for anyone who'd rather read
// them, and the relief the light-theme SBA aqua needs (below 3:1 contrast).
const CHART_RANGES = [
  { key: '30d', label: '30 days',   bucket: 'day',   unit: 'day' },
  { key: '90d', label: '90 days',   bucket: 'week',  unit: 'week' },
  { key: 'ytd', label: 'This year', bucket: 'month', unit: 'month' },
];
const RANGE_KEY = 'lana.dashboard.range';

const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = iso => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const fmtDay = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

function rangeBounds(range, today) {
  if (range.key === '30d') return { start: addDays(today, -29), end: today };
  if (range.key === '90d') return { start: mondayOf(addDays(today, -90)), end: today };
  return { start: `${today.slice(0, 4)}-01-01`, end: today };
}

const bucketOf = (bucket, day) =>
  bucket === 'day' ? day : bucket === 'week' ? mondayOf(day) : `${day.slice(0, 7)}-01`;

const bucketAxisLabel = (bucket, k) =>
  bucket === 'month' ? fmtDay(k, { month: 'short' }) : fmtDay(k, { month: 'short', day: 'numeric' });

const bucketTitle = (bucket, k) =>
  bucket === 'day' ? fmtDay(k, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  : bucket === 'week' ? `Week of ${fmtDay(k, { month: 'short', day: 'numeric', year: 'numeric' })}`
  : fmtDay(k, { month: 'long', year: 'numeric' });

function loadRange() {
  try { return CHART_RANGES.find(r => r.key === localStorage.getItem(RANGE_KEY)) ?? CHART_RANGES[0]; }
  catch { return CHART_RANGES[0]; }
}
function saveRange(key) {
  try { localStorage.setItem(RANGE_KEY, key); } catch { /* private window: just don't remember */ }
}

async function drawSpendChart(card) {
  let range = loadRange();
  let view = 'chart';

  card.innerHTML = `
    <div class="card__head card__head--wrap">
      <div>
        <h2>Spend by agency</h2>
        <div class="muted" id="sc-sub" style="font-size:12px;margin-top:3px"></div>
      </div>
      <div class="chart-controls">
        <div class="seg" role="group" aria-label="Time range">
          ${CHART_RANGES.map(r => `<button type="button" data-range="${r.key}" aria-pressed="${r.key === range.key}">${esc(r.label)}</button>`).join('')}
        </div>
        <button type="button" class="btn btn--ghost btn--sm" id="sc-view">Table view</button>
      </div>
    </div>
    <div id="sc-body">${spinner()}</div>`;

  const body = card.querySelector('#sc-body');
  const sub = card.querySelector('#sc-sub');
  const viewBtn = card.querySelector('#sc-view');
  let model = null;

  async function load() {
    body.innerHTML = spinner();
    const today = chicagoToday();
    const { start, end } = rangeBounds(range, today);
    const rows = await db.agencySpendDaily(start, end);
    if (rows === null) {
      model = null;
      body.innerHTML = empty('The spend chart needs database migration 045 (agency_spend_daily) to be run in Supabase.');
      return;
    }
    model = buildModel(rows, range);
    sub.textContent = `Billed AI cost per ${range.unit} · ${fmtDay(start, { month: 'short', day: 'numeric' })} – ${fmtDay(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    render();
  }

  function render() {
    if (!model) return;
    if (model.grand === 0) {
      body.innerHTML = empty('No AI spend in this period.');
      return;
    }
    model.W = chartWidth(body.clientWidth);
    body.innerHTML = view === 'chart' ? chartHtml(model) : chartTableHtml(model);
    if (view === 'chart') wireChart(body.querySelector('.agency-chart'), model);
  }

  card.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.range === range.key) return;
    range = CHART_RANGES.find(r => r.key === btn.dataset.range);
    saveRange(range.key);
    card.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  }));
  // Redraw at the new width when the card is resized (phone rotation,
  // sidebar collapse), but not for every pixel of a drag.
  let lastW = 0;
  new ResizeObserver(() => {
    const w = chartWidth(body.clientWidth);
    if (model && view === 'chart' && Math.abs(w - lastW) > 40) { lastW = w; render(); }
  }).observe(body);

  viewBtn.addEventListener('click', () => {
    view = view === 'chart' ? 'table' : 'chart';
    viewBtn.textContent = view === 'chart' ? 'Table view' : 'Chart view';
    render();
  });

  await load();
}

// rows: one per day per category, zeros included (migration 045).
function buildModel(rows, range) {
  const keys = [];
  const sums = new Map();
  for (const r of rows) {
    const k = bucketOf(range.bucket, r.day);
    if (!sums.has(k)) { sums.set(k, {}); keys.push(k); }
    const b = sums.get(k);
    b[r.category] = (b[r.category] ?? 0) + Number(r.total_cost);
  }
  const unTotal = keys.reduce((s, k) => s + (sums.get(k).Unassigned ?? 0), 0);
  const groups = unTotal > 0 ? [...AGENCIES, UNASSIGNED] : AGENCIES;
  const series = groups.map(a => ({ ...a, values: keys.map(k => sums.get(k)[a.key] ?? 0) }));
  const totals = keys.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  return { range, keys, series, totals, grand: totals.reduce((s, v) => s + v, 0) };
}

// A round axis top and step: 1, 2, 2.5 or 5 × a power of ten, ~4 gridlines.
function niceScale(max) {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
  return { top: step * Math.ceil(max / step - 1e-9), step };
}
const axisMoney = v => (v >= 100 ? fmtMoney(v) : fmtMoneyExact(v));

// W is set per render from the card's real width (see drawSpendChart), so
// axis text stays its real size on a phone instead of shrinking with a
// fixed-width viewBox.
const CHART = { H: 260, padL: 56, padR: 84, padT: 14, padB: 26 };
const chartWidth = px => Math.round(Math.min(900, Math.max(320, px || 720)));

function geometry(model) {
  const { H, padL, padR, padT, padB } = CHART;
  const innerW = model.W - padL - padR;
  const innerH = H - padT - padB;
  const n = model.keys.length;
  const max = Math.max(0, ...model.series.flatMap(s => s.values));
  const { top, step } = niceScale(max);
  const xFor = i => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1));
  const yFor = v => padT + innerH - (v / top) * innerH;
  return { innerW, innerH, n, top, step, xFor, yFor };
}

function chartHtml(model) {
  const { padL, padR, padT } = CHART;
  const W = model.W;
  const g = geometry(model);
  const { n, xFor, yFor, top, step } = g;
  const bottom = padT + g.innerH;

  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const grid = ticks.map(v => `
    <line x1="${padL}" x2="${W - padR}" y1="${yFor(v)}" y2="${yFor(v)}" class="${v === 0 ? 'chart-baseline' : 'chart-grid'}" />
    <text x="${padL - 8}" y="${yFor(v) + 3.5}" text-anchor="end" class="chart-axis">${esc(axisMoney(v))}</text>`).join('');

  // One x label per ~80px, always including the last bucket.
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(g.innerW / 80))));
  const xLabels = model.keys.map((k, i) => ((n - 1 - i) % every === 0
    ? `<text x="${xFor(i)}" y="${CHART.H - 6}" text-anchor="middle" class="chart-axis">${esc(bucketAxisLabel(model.range.bucket, k))}</text>`
    : '')).join('');

  // Markers only when there are few enough points to read as points.
  const markers = n <= 14;
  const lines = model.series.map(s => {
    const pts = s.values.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
    const dots = markers ? s.values.map((v, i) =>
      `<circle cx="${xFor(i)}" cy="${yFor(v)}" r="4" class="chart-dot" style="fill:${s.color}" />`).join('') : '';
    return `<polyline points="${pts}" class="chart-line" style="stroke:${s.color}" />${dots}`;
  }).join('');

  // Direct labels at each line's end, nudged apart so close values don't
  // print on top of each other. Text ink, not the series color.
  const ends = model.series.map(s => ({ s, y: yFor(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
  const overflow = ends.length ? ends[ends.length - 1].y - (bottom + 2) : 0;
  if (overflow > 0) ends.forEach(e => { e.y -= overflow; });
  const endLabels = ends.map(e =>
    `<text x="${xFor(n - 1) + 9}" y="${e.y + 4}" class="chart-endlabel">${esc(e.s.key)}</text>`).join('');

  return `
    ${legend(model.series.map(s => ({ label: s.key, color: s.color })))}
    <div class="agency-chart">
      <svg viewBox="0 0 ${W} ${CHART.H}" width="${W}" height="${CHART.H}" tabindex="0" role="img"
           aria-label="Line chart of AI spend per ${esc(model.range.unit)} for ${esc(model.series.map(s => s.key).join(', '))}. Use the table view for exact values.">
        ${grid}
        ${lines}
        ${endLabels}
        ${xLabels}
        <g class="chart-hover" style="display:none"></g>
        <rect x="${padL}" y="${padT}" width="${g.innerW}" height="${g.innerH}" class="chart-hit" />
      </svg>
      <div class="chart-tip" style="display:none"></div>
    </div>`;
}

function wireChart(wrap, model) {
  const svg = wrap.querySelector('svg');
  const hover = svg.querySelector('.chart-hover');
  const tip = wrap.querySelector('.chart-tip');
  const { xFor, yFor, n } = geometry(model);
  const { padT, H, padB } = CHART;
  let current = -1;

  function show(i) {
    if (i === current) return;
    current = i;
    if (i < 0) { hover.style.display = 'none'; tip.style.display = 'none'; return; }

    const x = xFor(i);
    hover.innerHTML =
      `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" class="chart-xhair" />` +
      model.series.map(s => `<circle cx="${x}" cy="${yFor(s.values[i])}" r="5" class="chart-dot" style="fill:${s.color}" />`).join('');
    hover.style.display = '';

    const partial = i === n - 1 ? ' <span class="muted">(so far)</span>' : '';
    tip.innerHTML = `
      <div class="chart-tip__title">${esc(bucketTitle(model.range.bucket, model.keys[i]))}${partial}</div>
      ${model.series.map(s => `
        <div class="chart-tip__row"><span class="legend__swatch" style="background:${s.color}"></span>${esc(s.key)}<b>${esc(fmtMoneyExact(s.values[i]))}</b></div>`).join('')}
      <div class="chart-tip__row chart-tip__total">Total<b>${esc(fmtMoneyExact(model.totals[i]))}</b></div>`;
    tip.style.display = '';

    // Keep the tooltip inside the card: right of the crosshair, or left of
    // it once it would run off the edge.
    const px = (x / model.W) * wrap.clientWidth;
    const w = tip.offsetWidth;
    tip.style.left = `${px + 14 + w > wrap.clientWidth ? Math.max(0, px - 14 - w) : px + 14}px`;
  }

  const indexAt = clientX => {
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * model.W;
    if (n <= 1) return 0;
    const stepX = (xFor(n - 1) - xFor(0)) / (n - 1);
    return Math.min(n - 1, Math.max(0, Math.round((vx - xFor(0)) / stepX)));
  };

  svg.addEventListener('pointermove', e => show(indexAt(e.clientX)));
  svg.addEventListener('pointerleave', () => show(-1));
  svg.addEventListener('focus', () => show(n - 1));
  svg.addEventListener('blur', () => show(-1));
  svg.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, current - 1)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(n - 1, current + 1)); }
    if (e.key === 'Escape') show(-1);
  });
}

function chartTableHtml(model) {
  const idx = model.keys.map((_, i) => i).reverse(); // most recent first
  return `
    <div class="tablewrap"><table>
      <thead><tr>
        <th>${esc(model.range.unit === 'day' ? 'Day' : model.range.unit === 'week' ? 'Week' : 'Month')}</th>
        ${model.series.map(s => `<th class="num"><span class="legend__swatch legend__swatch--inline" style="background:${s.color}"></span>${esc(s.key)}</th>`).join('')}
        <th class="num">Total</th>
      </tr></thead>
      <tbody>${idx.map(i => `
        <tr>
          <td>${esc(bucketTitle(model.range.bucket, model.keys[i]))}${i === model.keys.length - 1 ? ' <span class="muted">(so far)</span>' : ''}</td>
          ${model.series.map(s => `<td class="num">${esc(fmtMoneyExact(s.values[i]))}</td>`).join('')}
          <td class="num"><strong>${esc(fmtMoneyExact(model.totals[i]))}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

// The calls behind the Unassigned figure. Setting Agency Assigned on each
// (Call reviews → Edit) moves its cost into SMC, EWSS or SBA everywhere at once.
function drawUnassignedCalls(rows) {
  document.getElementById('agent-spend').insertAdjacentHTML('beforebegin', `
    <div class="card" id="unassigned-costs">
      <div class="card__head">
        <h2>Costs not assigned to SMC, EWSS or SBA</h2>
        <span class="muted">${fmtNum(rows.length)} call${rows.length === 1 ? '' : 's'}</span>
      </div>
      <p class="muted" style="margin:0 0 12px">
        These calls have no Agency Assigned and their agent has no team, so their cost isn't in any category.
        Open each one on Call reviews, click Edit, and set Agency Assigned.
      </p>
      <div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Call</th><th>Agent</th><th class="num">AI cost</th><th></th></tr></thead>
        <tbody>${rows.map(r => `
          <tr>
            <td class="tnum">${esc(fmtDate(r.call_on))}</td>
            <td>${esc(r.title || 'Untitled call')}</td>
            <td>${esc(r.agent_name || '—')}</td>
            <td class="num">${esc(fmtMoneyExact(r.total_cost))}</td>
            <td><a class="btn btn--ghost btn--sm" href="#/reviews/${esc(r.recording_id)}">Open</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`);
}

// Per-agent breakdown of the same daily/weekly/monthly/yearly spend figures
// as the KPI tiles above, filterable by agent or by the agent's own assigned
// team. "Agent" here means the same thing the Agent column means on Call
// reviews — a real account's full_name, or (for a call logged under someone
// with no Lana login yet) the free-text label agent_spend_report() falls
// back to. Two different labeled agents both carry agent_id = null, so
// agent_id alone can't key the dropdown/filter — agentKey() below keys on
// agent_id when present, the name otherwise. A single agent can also appear
// as two rows if their calls resolve to two different teams (same grouping
// scoring_leaderboard() uses), so each row's team is shown under the name.
//
// Admin-only — agent_spend_report() zeroes every figure for a non-admin
// caller, but the dashboard doesn't even render this card unless
// ctx.profile.role is 'admin'.
const NO_TEAM = '__none__';
const agentKey = r => r.agent_id || `name:${r.full_name}`;

function drawAgentSpend(rows) {
  const card = document.getElementById('agent-spend');

  if (rows.length === 0) {
    card.innerHTML = `
      <div class="card__head"><h2>Agent spend</h2></div>
      ${empty('No agent has any scored calls yet.')}`;
    return;
  }

  const agentOptions = [];
  const seenAgents = new Set();
  for (const r of rows) {
    const key = agentKey(r);
    if (!seenAgents.has(key)) { seenAgents.add(key); agentOptions.push({ value: key, label: r.full_name }); }
  }
  const teamNames = [...new Set(rows.map(r => r.team_name || NO_TEAM))];
  const teamOptions = teamNames.map(t => ({ value: t, label: t === NO_TEAM ? '— unassigned —' : t }));

  card.innerHTML = `
    <div class="card__head"><h2>Agent spend</h2></div>
    <div class="filters">
      ${selectField('as-agent', 'Agent', [{ value: 'all', label: 'All agents' }, ...agentOptions], 'all')}
      ${selectField('as-team', 'Team', [{ value: 'all', label: 'All teams' }, ...teamOptions], 'all')}
    </div>
    <div class="tablewrap"><table>
      <thead><tr>
        <th>Agent</th><th class="num">Daily spend</th><th class="num">Weekly spend</th>
        <th class="num">Monthly spend</th><th class="num">Year to date</th>
      </tr></thead>
      <tbody id="agent-spend-rows"></tbody>
    </table></div>`;

  const agentSel = document.getElementById('as-agent');
  const teamSel = document.getElementById('as-team');
  const tbody = document.getElementById('agent-spend-rows');

  function redraw() {
    const agent = agentSel.value;
    const team = teamSel.value;
    const filtered = rows.filter(r =>
      (agent === 'all' || agentKey(r) === agent) &&
      (team === 'all' || (r.team_name || NO_TEAM) === team)
    );

    tbody.innerHTML = filtered.length === 0
      ? `<tr><td colspan="5">${empty('No agent matches these filters.')}</td></tr>`
      : filtered.map(r => `
        <tr>
          <td>${esc(r.full_name)}${r.team_name ? `<br><span class="muted">${esc(r.team_name)}</span>` : ''}</td>
          <td class="num">${esc(fmtMoneyExact(r.daily_spend))}</td>
          <td class="num">${esc(fmtMoneyExact(r.weekly_spend))}</td>
          <td class="num">${esc(fmtMoneyExact(r.monthly_spend))}</td>
          <td class="num">${esc(fmtMoneyExact(r.yearly_spend))}</td>
        </tr>`).join('');
  }

  agentSel.addEventListener('change', redraw);
  teamSel.addEventListener('change', redraw);
  redraw();
}

const rowHtml = s => `
  <tr>
    <td class="tnum">${esc(fmtDate(s.submitted_on))}</td>
    <td>${esc(s.client_name)}</td>
    <td>${esc(s.products?.name || s.carrier || '—')}<br><span class="muted">${esc(catLabel(s.category))}</span></td>
    <td class="num">${esc(fmtMoneyExact(s.ap_amount))}</td>
    <td>${statusChip(s.status)}</td>
  </tr>`;

const catLabel = v => CATEGORIES.find(c => c.value === v)?.label || v;

/* === My sales ============================================================= */
export async function mySales(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>My sales</h1>
      <div class="page__sub">Pending rows can still be deleted</div>
    </div></div>
    <div class="card" id="list">${spinner()}</div>`;

  const list = document.getElementById('list');

  async function draw() {
    const rows = await db.mySubmissions({ limit: 200 });
    if (rows.length === 0) {
      list.innerHTML = empty('Nothing logged yet.');
      return;
    }

    const total = rows.reduce((sum, r) => sum + Number(r.ap_amount), 0);
    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} submission${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted tnum">${fmtMoneyExact(total)} total AP</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Date</th><th>Client</th><th>Product</th><th>Policy</th>
          <th class="num">AP</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(s => `
          <tr>
            <td class="tnum">${esc(fmtDate(s.submitted_on))}</td>
            <td>${esc(s.client_name)}</td>
            <td>${esc(s.products?.name || s.carrier || '—')}<br><span class="muted">${esc(catLabel(s.category))}</span></td>
            <td>${esc(s.policy_number || '—')}</td>
            <td class="num">${esc(fmtMoneyExact(s.ap_amount))}</td>
            <td>${statusChip(s.status)}</td>
            <td>${s.status === 'pending'
              ? `<button class="btn btn--ghost btn--sm" data-del="${esc(s.id)}">Delete</button>`
              : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this pending submission? This cannot be undone.')) return;
        try {
          await db.deleteSubmission(btn.dataset.del);
          toast('Submission deleted.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  await draw();
}

export { SERIES, catLabel };
