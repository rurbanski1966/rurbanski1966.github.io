// ---------------------------------------------------------------------------
// Analytics: score progression over time, at three rollup levels (agency,
// team, agent) — separate from Leaderboard, which is ranking/comparative for
// a single period rather than a drill-down history. Admin/reviewer-only,
// enforced by app.js's route roles and by analytics_trend()/analytics_agents()/
// agent_score_roster() themselves (migrations 030, 032).
//
// Two audiences, one page: Manager view is the dense layout (filters, the
// trend chart with all its toggles, severity bars, the agency/team roster,
// exports). Agent view is what a manager actually shows an agent live in a
// 1:1 — hero score, trend, category breakdown, one improvement callout, and
// nothing else. Agent view only makes sense for a single selected agent, so
// it's only offered on the "By agent" tab; Agency-wide and By team always
// render the manager layout.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=55';
import { SCORE_DIMENSIONS } from './config.js?v=55';
import {
  esc, fmtNum, toast, empty, spinner, selectField, statTile, barRow,
  trendChart, legend, trendDelta, exportHtmlToPdf,
} from './ui.js?v=55';

// Fixed per Ryan — not inferred from the data and not to be changed to match
// whatever the current average happens to be.
const PASSING_SCORE = 70;

const MODE_KEY = 'lana-analytics-mode';

// Same label precedence as views-scoring.js's dimLabel, minus the per-score
// stamped label — analytics_trend() only ever returns a bare average number
// per dimension key, not the {label, rationale, ...} object a single score
// carries. The rubric currently defines five dimensions (opening, discovery,
// presentation, objection handling, closing) — whatever it defines is what
// renders here; nothing is hardcoded to a specific count.
const DIMENSION_ORDER = new Map(SCORE_DIMENSIONS.map((d, i) => [d.key, i]));
const dimLabel = key =>
  SCORE_DIMENSIONS.find(d => d.key === key)?.label
  || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--seq-300)', 'var(--seq-500)', 'var(--seq-600)'];

// A dedicated four-way mapping, distinct from FINDING_SEVERITIES' chip tones
// (which lump low and medium under one amber "warning" tone) — the point of
// these bars is exactly to make a critical spike read as louder than a low
// one, so each severity gets its own color per Ryan's spec.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const SEVERITY_COLOR = { critical: 'var(--critical)', high: 'var(--serious)', medium: 'var(--warning)', low: 'var(--good)' };

