// ---------------------------------------------------------------------------
// Agent-facing views: dashboard, my sales.
// Every view exports render(main, ctx) and wires its own listeners.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=70';
import { CATEGORIES } from './config.js?v=70';
import {
  esc, fmtMoneyExact, fmtNum, fmtDate,
  toast, statTile, statusChip, empty, spinner, selectField,
} from './ui.js?v=70';

const SERIES = {
  mapd:      'var(--series-1)',
  ancillary: 'var(--series-2)',
  combined:  'var(--series-3)',
};

/* === Dashboard ============================================================ */
export async function dashboard(main, ctx) {
  const isAdmin = ctx.profile.role === 'admin';

  main.innerHTML = `
    <div class="page__head">
      <div>
        <h1>Dashboard</h1>
        <div class="page__sub">${esc(ctx.profile.full_name)} · month to date</div>
      </div>
    </div>
    <div id="kpis">${spinner()}</div>
    <div class="card" id="recent">${spinner()}</div>
    ${isAdmin ? `<div class="card" id="agent-spend">${spinner()}</div>` : ''}`;

  const [m, mine, agentSpend, unassignedCalls] = await Promise.all([
    db.myMetrics(),
    db.mySubmissions({ limit: 8 }),
    isAdmin ? db.agentSpendReport() : Promise.resolve(null),
    isAdmin ? db.unassignedCostCalls() : Promise.resolve([]),
  ]);

  document.getElementById('kpis').outerHTML = `
    <div id="kpis">
      <div class="kpis">
        ${statTile({ label: 'Daily spend', value: fmtMoneyExact(m.daily_spend), note: 'All AI costs, today' })}
        ${statTile({ label: 'Weekly spend', value: fmtMoneyExact(m.weekly_spend), note: 'All AI costs, Monday–Sunday' })}
        ${statTile({ label: 'Monthly spend', value: fmtMoneyExact(m.monthly_spend), note: 'All AI costs, this month' })}
        ${statTile({ label: 'Yearly spend', value: fmtMoneyExact(m.yearly_spend), note: 'All AI costs, this year' })}
      </div>
      <div class="kpis">
        ${statTile({ label: 'SMC Daily spend', value: fmtMoneyExact(m.smc_daily_spend), note: "SMC calls, today" })}
        ${statTile({ label: 'SMC Weekly spend', value: fmtMoneyExact(m.smc_weekly_spend), note: 'SMC calls, Monday–Sunday' })}
        ${statTile({ label: 'SMC Monthly spend', value: fmtMoneyExact(m.smc_monthly_spend), note: 'SMC calls, this month' })}
        ${statTile({ label: 'SMC Yearly spend', value: fmtMoneyExact(m.smc_yearly_spend), note: 'SMC calls, year to date' })}
        ${statTile({ label: 'EWSS Daily spend', value: fmtMoneyExact(m.ewss_daily_spend), note: "EWSS calls, today" })}
        ${statTile({ label: 'EWSS Weekly spend', value: fmtMoneyExact(m.ewss_weekly_spend), note: 'EWSS calls, Monday–Sunday' })}
        ${statTile({ label: 'EWSS Monthly spend', value: fmtMoneyExact(m.ewss_monthly_spend), note: 'EWSS calls, this month' })}
        ${statTile({ label: 'EWSS Yearly spend', value: fmtMoneyExact(m.ewss_yearly_spend), note: 'EWSS calls, year to date' })}
      </div>
      ${unassignedTilesHtml(m)}
      <p class="muted" style="font-size:12px;margin:4px 0 0">
        AI costs = coaching-rubric scoring, Medicare scorecard grading, and AI review summaries. A call's cost goes to its
        Agency Assigned, or the agent's own team if none was set. Transcription isn't tracked per call.
      </p>
    </div>`;

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

// Spend that belongs to neither SMC nor EWSS. Shown only when there is some,
// as a prompt to fix it: every cost is meant to land in one of the two.
const hasUnassigned = m => [m.unassigned_daily_spend, m.unassigned_weekly_spend, m.unassigned_monthly_spend, m.unassigned_yearly_spend]
  .some(v => Number(v) > 0);

function unassignedTilesHtml(m) {
  if (!hasUnassigned(m)) return '';
  return `
    <div class="kpis">
      ${statTile({ label: 'Unassigned Daily spend', value: fmtMoneyExact(m.unassigned_daily_spend), note: 'No agency set — not in SMC or EWSS' })}
      ${statTile({ label: 'Unassigned Weekly spend', value: fmtMoneyExact(m.unassigned_weekly_spend), note: 'No agency set — not in SMC or EWSS' })}
      ${statTile({ label: 'Unassigned Monthly spend', value: fmtMoneyExact(m.unassigned_monthly_spend), note: 'No agency set — not in SMC or EWSS' })}
      ${statTile({ label: 'Unassigned Yearly spend', value: fmtMoneyExact(m.unassigned_yearly_spend), note: 'No agency set — not in SMC or EWSS' })}
    </div>`;
}

// The calls behind the Unassigned figure. Setting Agency Assigned on each
// (Call reviews → Edit) moves its cost into SMC or EWSS everywhere at once.
function drawUnassignedCalls(rows) {
  document.getElementById('agent-spend').insertAdjacentHTML('beforebegin', `
    <div class="card" id="unassigned-costs">
      <div class="card__head">
        <h2>Costs not assigned to SMC or EWSS</h2>
        <span class="muted">${fmtNum(rows.length)} call${rows.length === 1 ? '' : 's'}</span>
      </div>
      <p class="muted" style="margin:0 0 12px">
        These calls have no Agency Assigned and their agent has no team, so their cost isn't in either category.
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
