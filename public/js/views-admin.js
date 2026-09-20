// ---------------------------------------------------------------------------
// Admin portal: team management, all submissions, reporting.
// Every view here assumes an admin profile; app.js gates the routes.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=42';
import { STATUSES, ROLES } from './config.js?v=42';
import {
  esc, fmtMoney, fmtMoneyExact, fmtNum, fmtDate, range, RANGES, monthStart,
  toast, barRow, legend, empty, spinner, selectField,
} from './ui.js?v=42';
import { catLabel, SERIES } from './views-agent.js?v=42';

/* === Agents =============================================================== */
// A temp password only has to clear Supabase's 8-char minimum and be easy to
// read aloud/retype once — it's replaced the first time the person signs in
// and changes it from Account.
function randomTempPassword() {
  const words = ['tide', 'maple', 'ridge', 'coral', 'delta', 'ember', 'grove', 'quartz', 'summit', 'willow'];
  const word = words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${word}-${digits}`;
}

export async function agents(main, ctx) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Agents</h1>
      <div class="page__sub">Roles, teams, and monthly AP targets</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn" id="new-team">New team</button>
      <button class="btn btn--primary" id="new-agent-toggle">New account</button>
    </div></div>
    <div class="card" id="new-agent-card" hidden></div>
    <div class="card" id="roster">${spinner()}</div>`;

  const roster = document.getElementById('roster');
  const newAgentCard = document.getElementById('new-agent-card');

  document.getElementById('new-team').addEventListener('click', async () => {
    const name = prompt('Team name');
    if (!name?.trim()) return;
    try {
      await db.createTeam(name.trim());
      toast('Team created.', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('new-agent-toggle').addEventListener('click', () => {
    newAgentCard.hidden = !newAgentCard.hidden;
    if (!newAgentCard.hidden) renderNewAgentForm();
  });

  function renderNewAgentForm() {
    newAgentCard.innerHTML = `
      <div class="card__head"><h2>New account</h2></div>
      <form id="new-agent-form">
        <div class="grid-2">
          <label class="field">
            <span>First name *</span>
            <input type="text" id="na-first" required maxlength="80">
          </label>
          <label class="field">
            <span>Last name *</span>
            <input type="text" id="na-last" required maxlength="80">
          </label>
        </div>
        <label class="field">
          <span>Email *</span>
          <input type="email" id="na-email" required>
        </label>
        <div class="grid-2">
          ${selectField('na-role', 'Role *', ROLES, 'agent')}
          <label class="field">
            <span>Temporary password *</span>
            <div style="display:flex;gap:8px">
              <input type="text" id="na-password" required minlength="8" value="${esc(randomTempPassword())}">
              <button class="btn" type="button" id="na-regen">New</button>
            </div>
          </label>
        </div>
        <p class="muted">Share this password with them directly — they can change it from Account after signing in.</p>
        <button class="btn btn--primary" type="submit" id="na-submit">Create account</button>
      </form>`;

    newAgentCard.querySelector('#na-regen').addEventListener('click', () => {
      newAgentCard.querySelector('#na-password').value = randomTempPassword();
    });

    newAgentCard.querySelector('#new-agent-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = newAgentCard.querySelector('#na-submit');
      const val = id => newAgentCard.querySelector('#' + id).value.trim();

      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        await db.createAgent(
          val('na-first'), val('na-last'), val('na-email'),
          newAgentCard.querySelector('#na-password').value, val('na-role')
        );
        toast(`Account created for ${val('na-email')}.`, 'ok');
        newAgentCard.hidden = true;
        draw();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create account';
      }
    });
  }

  async function draw() {
    roster.innerHTML = spinner();
    const [people, teams] = await Promise.all([db.listAgents(), db.listTeams()]);

    if (people.length === 0) {
      roster.innerHTML = empty('No accounts yet.');
      return;
    }

    const teamOpts = [{ value: '', label: '— unassigned —' }, ...teams.map(t => ({ value: t.id, label: t.name }))];

    roster.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(people.length)} account${people.length === 1 ? '' : 's'}</h2>
        <span class="muted">Targets apply to the current month</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Name</th><th>Email</th><th>Role</th><th>Team</th>
          <th class="num">Month target</th><th>Active</th><th></th>
        </tr></thead>
        <tbody>${people.map(p => `
          <tr data-id="${esc(p.id)}">
            <td>${esc(p.full_name || '—')}</td>
            <td class="muted">${esc(p.email)}</td>
            <td>
              <select data-field="role">
                ${ROLES.map(r => `<option value="${r.value}"${r.value === p.role ? ' selected' : ''}>${r.label}</option>`).join('')}
              </select>
            </td>
            <td>
              <select data-field="team_id">
                ${teamOpts.map(t => `<option value="${esc(t.value)}"${t.value === (p.team_id || '') ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
              </select>
            </td>
            <td class="num">
              <input type="number" min="0" step="100" data-field="target" placeholder="—" style="width:110px;text-align:right">
            </td>
            <td>
              <input type="checkbox" data-field="active"${p.active ? ' checked' : ''}>
            </td>
            <td>
              ${p.id === ctx.profile.id
                ? ''
                : `<button class="btn btn--ghost" data-action="remove" type="button">Remove</button>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    // Each control saves on change — no separate save button to forget.
    roster.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;

      tr.querySelector('[data-field="role"]').addEventListener('change', e =>
        save(id, { role: e.target.value }, 'Role updated.'));

      tr.querySelector('[data-field="team_id"]').addEventListener('change', e =>
        save(id, { team_id: e.target.value || null }, 'Team updated.'));

      tr.querySelector('[data-field="active"]').addEventListener('change', e =>
        save(id, { active: e.target.checked }, e.target.checked ? 'Account activated.' : 'Account deactivated.'));

      const removeBtn = tr.querySelector('[data-action="remove"]');
      removeBtn?.addEventListener('click', async () => {
        const name = tr.querySelector('td').textContent;
        if (!confirm(`Remove ${name}? This deletes their login and cannot be undone.`)) return;
        removeBtn.disabled = true;
        removeBtn.textContent = 'Removing…';
        try {
          await db.deleteAgent(id);
          toast('Account removed.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
          removeBtn.disabled = false;
          removeBtn.textContent = 'Remove';
        }
      });

      const target = tr.querySelector('[data-field="target"]');
      target.addEventListener('change', async () => {
        const value = Number(target.value);
        if (!Number.isFinite(value) || value < 0) return toast('Enter a valid target.', 'error');
        try {
          await db.setGoal(id, monthStart(), value);
          toast('Target saved.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function save(id, patch, msg) {
    try {
      await db.updateAgent(id, patch);
      toast(msg, 'ok');
    } catch (err) {
      toast(err.message, 'error');
      draw();
    }
  }

  await draw();
}

/* === Scripts ================================================================
   The talk-track an agent is supposed to follow on a call — separate from the
   rubric (how every call gets graded regardless of which script it was).
   Selecting one when uploading a call tells score-call what the agent was
   actually supposed to say, so the model can judge adherence to it directly
   instead of only the general rubric criteria.
   -------------------------------------------------------------------------- */
export async function scripts(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Scripts</h1>
      <div class="page__sub">Talk-tracks agents can be graded against on a call</div>
    </div>
    <button class="btn btn--primary" id="new-script-toggle">New script</button></div>
    <div class="card" id="new-script-card" hidden></div>
    <div class="card" id="script-list">${spinner()}</div>`;

  const list = document.getElementById('script-list');
  const newCard = document.getElementById('new-script-card');

  document.getElementById('new-script-toggle').addEventListener('click', () => {
    newCard.hidden = !newCard.hidden;
    if (!newCard.hidden) renderNewForm();
  });

  function renderNewForm() {
    newCard.innerHTML = `
      <div class="card__head"><h2>New script</h2></div>
      <form id="new-script-form">
        <label class="field">
          <span>Name *</span>
          <input type="text" id="ns-name" required maxlength="120" placeholder="e.g. MAPD enrollment script">
        </label>
        <label class="field">
          <span>Script content *</span>
          <textarea id="ns-content" rows="14" required placeholder="Paste the full talk-track here."></textarea>
        </label>
        <button class="btn btn--primary" type="submit" id="ns-save">Save script</button>
      </form>`;

    newCard.querySelector('#new-script-form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = newCard.querySelector('#ns-name').value.trim();
      const content = newCard.querySelector('#ns-content').value.trim();
      if (!content) return toast('Paste the script content.', 'error');

      const btn = newCard.querySelector('#ns-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.createScript(name, content);
        toast('Script saved.', 'ok');
        newCard.hidden = true;
        draw();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save script';
      }
    });
  }

  async function draw() {
    list.innerHTML = spinner();
    const rows = await db.listScripts();

    if (rows.length === 0) {
      list.innerHTML = empty('No scripts yet. Add one to make it selectable when uploading a call.');
      return;
    }

    list.innerHTML = `
      <div class="card__head"><h2>${fmtNum(rows.length)} script${rows.length === 1 ? '' : 's'}</h2></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Name</th><th>Added</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows.map(r => `
          <tr data-id="${esc(r.id)}">
            <td>${esc(r.name)}</td>
            <td class="tnum muted">${esc(fmtDate(r.created_at))}</td>
            <td><input type="checkbox" data-field="active"${r.active ? ' checked' : ''}></td>
            <td style="display:flex;gap:6px">
              <button class="btn btn--ghost btn--sm" data-action="edit" type="button">Edit</button>
              <button class="btn btn--ghost btn--sm" data-action="delete" type="button">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <div id="edit-script-card"></div>`;

    list.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;

      tr.querySelector('[data-field="active"]').addEventListener('change', async e => {
        try {
          await db.updateScript(id, { active: e.target.checked });
          toast(e.target.checked ? 'Script activated.' : 'Script deactivated.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
          draw();
        }
      });

      tr.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const name = tr.querySelector('td').textContent;
        if (!confirm(`Delete "${name}"? Calls already graded against it keep their record; this only removes it from the picker.`)) return;
        try {
          await db.deleteScript(id);
          toast('Script deleted.', 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      tr.querySelector('[data-action="edit"]').addEventListener('click', async () => {
        const full = await db.getScript(id);
        const editCard = document.getElementById('edit-script-card');
        editCard.innerHTML = `
          <div class="card" style="margin-top:14px">
            <div class="card__head"><h2>Edit script</h2></div>
            <form id="edit-script-form">
              <label class="field">
                <span>Name *</span>
                <input type="text" id="es-name" required maxlength="120" value="${esc(full.name)}">
              </label>
              <label class="field">
                <span>Script content *</span>
                <textarea id="es-content" rows="14" required>${esc(full.content)}</textarea>
              </label>
              <div style="display:flex;gap:10px">
                <button class="btn btn--primary" type="submit" id="es-save">Save changes</button>
                <button class="btn btn--ghost" type="button" id="es-cancel">Cancel</button>
              </div>
            </form>
          </div>`;

        editCard.querySelector('#es-cancel').addEventListener('click', () => { editCard.innerHTML = ''; });

        editCard.querySelector('#edit-script-form').addEventListener('submit', async e => {
          e.preventDefault();
          const name = editCard.querySelector('#es-name').value.trim();
          const content = editCard.querySelector('#es-content').value.trim();
          if (!content) return toast('Script content cannot be empty.', 'error');

          const btn = editCard.querySelector('#es-save');
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await db.updateScript(id, { name, content });
            toast('Script updated.', 'ok');
            editCard.innerHTML = '';
            draw();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Save changes';
          }
        });
      });
    });
  }

  await draw();
}

/* === Reports ============================================================== */
export async function reports(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Reports</h1>
      <div class="page__sub">AP by category, status, and team</div>
    </div></div>
    <div class="filters">${selectField('rep-range', 'Period', RANGES, 'month')}</div>
    <div id="report">${spinner()}</div>`;

  const host = document.getElementById('report');
  const rangeSel = document.getElementById('rep-range');

  async function draw() {
    host.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const rows = await db.adminReport(start, end);

    if (rows.length === 0) {
      host.innerHTML = `<div class="card">${empty('No data in this period.')}</div>`;
      return;
    }

    const pick = bucket => rows.filter(r => r.bucket === bucket);
    const grand = pick('category').reduce((sum, r) => sum + Number(r.total_ap), 0);

    host.innerHTML = `
      <div class="kpis">
        ${statTileLite('Total AP', fmtMoney(grand), `${esc(fmtDate(start))} – ${esc(fmtDate(end))}`)}
        ${statTileLite('Submissions', fmtNum(pick('category').reduce((s, r) => s + Number(r.cnt), 0)), 'All statuses')}
        ${statTileLite('Teams reporting', fmtNum(pick('team').filter(r => Number(r.total_ap) > 0).length), 'With AP this period')}
      </div>

      ${section('AP by category', pick('category'), 'categorical')}
      ${section('AP by status', pick('status'), 'status')}
      ${section('AP by team', pick('team'), 'sequential')}`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}

const statTileLite = (label, value, note) => `
  <div class="kpi">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${esc(value)}</div>
    <div class="kpi__note">${esc(note)}</div>
  </div>`;

// Three breakdowns, three color jobs:
//   category  → categorical (the series ARE the subject; 3 slots, gate-safe)
//   status    → the reserved status palette, always with icon + label
//   team      → sequential, one hue (magnitude comparison, identity irrelevant)
function section(title, rows, colorJob) {
  const live = rows.filter(r => Number(r.total_ap) > 0 || Number(r.cnt) > 0);
  if (live.length === 0) return `<div class="card"><h2>${esc(title)}</h2>${empty('Nothing to show.')}</div>`;

  const max = Math.max(...live.map(r => Number(r.total_ap)));
  const total = live.reduce((sum, r) => sum + Number(r.total_ap), 0);

  const colorFor = row => {
    if (colorJob === 'categorical') return SERIES[row.label] || 'var(--seq-400)';
    if (colorJob === 'status') return `var(--${STATUSES.find(s => s.value === row.label)?.tone || 'seq-400'})`;
    return 'var(--seq-400)';
  };

  const labelFor = row => {
    if (colorJob === 'categorical') return catLabel(row.label);
    if (colorJob === 'status') return STATUSES.find(s => s.value === row.label)?.label || row.label;
    return row.label;
  };

  const legendHtml = colorJob === 'categorical'
    ? legend(live.map(r => ({ color: colorFor(r), label: labelFor(r) })))
    : '';

  return `
    <div class="card">
      <div class="card__head">
        <h2>${esc(title)}</h2>
        <span class="muted tnum">${fmtMoney(total)}</span>
      </div>
      ${legendHtml}
      <div class="bars">
        ${live.map(r => barRow({
          rank: null,
          label: labelFor(r),
          sub: `${fmtNum(r.cnt)} submission${Number(r.cnt) === 1 ? '' : 's'}`,
          value: r.total_ap,
          display: fmtMoney(r.total_ap),
          max,
          color: colorFor(r),
        })).join('')}
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
        <div class="tablewrap" style="margin-top:10px"><table>
          <thead><tr><th>${esc(title.replace('AP by ', ''))}</th><th class="num">AP</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
          <tbody>${live.map(r => `
            <tr>
              <td>${esc(labelFor(r))}</td>
              <td class="num">${esc(fmtMoneyExact(r.total_ap))}</td>
              <td class="num">${esc(fmtNum(r.cnt))}</td>
              <td class="num">${total > 0 ? Math.round((Number(r.total_ap) / total) * 100) : 0}%</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </details>
    </div>`;
}