// date_trunc('day'|'week'|'month'|'quarter', ...) are all valid Postgres
// field names, so analytics_trend() needed no change to support the finer
// buckets — only the frontend's toggle and labeling.
const BUCKETS = ['day', 'week', 'month', 'quarter'];
const BUCKET_LABEL = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter' };
const BUCKET_TOGGLE_LABEL = { day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly' };

// Mirrors views-agent.js's agentKey(): a labeled identity (no Lana login)
// carries agent_id = null, so the name has to stand in as the dropdown key.
const agentKey = a => a.agent_id || `name:${a.full_name}`;

function bucketLabel(dateStr, bucket) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (bucket === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (bucket === 'month') return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  // date_trunc('week', ...) lands on the Monday of that ISO week (matches
  // my_metrics()'s week bounds elsewhere in the app).
  const short = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return bucket === 'week' ? `Wk of ${short}` : short;
}

// Sorted, ordered dimension entries for a single bucket's dimension_avgs.
function orderedDims(dimensionAvgs) {
  return Object.entries(dimensionAvgs || {})
    .sort(([a], [b]) => (DIMENSION_ORDER.get(a) ?? Infinity) - (DIMENSION_ORDER.get(b) ?? Infinity));
}

// Shared by both views — horizontal bars, one per skill category, scaled
// against a fixed 0-100 (not the max of the set): a category's bar length is
// how close it is to full marks, not how it compares to its neighbors, which
// would visually exaggerate small gaps when every category is already
// strong. The single lowest-scoring category is colored distinctly; ties
// keep the first one encountered.
function skillBars(dimensionAvgs) {
  const entries = orderedDims(dimensionAvgs);
  if (entries.length === 0) return empty('No category scores for this period yet.');
  const lowestKey = entries.reduce((min, [k, v]) => (Number(v) < Number(dimensionAvgs[min]) ? k : min), entries[0][0]);
  return `<div class="bars">${entries.map(([key, val]) => barRow({
    label: dimLabel(key),
    value: val,
    display: val,
    max: 100,
    color: key === lowestKey ? 'var(--critical)' : 'var(--series-1)',
  })).join('')}</div>`;
}

// Shared by both manager-view levels — bars sized relative to each other
// (the largest of the four counts, not a fixed scale, since raw finding
// counts have no natural ceiling the way a 0-100 score does).
function severityBars(findingsBySeverity) {
  const counts = SEVERITY_ORDER.map(k => Number(findingsBySeverity?.[k] || 0));
  const max = Math.max(1, ...counts);
  return `<div class="bars">${SEVERITY_ORDER.map((k, i) => barRow({
    label: SEVERITY_LABEL[k],
    value: counts[i],
    display: fmtNum(counts[i]),
    max,
    color: SEVERITY_COLOR[k],
  })).join('')}</div>`;
}

function lowestDimension(dimensionAvgs) {
  const entries = orderedDims(dimensionAvgs);
  if (entries.length === 0) return null;
  return entries.reduce((min, e) => (Number(e[1]) < Number(min[1]) ? e : min));
}

// A recording scored twice also had its cost double-counted (migration
// 031) — same principle applies here: a comparison always uses the pair of
// buckets that actually have data, never assumes a fixed lookback.
function severeCount(row) {
  return Number(row?.findings_by_severity?.critical || 0) + Number(row?.findings_by_severity?.high || 0);
}

function compareRoster(a, b, sort) {
  if (sort === 'name') return a.full_name.localeCompare(b.full_name);
  if (sort === 'score') return Number(b.latest_overall) - Number(a.latest_overall);
  // 'decline': most negative score_delta first; agents with no prior period
  // to compare against (new to the roster) sort last, not first — there's
  // nothing to flag yet, and burying a real decline under them would defeat
  // the point of this default.
  const ad = a.score_delta, bd = b.score_delta;
  if (ad == null && bd == null) return a.full_name.localeCompare(b.full_name);
  if (ad == null) return 1;
  if (bd == null) return -1;
  return Number(ad) - Number(bd);
}

const rosterFlagged = r => (r.score_delta != null && Number(r.score_delta) < 0) || r.findings_worsened;

export async function analytics(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Analytics</h1>
      <div class="page__sub">Score progression over time — agency-wide, by team, or by agent</div>
    </div></div>
    <div id="an-filters">${spinner()}</div>
    <div class="card" id="an-body">${spinner()}</div>`;

  const [teams, agents] = await Promise.all([db.listTeams(), db.analyticsAgents()]);

  const filtersHost = document.getElementById('an-filters');
  const body = document.getElementById('an-body');

  let level = 'agency'; // 'agency' | 'team' | 'agent'
  let bucket = 'month';
  let selectedTeamId = teams[0]?.id ?? null;
  let selectedAgentKey = agents[0] ? agentKey(agents[0]) : null;
  const activeDims = new Set();
  let showCompliance = false;
  let lastRows = [];
  let lastRoster = [];
  let rosterSort = 'decline';
  let mode = sessionStorage.getItem(MODE_KEY) === 'agent' ? 'agent' : 'manager';

  function renderFilters() {
    filtersHost.innerHTML = `
      <div class="filters">
        <div style="display:flex;gap:8px">
          ${['agency', 'team', 'agent'].map(l => `
            <button type="button" class="btn ${l === level ? 'btn--primary' : 'btn--ghost'}" data-level="${l}">
              ${l === 'agency' ? 'Agency-wide' : l === 'team' ? 'By team' : 'By agent'}
            </button>`).join('')}
        </div>
        ${level === 'team'
          ? selectField('an-team', 'Team', teams.map(t => ({ value: t.id, label: t.name })), selectedTeamId)
          : ''}
        ${level === 'agent'
          ? selectField('an-agent', 'Agent', agents.map(a => ({ value: agentKey(a), label: a.full_name })), selectedAgentKey)
          : ''}
        <div style="display:flex;gap:8px">
          ${BUCKETS.map(b => `
            <button type="button" class="btn ${b === bucket ? 'btn--primary' : 'btn--ghost'}" data-bucket="${b}">
              ${BUCKET_TOGGLE_LABEL[b]}
            </button>`).join('')}
        </div>
        ${level === 'agent' ? `
          <div style="display:flex;gap:8px">
            <button type="button" class="btn ${mode === 'manager' ? 'btn--primary' : 'btn--ghost'}" data-mode="manager">Manager view</button>
            <button type="button" class="btn ${mode === 'agent' ? 'btn--primary' : 'btn--ghost'}" data-mode="agent">Agent view</button>
          </div>` : ''}
      </div>`;

    filtersHost.querySelectorAll('[data-level]').forEach(btn =>
      btn.addEventListener('click', () => { level = btn.dataset.level; renderFilters(); draw(); }));
    filtersHost.querySelectorAll('[data-bucket]').forEach(btn =>
      btn.addEventListener('click', () => { bucket = btn.dataset.bucket; renderFilters(); draw(); }));
    filtersHost.querySelectorAll('[data-mode]').forEach(btn =>
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        sessionStorage.setItem(MODE_KEY, mode);
        renderFilters();
        renderBody();
      }));

    const teamSel = document.getElementById('an-team');
    if (teamSel) teamSel.addEventListener('change', e => { selectedTeamId = e.target.value; draw(); });
    const agentSel = document.getElementById('an-agent');
    if (agentSel) agentSel.addEventListener('change', e => { selectedAgentKey = e.target.value; draw(); });
  }

  async function draw() {
    if (level === 'team' && !selectedTeamId) { body.innerHTML = empty('No teams yet.'); return; }
    if (level === 'agent' && !selectedAgentKey) { body.innerHTML = empty('No agent has any scored calls yet.'); return; }

    body.innerHTML = spinner();
    const params = { bucket };
    if (level === 'team') params.teamId = selectedTeamId;
    if (level === 'agent') {
      const match = agents.find(a => agentKey(a) === selectedAgentKey);
      if (match?.agent_id) params.agentId = match.agent_id;
      else if (match) params.agentName = match.agent_name;
    }

    const fetches = [db.analyticsTrend(params)];
    // The roster is a "who else needs attention" view — meaningless scoped
    // to the one agent already selected, so it's only fetched for the two
    // levels where it's shown.
    if (level !== 'agent') fetches.push(db.agentScoreRoster({ bucket, teamId: level === 'team' ? selectedTeamId : null }));

    const [rows, roster] = await Promise.all(fetches);
    lastRows = rows;
    lastRoster = roster || [];
    renderBody();
  }

  function renderBody() {
    if (lastRows.length === 0) {
      body.innerHTML = empty('No scored calls for this selection yet.');
      return;
    }
    if (level === 'agent' && mode === 'agent') renderAgentView();
    else renderManagerView();
  }

  function renderAgentView() {
    const rows = lastRows;
    const last = rows[rows.length - 1];
    const labels = rows.map(r => bucketLabel(r.bucket_start, bucket));
    const chartMode = rows.length < 6 ? 'bar' : 'line';
    const passing = last.avg_overall_score != null && Number(last.avg_overall_score) >= PASSING_SCORE;
    const lowest = lowestDimension(last.dimension_avgs);

    body.innerHTML = `
      <div class="card" style="text-align:center;padding:36px 20px">
        <div class="kpi__label">Overall score</div>
        <div style="font-size:56px;font-weight:800;line-height:1;margin:6px 0">${esc(last.avg_overall_score ?? '—')}</div>
        <div>${passing
          ? '<span class="chip chip--good">✓ Passing (70+)</span>'
          : `<span class="chip chip--critical">✕ Below passing (${PASSING_SCORE})</span>`}</div>
      </div>

      <div class="card__head" style="margin-top:20px"><h2>Score trend</h2></div>
      ${trendChart({
        series: [{ key: 'overall', label: 'Overall score', color: 'var(--brand)', values: rows.map(r => (r.avg_overall_score == null ? null : Number(r.avg_overall_score))) }],
        labels,
        mode: chartMode,
        threshold: { value: PASSING_SCORE, label: `Passing (${PASSING_SCORE})` },
      })}

      <h2 style="margin-top:24px">By category</h2>
      ${skillBars(last.dimension_avgs)}

      ${lowest ? `
        <p class="muted" style="margin-top:16px;font-size:14px">
          Top area to improve: <strong>${esc(dimLabel(lowest[0]))}</strong> (${esc(lowest[1])})
        </p>` : ''}`;
  }

  function renderManagerView() {
    const rows = lastRows;
    const labels = rows.map(r => bucketLabel(r.bucket_start, bucket));
    const chartMode = rows.length < 6 ? 'bar' : 'line';
    const allDimKeys = [...new Set(rows.flatMap(r => Object.keys(r.dimension_avgs || {})))]
      .sort((a, b) => (DIMENSION_ORDER.get(a) ?? Infinity) - (DIMENSION_ORDER.get(b) ?? Infinity));

    const series = [{
      key: 'overall',
      label: 'Overall score',
      color: 'var(--brand)',
      values: rows.map(r => (r.avg_overall_score == null ? null : Number(r.avg_overall_score))),
    }];
    allDimKeys.forEach((key, i) => {
      if (!activeDims.has(key)) return;
      series.push({
        key,
        label: dimLabel(key),
        color: PALETTE[i % PALETTE.length],
        values: rows.map(r => (r.dimension_avgs?.[key] != null ? Number(r.dimension_avgs[key]) : null)),
      });
    });
    if (showCompliance) {
      series.push({
        key: 'compliance',
        label: 'Compliance pass rate',
        color: 'var(--diverge-warm)',
        dashed: true,
        values: rows.map(r => (r.compliance_pass_rate == null ? null : Math.round(Number(r.compliance_pass_rate) * 100))),
      });
    }

    const last = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    const lastPassPct = last.compliance_pass_rate != null ? Math.round(Number(last.compliance_pass_rate) * 100) : null;
    const prevPassPct = prev?.compliance_pass_rate != null ? Math.round(Number(prev.compliance_pass_rate) * 100) : null;
    const totalCalls = rows.reduce((sum, r) => sum + Number(r.calls_scored), 0);

    // The bug this fixes: a rising overall-score delta and a worsening
    // compliance picture can both be true in the same period, and one green
    // arrow must never stand in for both facts. Shown side by side, each
    // colored only by its own direction, so neither can misrepresent the
    // other.
    const lastSevere = severeCount(last);
    const prevSevere = prev ? severeCount(prev) : null;

    body.innerHTML = `
      <div class="kpis" style="margin-bottom:20px">
        ${statTile({
          label: 'Latest overall score',
          value: last.avg_overall_score ?? '—',
          note: trendDelta(last.avg_overall_score, prev?.avg_overall_score),
        })}
        ${statTile({
          label: 'Compliance pass rate',
          value: lastPassPct != null ? `${lastPassPct}%` : '—',
          note: trendDelta(lastPassPct, prevPassPct, { suffix: '%' }),
        })}
        ${statTile({
          label: 'Compliance findings (critical+high)',
          value: fmtNum(lastSevere),
          note: trendDelta(lastSevere, prevSevere, { higherIsBetter: false, digits: 0 }),
        })}
        ${statTile({
          label: 'Calls scored',
          value: fmtNum(totalCalls),
          note: `${labels[0]} – ${labels[labels.length - 1]}`,
        })}
      </div>

      <div class="card__head"><h2>Score trend</h2></div>
      <div class="filters" style="margin-bottom:4px">
        ${allDimKeys.map(key => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;min-width:0">
            <input type="checkbox" data-dim="${esc(key)}" ${activeDims.has(key) ? 'checked' : ''} />
            ${esc(dimLabel(key))}
          </label>`).join('')}
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;min-width:0">
          <input type="checkbox" id="an-compliance-toggle" ${showCompliance ? 'checked' : ''} />
          Compliance pass rate
        </label>
      </div>
      ${legend(series.map(s => ({ color: s.color, label: s.label })))}
      ${trendChart({ series, labels, mode: chartMode, threshold: { value: PASSING_SCORE, label: `Passing (${PASSING_SCORE})` } })}

      <h2 style="margin-top:28px">By category</h2>
      ${skillBars(last.dimension_avgs)}

      <h2 style="margin-top:28px">Compliance findings by severity</h2>
      ${severityBars(last.findings_by_severity)}
      <details style="margin-top:10px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Exact numbers by ${BUCKET_LABEL[bucket].toLowerCase()}</summary>
        <div class="tablewrap" style="margin-top:10px"><table>
          <thead><tr>
            <th>${BUCKET_LABEL[bucket]}</th>
            <th class="num">Critical</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${esc(bucketLabel(r.bucket_start, bucket))}</td>
              <td class="num">${fmtNum(r.findings_by_severity?.critical || 0)}</td>
              <td class="num">${fmtNum(r.findings_by_severity?.high || 0)}</td>
              <td class="num">${fmtNum(r.findings_by_severity?.medium || 0)}</td>
              <td class="num">${fmtNum(r.findings_by_severity?.low || 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </details>

      ${level !== 'agent' ? `
        <div id="an-roster" style="margin-top:28px"></div>` : ''}

      <div class="card__head" style="margin-top:28px"><h2>Export a summary</h2></div>
      <p class="muted" style="margin:0 0 12px">
        Same data as above, formatted as a clean document — no internal jargon,
        no commission or override figures (Lana doesn't track those).
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn--ghost" id="an-export-comp" type="button">Export for a comp conversation (PDF)</button>
        <button class="btn btn--ghost" id="an-export-fmo" type="button">Export for an FMO partner (PDF)</button>
      </div>`;

    body.querySelectorAll('[data-dim]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) activeDims.add(cb.dataset.dim); else activeDims.delete(cb.dataset.dim);
      renderManagerView();
    }));
    document.getElementById('an-compliance-toggle').addEventListener('change', e => {
      showCompliance = e.target.checked;
      renderManagerView();
    });
    document.getElementById('an-export-comp').addEventListener('click', e => exportReport('comp', e.currentTarget));
    document.getElementById('an-export-fmo').addEventListener('click', e => exportReport('fmo', e.currentTarget));

    if (level !== 'agent') renderRoster();
  }

  // Agency-wide and By team both get this — "who needs attention" at a
  // glance, not just one aggregate number. Re-sorting only re-renders this
  // block from the already-fetched roster, no refetch.
  function renderRoster() {
    const host = document.getElementById('an-roster');
    if (!host) return;

    if (lastRoster.length === 0) {
      host.innerHTML = `
        <div class="card__head"><h2>Agent roster</h2></div>
        ${empty('No agents with scored calls in this selection yet.')}`;
      return;
    }

    const sorted = lastRoster.slice().sort((a, b) => compareRoster(a, b, rosterSort));

    host.innerHTML = `
      <div class="card__head">
        <h2>Agent roster</h2>
        <div style="display:flex;gap:6px">
          ${[['decline', 'Biggest decline'], ['score', 'Score'], ['name', 'Name']].map(([key, lbl]) => `
            <button type="button" class="btn btn--sm ${rosterSort === key ? 'btn--primary' : 'btn--ghost'}" data-roster-sort="${key}">${lbl}</button>`).join('')}
        </div>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Agent</th><th class="num">Latest score</th><th class="num">vs prior</th><th>Status</th>
        </tr></thead>
        <tbody>${sorted.map(r => `
          <tr class="${rosterFlagged(r) ? 'roster-row--flagged' : ''}">
            <td>${esc(r.full_name)}</td>
            <td class="num tnum">${esc(r.latest_overall)}</td>
            <td class="num">${trendDelta(r.latest_overall, r.prior_overall)}</td>
            <td>${r.passing
              ? '<span class="chip chip--good">✓ Passing</span>'
              : `<span class="chip chip--critical">✕ Below ${PASSING_SCORE}</span>`}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    host.querySelectorAll('[data-roster-sort]').forEach(btn =>
      btn.addEventListener('click', () => { rosterSort = btn.dataset.rosterSort; renderRoster(); }));
  }

  function currentScopeLabel() {
    if (level === 'team') return `Team: ${teams.find(t => t.id === selectedTeamId)?.name || '—'}`;
    if (level === 'agent') return `Agent: ${agents.find(a => agentKey(a) === selectedAgentKey)?.full_name || '—'}`;
    return 'Agency-wide';
  }

  async function exportReport(mode_, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Opening report…';
    try {
      const scopeLabel = currentScopeLabel();
      const html = summaryReportHtml({ scopeLabel, mode: mode_, bucket, rows: lastRows });
      const slug = scopeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await exportHtmlToPdf(html, `quality-summary-${slug}-${mode_}.pdf`);
    } catch (err) {
      toast(err.message || 'Could not open the report.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  renderFilters();
  await draw();
}

/* --- summary report ---------------------------------------------------------
   Its own real document, opened in a new tab and handed to the browser's
   native print (see exportHtmlToPdf in ui.js) — not screenshotted.
   table-layout:fixed / overflow-wrap still guards against a long word
   forcing a column wider than the page, independent of how it's rendered.

   'comp' and 'fmo' modes share every number; only the framing text differs.
   The FMO disclaimer says plainly what this is NOT — commission, override,
   or retention data — because an outside partner reading a "quality
   management" document has no other way to know Lana never tracked those in
   the first place.
   -------------------------------------------------------------------------- */
function summaryReportHtml({ scopeLabel, mode, bucket, rows }) {
  const periodLabel = b => bucketLabel(b, bucket);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const totalCalls = rows.reduce((sum, r) => sum + Number(r.calls_scored), 0);

  const scoreDelta = last.avg_overall_score != null && first.avg_overall_score != null
    ? Number(last.avg_overall_score) - Number(first.avg_overall_score)
    : null;
  const passFirst = first.compliance_pass_rate != null ? Math.round(Number(first.compliance_pass_rate) * 100) : null;
  const passLast = last.compliance_pass_rate != null ? Math.round(Number(last.compliance_pass_rate) * 100) : null;
  const passDelta = passFirst != null && passLast != null ? passLast - passFirst : null;

  const allDimKeys = [...new Set(rows.flatMap(r => Object.keys(r.dimension_avgs || {})))]
    .sort((a, b) => (DIMENSION_ORDER.get(a) ?? Infinity) - (DIMENSION_ORDER.get(b) ?? Infinity));

  const title = mode === 'fmo' ? 'Quality Assurance Summary' : 'Performance Summary';
  const subtitle = mode === 'fmo'
    ? 'Prepared to document active, agent-specific quality management'
    : 'Prepared for a compensation review conversation';
  const disclaimer = 'This summary reflects AI-assisted call grading and any subsequent manual review performed by an agency reviewer. It does not include commission, override, or retention data — Lana does not track any of those.';

  const narrative = [];
  if (scoreDelta != null) {
    narrative.push(`Overall quality score moved from ${first.avg_overall_score} to ${last.avg_overall_score} (${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(1)}) over this period.`);
  }
  if (passDelta != null) {
    narrative.push(`Compliance pass rate moved from ${passFirst}% to ${passLast}% (${passDelta >= 0 ? '+' : ''}${passDelta}%).`);
  }
  const bucketWord = BUCKET_LABEL[bucket].toLowerCase();
  narrative.push(`${fmtNum(totalCalls)} call${totalCalls === 1 ? '' : 's'} scored across ${rows.length} ${bucketWord}${rows.length === 1 ? '' : 's'}.`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} - ${esc(scopeLabel)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;800&display=swap" rel="stylesheet">
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; line-height: 1.5; overflow-wrap: break-word; }
  .lana-header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
  .lana-lockup { display: flex; align-items: center; gap: 8px; }
  .lana-word { font-family: 'Manrope', -apple-system, Segoe UI, Arial, sans-serif; font-weight: 800; font-size: 22px; letter-spacing: -0.02em; color: #1E1029; }
  .lana-l { color: #7C2FD6; }
  .lana-tagline { font-family: 'Manrope', -apple-system, Segoe UI, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #8B7FA0; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 6px; page-break-after: avoid; break-after: avoid; }
  .muted { color: #666; font-size: 12px; }
  .kpis { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
  .kpi { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; min-width: 140px; background: #f4f4f4; }
  .kpi .lbl { font-size: 12px; color: #555; }
  .kpi .val { font-size: 24px; font-weight: 700; color: #1a1a1a; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 8px 0 20px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; vertical-align: top; font-size: 12px; overflow-wrap: break-word; word-break: break-word; }
  th { color: #666; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  th:first-child, td:first-child { width: 16%; }
  tr { page-break-inside: avoid; break-inside: avoid; }
</style>
</head>
<body>
  <div class="lana-header">
    <div class="lana-lockup">
      <svg width="32" height="32" viewBox="0 0 32 32" role="img" aria-label="Lana">
        <rect width="32" height="32" rx="7" fill="#3B1370"/>
        <text x="16" y="17" text-anchor="middle" dominant-baseline="central"
              font-family="Manrope, -apple-system, Segoe UI, Arial, sans-serif" font-weight="800" font-size="19" fill="#E4D4FF">L</text>
      </svg>
      <span class="lana-word"><span class="lana-l">L</span>ANA</span>
    </div>
    <div class="lana-tagline">AI Sales Coaching &amp; Scoring</div>
  </div>

  <h1>${esc(title)}</h1>
  <p class="muted">${esc(scopeLabel)} — ${esc(periodLabel(first.bucket_start))} to ${esc(periodLabel(last.bucket_start))}</p>
  <p class="muted">${esc(subtitle)}</p>

  <div class="kpis">
    <div class="kpi">
      <div class="lbl">Overall score</div>
      <div class="val">${esc(last.avg_overall_score ?? '—')}</div>
      <div class="muted">${first.avg_overall_score != null ? `Started at ${esc(first.avg_overall_score)}` : ''}</div>
    </div>
    <div class="kpi">
      <div class="lbl">Compliance pass rate</div>
      <div class="val">${passLast != null ? `${passLast}%` : '—'}</div>
      <div class="muted">${passFirst != null ? `Started at ${passFirst}%` : ''}</div>
    </div>
    <div class="kpi">
      <div class="lbl">Calls scored</div>
      <div class="val">${fmtNum(totalCalls)}</div>
      <div class="muted">${rows.length} ${bucketWord}${rows.length === 1 ? '' : 's'}</div>
    </div>
  </div>

  <p>${esc(narrative.join(' '))}</p>

  <h2>Score by ${bucketWord}</h2>
  <table>
    <thead><tr>
      <th>${BUCKET_LABEL[bucket]}</th>
      <th>Overall</th>
      ${allDimKeys.map(k => `<th>${esc(dimLabel(k))}</th>`).join('')}
      <th>Compliance pass rate</th>
    </tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td>${esc(periodLabel(r.bucket_start))}</td>
          <td>${esc(r.avg_overall_score ?? '—')}</td>
          ${allDimKeys.map(k => `<td>${esc(r.dimension_avgs?.[k] ?? '—')}</td>`).join('')}
          <td>${r.compliance_pass_rate != null ? `${Math.round(Number(r.compliance_pass_rate) * 100)}%` : '—'}</td>
        </tr>`).join('')}
    </tbody>
  </table>

  <h2>Compliance findings by severity</h2>
  <table>
    <thead><tr>
      <th>${BUCKET_LABEL[bucket]}</th>
      <th>Critical</th><th>High</th><th>Medium</th><th>Low</th>
    </tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td>${esc(periodLabel(r.bucket_start))}</td>
          <td>${fmtNum(r.findings_by_severity?.critical || 0)}</td>
          <td>${fmtNum(r.findings_by_severity?.high || 0)}</td>
          <td>${fmtNum(r.findings_by_severity?.medium || 0)}</td>
          <td>${fmtNum(r.findings_by_severity?.low || 0)}</td>
        </tr>`).join('')}
    </tbody>
  </table>

  <p class="muted" style="margin-top:30px">${esc(disclaimer)}</p>
  <p class="muted" style="margin-top:6px">
    Generated ${esc(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}.
  </p>
</body>
</html>`;
}
