// ---------------------------------------------------------------------------
// Rubric — the grading baseline, visible to everyone, editable by admins.
//
// Agents can read this on purpose: people graded against a standard should be
// able to see the standard.
//
// Edits never mutate a published rubric. Saving inserts a NEW version and moves
// the active flag, so a score from March stays interpretable after the rubric
// changes in August — call_scores.rubric_version records which one graded it.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=40';
import { esc, fmtDate, toast, empty, spinner } from './ui.js?v=40';

/* --- prompt preview ------------------------------------------------------
   MUST match buildSystemPrompt() in supabase/functions/score-call/rubric.ts.
   Two implementations of the same assembly is a real duplication risk — if you
   change the section order or separators there, change them here too, or this
   page will confidently show a prompt that is not the one being sent.
   -------------------------------------------------------------------------- */
function assemblePrompt(r) {
  const scaleLines = (r.scale ?? [])
    .map(b => `- ${b.min}-${b.max}  ${b.label}. ${b.description}`)
    .join('\n');
  const dimensionLines = (r.dimensions ?? [])
    .map(d => {
      const weight = d.weight && Number(d.weight) !== 1 ? ` [weight: ${d.weight}x]` : '';
      const criteria = d.criteria?.length
        ? '\n' + d.criteria.map(c => `  - ${c}`).join('\n')
        : '';
      return `**${d.key}** (${d.label})${weight} — ${d.description}${criteria}`;
    })
    .join('\n\n');
  const codeLines = (r.finding_codes ?? [])
    .map(c => `- \`${c.code}\` (${c.label}) — ${c.description}`)
    .join('\n');

  return [
    r.intro,
    '## Scoring scale\n\nEvery dimension is scored 0-100 on this scale.\n\n' + scaleLines,
    r.scale_note,
    '## Dimensions\n\n' + dimensionLines,
    '## Compliance\n\n' + r.compliance_intro,
    'Finding codes:\n\n' + codeLines,
    r.severity_guidance,
    '## Evidence\n\n' + r.evidence_rules,
    '## Output\n\n' + r.output_guidance,
  ].map(s => (s ?? '').trim()).filter(Boolean).join('\n\n');
}

const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

/* --- editable list rows --------------------------------------------------- */
const rowBtn = label => `<button type="button" class="btn btn--ghost btn--sm" data-remove>${label}</button>`;

function scaleRow(b = { min: 0, max: 0, label: '', description: '' }) {
  return `<div class="rrow" data-kind="scale">
    <input type="number" data-f="min" value="${esc(b.min)}" placeholder="min" style="width:70px">
    <input type="number" data-f="max" value="${esc(b.max)}" placeholder="max" style="width:70px">
    <input type="text" data-f="label" value="${esc(b.label)}" placeholder="Label">
    <input type="text" data-f="description" value="${esc(b.description)}" placeholder="What this band means">
    ${rowBtn('Remove')}
  </div>`;
}

function dimRow(d = { key: '', label: '', description: '', criteria: [], weight: 1 }) {
  // Criteria edit as one-per-line rather than N separate inputs — adding,
  // removing and reordering a list of sentences is far easier in a textarea
  // than through a row of add/remove buttons.
  const criteria = (d.criteria ?? []).join('\n');
  return `<div class="rrow rrow--stack" data-kind="dimension">
    <div class="rrow__top">
      <input type="text" data-f="key" value="${esc(d.key)}" placeholder="key_name" style="width:170px">
      <input type="text" data-f="label" value="${esc(d.label)}" placeholder="Display label">
      <input type="number" data-f="weight" value="${esc(d.weight ?? 1)}" min="0.5" max="5" step="0.5"
             title="Relative importance to the overall score" style="width:80px">
      ${rowBtn('Remove')}
    </div>
    <textarea data-f="description" rows="3" placeholder="What this dimension judges, in a sentence or two">${esc(d.description)}</textarea>
    <label style="font-size:12px;color:var(--text-muted);margin-top:6px">Criteria — one per line</label>
    <textarea data-f="criteria" rows="6" placeholder="Asks what coverage the prospect has now.&#10;Establishes which doctors they want to keep.">${esc(criteria)}</textarea>
  </div>`;
}

