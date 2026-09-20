// ---------------------------------------------------------------------------
// Agent-facing views: dashboard, my sales.
// Every view exports render(main, ctx) and wires its own listeners.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=44';
import { CATEGORIES } from './config.js?v=44';
import {
  esc, fmtMoneyExact, fmtNum, fmtDate,
  toast, statTile, statusChip, empty, spinner, selectField,
} from './ui.js?v=44';

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

  const [m, mine, agentSpend] = await Promise.all([
    db.myMetrics(),
    db.mySubmissions({ limit: 8 }),
    isAdmin ? db.agentSpendReport() : Promise.resolve(null),
  ]);

  document.getElementById('kpis').outerHTML = `
    <div id="kpis">
      <div class="kpis">
        ${statTile({ label: 'Daily spend', value: fmtMoneyExact(m.daily_spend), note: "AI grading cost, today's calls" })}
        ${statTile({ label: 'Weekly spend', value: fmtMoneyExact(m.weekly_spend), note: 'AI grading cost, Monday–Sunday' })}
        ${statTile({ label: 'Yearly spend', value: fmtMoneyExact(m.yearly_spend), note: 'AI grading + review costs, this year' })}
      </div>
      <div class="kpis">
        ${statTile({ label: 'SMC Daily spend', value: fmtMoneyExact(m.smc_daily_spend), note: "AI grading + review costs, today's SMC calls" })}
        ${statTile({ label: 'SMC Weekly spend', value: fmtMoneyExact(m.smc_weekly_spend), note: 'AI grading + review costs, SMC calls Monday–Sunday' })}
        ${statTile({ label: 'SMC Monthly spend', value: fmtMoneyExact(m.smc_monthly_spend), note: 'AI grading + review costs, SMC calls this month' })}
        ${statTile({ label: 'EWSS Daily spend', value: fmtMoneyExact(m.ewss_daily_spend), note: "AI grading + review costs, today's EWSS calls" })}
        ${statTile({ label: 'EWSS Weekly spend', value: fmtMoneyExact(m.ewss_weekly_spend), note: 'AI grading + review costs, EWSS calls Monday–Sunday' })}
        ${statTile({ label: 'EWSS Monthly spend', value: fmtMoneyExact(m.ewss_monthly_spend), note: 'AI grading + review costs, EWSS calls this month' })}
      </div>
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
}

// Per-agent breakdown of the same daily/weekly/monthly/yearly spend figures
// as the KPI tiles above, filterable by agent or by the agent's own assigned
// team. Admin-only — agent_spend_report() zeroes every figure for a
// non-admin caller, but the dashboard doesn't even render this card unless
// ctx.profile.role is 'admin'.
const NO_TEAM = '__none__';

function drawAgentSpend(rows) {
  const card = document.getElementById('agent-spend');

  if (rows.length === 0) {
    card.innerHTML = `
      <div class="card__head"><h2>Agent spend</h2></div>
      ${empty('No agent has any scored calls yet.')}`;
    return;
  }

  const agentOptions = rows.map(r => ({ value: r.agent_id, label: r.full_name }));
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
    const agentId = agentSel.value;
    const team = teamSel.value;
    const filtered = rows.filter(r =>
      (agentId === 'all' || r.agent_id === agentId) &&
      (team === 'all' || (r.team_name || NO_TEAM) === team)
    );

    tbody.innerHTML = filtered.length === 0
      ? `<tr><td colspan="5">${empty('No agent matches these filters.')}</td></tr>`
      : filtered.map(r => `
        <tr>
          <td>${esc(r.full_name)}</td>
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
