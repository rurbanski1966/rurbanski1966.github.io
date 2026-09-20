// ---------------------------------------------------------------------------
// Agent-facing views: dashboard, my sales.
// Every view exports render(main, ctx) and wires its own listeners.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=40';
import { CATEGORIES } from './config.js?v=40';
import {
  esc, fmtMoneyExact, fmtNum, fmtDate,
  toast, statTile, statusChip, empty, spinner,
} from './ui.js?v=40';

const SERIES = {
  mapd:      'var(--series-1)',
  ancillary: 'var(--series-2)',
  combined:  'var(--series-3)',
};

/* === Dashboard ============================================================ */
export async function dashboard(main, ctx) {
  main.innerHTML = `
    <div class="page__head">
      <div>
        <h1>Dashboard</h1>
        <div class="page__sub">${esc(ctx.profile.full_name)} · month to date</div>
      </div>
    </div>
    <div id="kpis">${spinner()}</div>
    <div class="card" id="recent">${spinner()}</div>`;

  const [m, mine] = await Promise.all([db.myMetrics(), db.mySubmissions({ limit: 8 })]);

  document.getElementById('kpis').outerHTML = `
    <div class="kpis" id="kpis">
      ${statTile({ label: 'Daily spend', value: fmtMoneyExact(m.daily_spend), note: "AI grading cost, today's calls" })}
      ${statTile({ label: 'SMC Daily spend', value: fmtMoneyExact(m.smc_daily_spend), note: "AI grading + review costs, today's SMC calls" })}
      ${statTile({ label: 'Weekly spend', value: fmtMoneyExact(m.weekly_spend), note: 'AI grading cost, Monday–Sunday' })}
      ${statTile({ label: 'Monthly spend', value: fmtMoneyExact(m.monthly_spend), note: 'AI grading + review costs, this month' })}
      ${statTile({ label: 'Yearly spend', value: fmtMoneyExact(m.yearly_spend), note: 'AI grading + review costs, this year' })}
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