function codeRow(c = { code: '', label: '', description: '' }) {
  return `<div class="rrow rrow--stack" data-kind="finding">
    <div class="rrow__top">
      <input type="text" data-f="code" value="${esc(c.code)}" placeholder="code_name" style="width:180px">
      <input type="text" data-f="label" value="${esc(c.label)}" placeholder="Display label">
      ${rowBtn('Remove')}
    </div>
    <textarea data-f="description" rows="2" placeholder="What triggers this finding">${esc(c.description)}</textarea>
  </div>`;
}

// Dimensions need their own reader: weight is numeric and criteria is a
// newline-separated textarea that has to come back as an array.
function readDimensions(container) {
  return [...container.querySelectorAll('.rrow')].map(row => {
    const get = f => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
    return {
      key: get('key').trim(),
      label: get('label').trim(),
      description: get('description').trim(),
      weight: Number(get('weight')) || 1,
      criteria: get('criteria')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
    };
  }).filter(d => d.key || d.label);
}

// Read rows back out of the DOM. Blank rows are dropped rather than saved —
// an empty dimension key would produce an output schema the API rejects.
function readRows(container, fields) {
  return [...container.querySelectorAll('.rrow')].map(row => {
    const out = {};
    for (const f of fields) {
      const el = row.querySelector(`[data-f="${f}"]`);
      out[f] = el ? (el.type === 'number' ? Number(el.value) : el.value.trim()) : '';
    }
    return out;
  }).filter(o => Object.values(o).some(v => v !== '' && v !== 0));
}

