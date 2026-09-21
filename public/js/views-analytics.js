// ---------------------------------------------------------------------------
// Analytics: score progression over time, at three rollup levels (agency,
// team, agent) — separate from Leaderboard, which is ranking/comparative for
// a single period rather than a drill-down history. Admin/reviewer-only,
// enforced by app.js's route roles and by analytics_trend()/analytics_agents()
// themselves (migration 030).
// ---------------------------------------------------------------------------
import * as db from './db.js?v=46';
import { SCORE_DIMENSIONS } from './config.js?v=46';
import {
  esc, fmtNum, empty, spinner, selectField, statTile,
  lineChart, legend, trendDelta,
} from './ui.js?v=46';

// Same label precedence as views-scoring.js's dimLabel, minus the per-score
// stamped label — analytics_trend() only ever returns a bare average number
// per dimension key, not the {label, rationale, ...} object a single score
// carries.
const DIMENSION_ORDER = new Map(SCORE_DIMENSIONS.map((d, i) => [d.key, i]));
const dimLabel = key =>
  SCORE_DIMENSIONS.find(d => d.key === key)?.label
  || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--seq-300)', 'var(--seq-500)', 'var(--seq-600)'];

// Mirrors views-agent.js's agentKey(): a labeled identity (no Lana login)
// carries agent_id = null, so the name has to stand in as the dropdown key.
const agentKey = a => a.agent_id || `name:${a.full_name}`;

function bucketLabel(dateStr, bucket) {
  const [y, m] = dateStr.split('-').map(Number);
  if (bucket === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

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
          ${['month', 'quarter'].map(b => `
            <button type="button" class="btn ${b === bucket ? 'btn--primary' : 'btn--ghost'}" data-bucket="${b}">
              ${b === 'month' ? 'Monthly' : 'Quarterly'}
            </button>`).join('')}
        </div>
      </div>`;

    filtersHost.querySelectorAll('[data-level]').forEach(btn =>
      btn.addEventListener('click', () => { level = btn.dataset.level; renderFilters(); draw(); }));
    filtersHost.querySelectorAll('[data-bucket]').forEach(btn =>
      btn.addEventListener('click', () => { bucket = btn.dataset.bucket; renderFilters(); draw(); }));

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

    lastRows = await db.analyticsTrend(params);
    renderChart();
  }

  function renderChart() {
    const rows = lastRows;
    if (rows.length === 0) {
      body.innerHTML = empty('No scored calls for this selection yet.');
      return;
    }

    const labels = rows.map(r => bucketLabel(r.bucket_start, bucket));
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
      ${lineChart({ series, labels })}

      <h2 style="margin-top:28px">Compliance findings by severity</h2>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>${bucket === 'month' ? 'Month' : 'Quarter'}</th>
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
      </table></div>`;

    body.querySelectorAll('[data-dim]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) activeDims.add(cb.dataset.dim); else activeDims.delete(cb.dataset.dim);
      renderChart();
    }));
    document.getElementById('an-compliance-toggle').addEventListener('change', e => {
      showCompliance = e.target.checked;
      renderChart();
    });
  }

  renderFilters();
  await draw();
}