/* === View ================================================================= */
export async function rubric(main, ctx) {
  const isAdmin = ctx.profile.role === 'admin';
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Scoring rubric</h1>
      <div class="page__sub">The baseline every call is graded against</div>
    </div>${isAdmin ? `<button class="btn btn--primary" id="edit-toggle">Edit rubric</button>` : ''}</div>
    <div id="body">${spinner()}</div>`;

  const body = document.getElementById('body');
  let editing = false;
  let current = null;

  document.getElementById('edit-toggle')?.addEventListener('click', () => {
    editing = !editing;
    document.getElementById('edit-toggle').textContent = editing ? 'Cancel edit' : 'Edit rubric';
    render();
  });

  async function load() {
    current = await db.activeRubric();
    render();
  }

  function render() {
    if (!current) {
      body.innerHTML = `<div class="card">${empty(
        'No active rubric. Run supabase/004_rubric.sql, which seeds and publishes the baseline.'
      )}</div>`;
      return;
    }
    editing ? renderEditor() : renderRead();
  }

  /* --- read-only --- */
  function renderRead() {
    const r = current;
    body.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2>Version ${esc(r.version)}</h2>
          <span class="chip chip--good"><span aria-hidden="true">★</span>Active</span>
        </div>
        <p class="muted" style="margin:0">
          Published ${esc(fmtDate(r.created_at))}${r.notes ? ` · ${esc(r.notes)}` : ''}
        </p>
      </div>

      <div class="card">
        <div class="card__head"><h2>How the call is framed</h2></div>
        <p style="white-space:pre-wrap;margin:0">${esc(r.intro)}</p>
      </div>

      <div class="card">
        <div class="card__head"><h2>Scoring scale</h2><span class="muted">Every dimension, 0–100</span></div>
        <div class="tablewrap"><table>
          <thead><tr><th class="num">Range</th><th>Band</th><th>Meaning</th></tr></thead>
          <tbody>${(r.scale ?? []).map(b => `
            <tr><td class="num tnum">${esc(b.min)}–${esc(b.max)}</td>
                <td><strong>${esc(b.label)}</strong></td>
                <td class="muted">${esc(b.description)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        ${r.scale_note ? `<p class="muted" style="white-space:pre-wrap;margin:14px 0 0">${esc(r.scale_note)}</p>` : ''}
      </div>

      <div class="card">
        <div class="card__head"><h2>Dimensions</h2><span class="muted">${(r.dimensions ?? []).length} scored</span></div>
        <div style="display:flex;flex-direction:column;gap:16px">
          ${(r.dimensions ?? []).map(d => `
            <div>
              <strong>${esc(d.label)}</strong>
              <code style="margin-left:8px">${esc(d.key)}</code>
              ${Number(d.weight ?? 1) !== 1
                ? `<span class="chip chip--warning" style="margin-left:8px"><span aria-hidden="true">×</span>${esc(d.weight)} weight</span>` : ''}
              <div class="muted" style="margin-top:4px;white-space:pre-wrap">${esc(d.description)}</div>
              ${d.criteria?.length ? `
                <ul style="margin:8px 0 0;padding-left:20px;font-size:13px">
                  ${d.criteria.map(c => `<li>${esc(c)}</li>`).join('')}
                </ul>` : ''}
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card__head"><h2>Compliance findings</h2><span class="muted">${(r.finding_codes ?? []).length} codes</span></div>
        ${r.compliance_intro ? `<p class="muted" style="white-space:pre-wrap;margin:0 0 14px">${esc(r.compliance_intro)}</p>` : ''}
        <div class="tablewrap"><table>
          <thead><tr><th>Code</th><th>Label</th><th>Triggers when</th></tr></thead>
          <tbody>${(r.finding_codes ?? []).map(c => `
            <tr><td><code>${esc(c.code)}</code></td>
                <td>${esc(c.label)}</td>
                <td class="muted">${esc(c.description)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        ${r.severity_guidance ? `<p class="muted" style="white-space:pre-wrap;margin:14px 0 0">${esc(r.severity_guidance)}</p>` : ''}
      </div>

      <div class="card">
        <div class="card__head"><h2>Evidence rules</h2></div>
        <p style="white-space:pre-wrap;margin:0">${esc(r.evidence_rules)}</p>
      </div>

      <div class="card">
        <div class="card__head"><h2>Output guidance</h2></div>
        <p style="white-space:pre-wrap;margin:0">${esc(r.output_guidance)}</p>
      </div>

      <div class="card">
        <details>
          <summary style="cursor:pointer"><strong>Exact prompt sent to the model</strong>
            <span class="muted"> · assembled from the fields above</span></summary>
          <pre class="transcript-raw" style="margin-top:14px">${esc(assemblePrompt(r))}</pre>
        </details>
      </div>

      <div class="card" id="history">${spinner()}</div>`;

    renderHistory();
  }

  async function renderHistory() {
    const host = document.getElementById('history');
    if (!host) return;
    const all = await db.listRubrics();
    host.innerHTML = `
      <div class="card__head"><h2>Version history</h2><span class="muted">${all.length} total</span></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Version</th><th>Published</th><th>By</th><th>Notes</th><th></th></tr></thead>
        <tbody>${all.map(v => `
          <tr>
            <td><strong>${esc(v.version)}</strong>${v.is_active ? ' <span class="chip chip--good"><span aria-hidden="true">★</span>Active</span>' : ''}</td>
            <td class="tnum muted">${esc(fmtDate(v.created_at))}</td>
            <td class="muted">${esc(v.profiles?.full_name || '—')}</td>
            <td class="muted">${esc(v.notes || '')}</td>
            <td>${isAdmin && !v.is_active
              ? `<button class="btn btn--ghost btn--sm" data-activate="${esc(v.id)}">Make active</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    host.querySelectorAll('[data-activate]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Make this the active rubric? Calls scored from now on will use it.')) return;
        try {
          await db.publishRubric(btn.dataset.activate);
          toast('Rubric activated.', 'ok');
          await load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  /* --- editor --- */
  function renderEditor() {
    const r = current;
    const stamp = new Date().toISOString().slice(0, 10);

    body.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2>Editing from ${esc(r.version)}</h2>
          <span class="muted">Saving creates a new version — it never overwrites</span>
        </div>
        <form id="rubric-form">
          <div class="grid-2">
            <label class="field"><span>New version label *</span>
              <input type="text" id="version" required maxlength="40" value="${esc(stamp)}.1"></label>
            <label class="field"><span>What changed *</span>
              <input type="text" id="notes" required maxlength="200" placeholder="e.g. tightened discovery criteria"></label>
          </div>

          <label class="field"><span>How the call is framed</span>
            <textarea id="intro" rows="6">${esc(r.intro)}</textarea></label>

          <h3 style="margin:22px 0 8px">Scoring scale</h3>
          <div id="scale-rows">${(r.scale ?? []).map(scaleRow).join('')}</div>
          <button type="button" class="btn btn--ghost btn--sm" data-add="scale">Add band</button>

          <label class="field" style="margin-top:18px"><span>Scale notes</span>
            <textarea id="scale_note" rows="4">${esc(r.scale_note)}</textarea></label>

          <h3 style="margin:22px 0 8px">Dimensions</h3>
          <p class="muted" style="margin:0 0 10px;font-size:12px">
            Keys must be lowercase letters, digits and underscores. Changing a key
            means old scores no longer line up with the new one — rename the label
            instead when you only want different wording.
          </p>
          <div id="dim-rows">${(r.dimensions ?? []).map(dimRow).join('')}</div>
          <button type="button" class="btn btn--ghost btn--sm" data-add="dimension">Add dimension</button>

          <h3 style="margin:22px 0 8px">Compliance</h3>
          <label class="field"><span>Compliance framing</span>
            <textarea id="compliance_intro" rows="4">${esc(r.compliance_intro)}</textarea></label>
          <div id="code-rows">${(r.finding_codes ?? []).map(codeRow).join('')}</div>
          <button type="button" class="btn btn--ghost btn--sm" data-add="finding">Add finding code</button>

          <label class="field" style="margin-top:18px"><span>Severity guidance</span>
            <textarea id="severity_guidance" rows="4">${esc(r.severity_guidance)}</textarea></label>
          <label class="field"><span>Evidence rules</span>
            <textarea id="evidence_rules" rows="6">${esc(r.evidence_rules)}</textarea></label>
          <label class="field"><span>Output guidance</span>
            <textarea id="output_guidance" rows="5">${esc(r.output_guidance)}</textarea></label>

          <div style="display:flex;gap:10px;margin-top:18px">
            <button class="btn btn--primary" type="submit" id="save">Save and activate</button>
            <button class="btn" type="button" id="preview-btn">Preview prompt</button>
          </div>
        </form>
        <div id="preview"></div>
      </div>`;

    body.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.add;
        const host = { scale: 'scale-rows', dimension: 'dim-rows', finding: 'code-rows' }[kind];
        const html = { scale: scaleRow(), dimension: dimRow(), finding: codeRow() }[kind];
        document.getElementById(host).insertAdjacentHTML('beforeend', html);
      });
    });

    body.addEventListener('click', e => {
      if (e.target.matches('[data-remove]')) e.target.closest('.rrow').remove();
    });

    const gather = () => ({
      version: document.getElementById('version').value.trim(),
      notes: document.getElementById('notes').value.trim(),
      intro: document.getElementById('intro').value,
      scale: readRows(document.getElementById('scale-rows'), ['min', 'max', 'label', 'description']),
      scale_note: document.getElementById('scale_note').value,
      dimensions: readDimensions(document.getElementById('dim-rows')),
      compliance_intro: document.getElementById('compliance_intro').value,
      finding_codes: readRows(document.getElementById('code-rows'), ['code', 'label', 'description']),
      severity_guidance: document.getElementById('severity_guidance').value,
      evidence_rules: document.getElementById('evidence_rules').value,
      output_guidance: document.getElementById('output_guidance').value,
    });

    document.getElementById('preview-btn').addEventListener('click', () => {
      document.getElementById('preview').innerHTML = `
        <h3 style="margin:22px 0 8px">Prompt preview</h3>
        <pre class="transcript-raw">${esc(assemblePrompt(gather()))}</pre>`;
    });

    document.getElementById('rubric-form').addEventListener('submit', async e => {
      e.preventDefault();
      const payload = gather();

      // Validate here as well as in the function. A bad key produces an
      // opaque 400 from the model API; catching it now says what's wrong.
      const problems = [];
      if (!payload.dimensions.length) problems.push('At least one dimension is required.');
      for (const d of payload.dimensions) {
        if (!KEY_RE.test(d.key)) problems.push(`Dimension key "${d.key}" is not valid.`);
      }
      for (const c of payload.finding_codes) {
        if (!KEY_RE.test(c.code)) problems.push(`Finding code "${c.code}" is not valid.`);
      }
      const keys = payload.dimensions.map(d => d.key);
      if (new Set(keys).size !== keys.length) problems.push('Dimension keys must be unique.');
      if (problems.length) return toast(problems[0], 'error');

      const btn = document.getElementById('save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const created = await db.createRubricVersion(payload);
        await db.publishRubric(created.id);
        toast(`Version ${payload.version} is now active.`, 'ok');
        editing = false;
        document.getElementById('edit-toggle').textContent = 'Edit rubric';
        await load();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save and activate';
      }
    });
  }

  await load();
}
