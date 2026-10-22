// ---------------------------------------------------------------------------
// Call scoring: review list, single-call detail, admin scorecard.
//
// No model calls happen here. The browser uploads audio, stores a transcript,
// and asks an Edge Function to score — the Anthropic key never reaches the
// client.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=69';
import { SCORE_DIMENSIONS, FINDING_CODES, FINDING_SEVERITIES, RECORDING_STATUSES, CALL_TYPES, showsRubricScore } from './config.js?v=69';
import {
  esc, fmtNum, fmtDate, fmtMoneyExact, today, range, RANGES,
  toast, statTile, barRow, empty, spinner, selectField, loadPdfMake, pdfSafe, loadJSZip, downloadBlob,
} from './ui.js?v=69';

/* --- helpers ------------------------------------------------------------- */

const statusChipFor = status => {
  const s = RECORDING_STATUSES.find(x => x.value === status);
  if (!s) return esc(status);
  return `<span class="chip chip--${s.tone}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
};

// Separate from the AI score — whether a human reviewer has looked at the
// call and signed off, set only from the Approve button on the call's own
// page.
const reviewerStatusChip = approved => approved
  ? `<span class="chip chip--good"><span aria-hidden="true">✓</span>Approved</span>`
  : `<span class="chip chip--warning"><span aria-hidden="true">◷</span>Pending</span>`;

const severityChip = severity => {
  const s = FINDING_SEVERITIES.find(x => x.value === severity);
  if (!s) return esc(severity);
  return `<span class="chip chip--${s.tone}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</span>`;
};

// Scores live on a fixed 0-100 scale, so bars are drawn against 100 — not
// against the highest score in the set. Scaling to the local max would render
// five mediocre scores as a full-width row of bars.
const SCORE_MAX = 100;

// Render whatever dimensions the score actually contains, rather than a fixed
// list. The rubric is editable, so a score from an older version may carry
// dimensions that no longer exist — and a newer one may add some. Iterating a
// hardcoded list would silently drop both.
//
// Sorted by SCORE_DIMENSIONS' order rather than left in whatever order they
// come back in: Postgres jsonb does not guarantee it preserves key insertion
// order the way a JS object literal does, so relying on it made the displayed
// order effectively random per row. A dimension the rubric added that isn't
// in SCORE_DIMENSIONS sorts after all the known ones, in whatever order it
// arrived — that case is rare enough not to need its own rule.
const DIMENSION_ORDER = new Map(SCORE_DIMENSIONS.map((d, i) => [d.key, i]));
const entriesOf = dims => Object.entries(dims ?? {})
  .filter(([, v]) => v && typeof v === 'object')
  .sort(([a], [b]) => (DIMENSION_ORDER.get(a) ?? Infinity) - (DIMENSION_ORDER.get(b) ?? Infinity));

// Calibration (score_reviews) always compares against the model's own
// dimensions, regardless of any override — it's tuning the rubric, not
// reading the authoritative number. Keep this reading raw score.dimensions.
const dimensionEntries = score => entriesOf(score?.dimensions);

// Label precedence: the one stamped on the score when it was graded, then the
// current config, then a readable form of the key. The stamped label is first
// so an old score keeps the wording it was actually graded under.
const dimLabel = (key, v) =>
  v?.label
  || SCORE_DIMENSIONS.find(d => d.key === key)?.label
  || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const scoreTone = n =>
  n >= 75 ? 'var(--good)' : n >= 60 ? 'var(--warning)' : n >= 40 ? 'var(--serious)' : 'var(--critical)';

const fmtDuration = seconds => {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Turn a transcript into readable turns.
//
// Diarized output arrives as "Speaker 0: ..." lines; a pasted transcript may
// use real names, or no labels at all. Anything that doesn't match a label
// pattern is rendered as an unattributed line rather than being dropped —
// losing text here would mean the reader can't verify an evidence quote,
// which is the entire point of showing the transcript.
const SPEAKER_RE = /^\s*([A-Za-z][\w .'’-]{0,28}?)\s*:\s*(.*)$/;

// Shared with matchQuoteToTurn() below — "turn 4" has to mean the same line
// whether it's the transcript view rendering it or a coaching quote jumping
// to it.
function parseTurns(text) {
  const lines = String(text || '').split(/\r?\n/);
  const turns = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(SPEAKER_RE);
    if (m && m[2] !== undefined) {
      turns.push({ who: m[1].trim(), text: m[2] });
    } else if (turns.length && !turns[turns.length - 1].who) {
      // Continuation of an unlabeled block — keep it together.
      turns[turns.length - 1].text += '\n' + line;
    } else {
      turns.push({ who: null, text: line });
    }
  }
  return turns;
}

function transcriptHtml(text, segments) {
  const turns = parseTurns(text);
  if (turns.length === 0) return empty('Transcript is empty.');

  // Deepgram's segments are one-per-line in the same order the transcript
  // was written in. If the counts don't match, the transcript was edited by
  // hand after transcription and the alignment can no longer be trusted —
  // render without seek points rather than pointing at the wrong line.
  const timed = Array.isArray(segments) && segments.length === turns.length;

  // Stable speaker ordering so the same person keeps the same side/indent
  // through the whole call, regardless of who talks first.
  const speakers = [...new Set(turns.map(t => t.who).filter(Boolean))];

  return `<div class="transcript">${turns.map((t, i) => {
    const idx = t.who ? speakers.indexOf(t.who) % 2 : 0;
    const start = timed ? segments[i].start : null;
    return `
      <div class="turn${t.who ? ` turn--s${idx}` : ' turn--plain'}${start != null ? ' turn--clickable' : ''}"
           id="turn-${i}"${start != null ? ` data-start="${esc(start)}" tabindex="0" role="button" title="Play from here"` : ''}>
        <div class="turn__no">${i + 1}</div>
        ${t.who ? `<div class="turn__who">${esc(t.who)}</div>` : '<div class="turn__who"></div>'}
        <div class="turn__text">${esc(t.text)}</div>
      </div>`;
  }).join('')}</div>`;
}

const normalizeForMatch = s =>
  String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Evidence quotes are meant to be verbatim, so a substring match should catch
// most of them; a lightly paraphrased or trimmed quote falls back to whoever
// shares the most words. Returns a turn index, or -1 when nothing is close
// enough to point at with any confidence.
// A call page matches a hundred-odd quotes against the same transcript, and
// again on every redraw of the scorecard; normalise each transcript once.
const normTurnsCache = new WeakMap();

function matchQuoteToTurn(quote, turns) {
  if (!quote || turns.length === 0) return -1;
  if (!normTurnsCache.has(turns)) normTurnsCache.set(turns, turns.map(t => normalizeForMatch(t.text)));
  const normTurns = normTurnsCache.get(turns);

  const whole = matchNormalizedQuote(normalizeForMatch(quote), normTurns);
  if (whole !== -1) return whole;

  // The model often copies the speaker label along with the words ("Speaker
  // 0: Hi, this is…"), and a turn's text never contains its own label, so
  // the quote as given can't be found. Drop the labels and look again.
  const labels = [...new Set(turns.map(t => t.who).filter(Boolean))]
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const labelRe = new RegExp(`(?:${[...labels, 'speaker\\s*\\d+'].join('|')})\\s*:`, 'gi');
  const unlabeled = String(quote).replace(labelRe, ' ');
  if (unlabeled !== String(quote)) {
    const idx = matchNormalizedQuote(normalizeForMatch(unlabeled), normTurns);
    if (idx !== -1) return idx;
  }

  // A quote stitched from separate moments ("… the plan has a $0 premium …
  // and that covers your doctor") matches nowhere as one string. Its first
  // piece long enough to be distinctive is where the reader wants to land.
  // Verbatim only — a fragment is too short to trust on word overlap.
  const joined = normTurns.join(' ');
  for (const piece of String(quote).split(/\r?\n|\.{3,}|…|\[[^\]]*\]/).flatMap(p => p.split(labelRe))) {
    const np = normalizeForMatch(piece);
    if (np.split(' ').length < 4) continue;
    const at = joined.indexOf(np);
    if (at !== -1) return turnIndexAt(at, normTurns);
  }
  return -1;
}

// Which turn a character offset into normTurns.join(' ') falls in.
function turnIndexAt(at, normTurns) {
  let offset = 0;
  let idx = 0;
  for (let i = 0; i < normTurns.length && offset <= at; i++) {
    idx = i;
    offset += normTurns[i].length + 1; // +1 for the joining space
  }
  return idx;
}

function matchNormalizedQuote(nq, normTurns) {
  if (!nq) return -1;

  // Search the whole transcript as one string first, not turn-by-turn — a
  // verbatim quote can start in one turn and run into the next if Deepgram
  // split an utterance mid-sentence, so no single turn would contain it.
  const at = normTurns.join(' ').indexOf(nq);
  if (at !== -1) return turnIndexAt(at, normTurns);

  // No verbatim hit — the model paraphrased or trimmed the quote. Only trust
  // a fallback when one turn is an unambiguous best fit: a weak or generic
  // word-overlap match is worse than no jump, since a call full of common
  // insurance-sales vocabulary can score two unrelated lines almost equally
  // and land on the wrong one.
  const qWords = [...new Set(nq.split(' ').filter(w => w.length > 4))];
  if (qWords.length < 3) return -1;

  const scores = normTurns.map(nt => {
    const tWords = new Set(nt.split(' '));
    return qWords.filter(w => tWords.has(w)).length / qWords.length;
  });
  const best = scores.reduce((b, s, i) => (s > scores[b] ? i : b), 0);
  const runnerUp = Math.max(0, ...scores.filter((_, i) => i !== best));
  return scores[best] >= 0.8 && scores[best] - runnerUp >= 0.25 ? best : -1;
}

const REVIEWS_FILTER_KEY = 'lana-reviews-agent-filter';

// The latest call_scores row for a recording, effective-score resolved —
// the same "latest by created_at, override wins" logic call_scores_effective
// applies server-side (migration 007/031), done client-side here since the
// list embeds every score row a recording has ever had rather than a single
// pre-resolved column.
function effectiveScoreFor(rec) {
  if (!showsRubricScore(rec.call_type)) return null;
  const scores = rec.call_scores;
  if (!Array.isArray(scores) || scores.length === 0) return null;
  const latest = scores.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
  return latest.is_overridden ? latest.manual_overall_score : latest.overall_score;
}

// The latest scorecard grade for a Medicare call, reviewer's regrade winning
// over the model's — the same resolution the call page makes. Shown in the
// list only once the call is approved: until then the grade is still being
// checked, and a number in the list would read as final.
function approvedScorecardFor(rec) {
  if (!rec.reviewer_approved || !['medicare', 'medicare_ancillary'].includes(rec.call_type)) return null;
  const grades = rec.call_scorecards;
  if (!Array.isArray(grades) || grades.length === 0) return null;
  const latest = grades.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
  const reviewed = latest.manual_possible != null;
  const possible = reviewed ? latest.manual_possible : latest.possible;
  const percent = reviewed ? latest.manual_percent : latest.percent;
  return possible ? { percent: Number(percent), possible } : null;
}

// Score cell for the list: the rubric score, the approved scorecard grade
// with its Pass/Fail, or both on a Medicare + Ancillary call.
function listScoreCellHtml(rec) {
  const rubric = effectiveScoreFor(rec);
  const sc = approvedScorecardFor(rec);
  const parts = [];
  if (rubric != null) parts.push(esc(rubric));
  if (sc) {
    const pass = sc.percent >= SC_PASS_PERCENT;
    parts.push(`${esc(sc.percent)}%<br><span class="chip chip--${pass ? 'good' : 'critical'}">${pass ? 'PASS' : 'FAIL'}</span>`);
  }
  return parts.length ? parts.join('<br>') : '—';
}

// Background work on a list row: automatic transcription (transcribe-call
// webhook) and the automatic Medicare grade (score-scorecard webhook). Neither
// writes a "grading" status anywhere, so "in progress" is inferred from time:
// a Medicare call whose transcript landed in the last few minutes and has no
// grade yet is taken to be grading. Past the window it is "Not graded" — the
// webhook skipped it, failed, or isn't set up — and the button is the way in.
const SC_GRADING_WINDOW_MS = 5 * 60 * 1000;
const TRANSCRIBE_WINDOW_MS = 10 * 60 * 1000;
const LIST_POLL_MS = 8000;
const SCORECARD_CALL_TYPES = ['medicare', 'medicare_ancillary'];
const HAS_TRANSCRIPT_STATUSES = ['transcribed', 'scoring', 'scored'];
const ageMs = ts => Date.now() - new Date(ts).getTime();

// 'graded' | 'grading' | 'not_graded', or null when the scorecard does not
// apply to this row (not a Medicare call, or no transcript yet).
function scorecardStateFor(rec) {
  if (!SCORECARD_CALL_TYPES.includes(rec.call_type)) return null;
  if (!HAS_TRANSCRIPT_STATUSES.includes(rec.status)) return null;
  if (Array.isArray(rec.call_scorecards) && rec.call_scorecards.length) return 'graded';
  return ageMs(rec.updated_at || rec.created_at) < SC_GRADING_WINDOW_MS ? 'grading' : 'not_graded';
}

const scorecardStateChip = state => ({
  graded: `<span class="chip chip--good"><span aria-hidden="true">✓</span>Graded</span>`,
  grading: `<span class="chip chip--warning"><span aria-hidden="true">◷</span>Grading…</span>`,
  not_graded: `<span class="muted" style="font-size:12px">Not graded</span>`,
}[state] ?? '');

// Whether this row is waiting on something that will change it without the
// user doing anything — the list keeps refreshing while any row is.
function rowInProgress(rec) {
  if (['transcribing', 'scoring'].includes(rec.status)) return true;
  if (rec.status === 'uploaded' && rec.storage_path && ageMs(rec.created_at) < TRANSCRIBE_WINDOW_MS) return true;
  return scorecardStateFor(rec) === 'grading';
}

/* === Review list ========================================================== */
export async function reviews(main, ctx) {
  const isAdmin = ctx.profile.role === 'admin';

  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Call reviews</h1>
      <div class="page__sub">Upload a call or paste a transcript, then score it</div>
    </div></div>
    <div class="card" id="new" style="max-width:680px">${spinner()}</div>
    <div class="card" id="edit-card" style="max-width:680px" hidden></div>
    <div class="card" id="list">${spinner()}</div>`;

  const people = isAdmin ? await db.listAgents() : [];
  const rememberedNames = isAdmin ? await db.recordingAgentNames() : [];
  const scripts = await db.listScripts({ activeOnly: true });
  const teams = await db.listTeams();

  // Typed against a datalist: matches an existing account's name (case-
  // insensitive) and it's a real agent; anything else is saved as a label
  // with no login, per Ryan 2026-09-16 — recordings/grades still need to be
  // browsable by that name later, hence recordingAgentNames() below.
  const activePeople = people.filter(p => p.active);
  const nameToId = new Map(activePeople.map(p => [(p.full_name || p.email).trim().toLowerCase(), p.id]));

  // Every call's AI cost is reported under SMC or EWSS: its Agency Assigned,
  // else its agent's own team (migration 039). A call with neither would
  // land in Unassigned, so the form asks for one before saving.
  const teamOfAgent = new Map(people.map(p => [p.id, p.team_id]));
  const NEEDS_TEAM_MSG = "Set Agency Assigned to SMC or EWSS. This agent has no team, so the call's costs wouldn't be counted under either.";
  const agentTeamFor = agentId => (agentId ? (isAdmin ? teamOfAgent.get(agentId) : ctx.profile.team_id) : null);

  /* --- new recording --- */
  const newCard = document.getElementById('new');
  newCard.innerHTML = `
    <div class="card__head">
      <h2>Add a call</h2>
      <span class="muted">Audio, transcript, or both</span>
    </div>
    <form id="rec-form">
      <div class="grid-2">
        <label class="field">
          <span>Title</span>
          <input type="text" id="title" maxlength="120" placeholder="e.g. Tuesday MAPD callback">
        </label>
        <label class="field">
          <span>Call date *</span>
          <input type="date" id="call_on" value="${today()}" max="${today()}" required>
        </label>
      </div>

      ${isAdmin ? `
        <label class="field">
          <span>Agent on the call *</span>
          <input type="text" id="agent_input" list="agent-datalist" required
                 placeholder="Start typing a name…"
                 value="${esc(ctx.profile.full_name || '')}">
          <datalist id="agent-datalist">
            ${activePeople.map(p => `<option value="${esc(p.full_name || p.email)}">`).join('')}
            ${rememberedNames.map(n => `<option value="${esc(n)}">`).join('')}
          </datalist>
          <span class="muted" style="font-size:12px">
            Pick an existing account, or type a new name — it's saved as a label with no login and remembered here next time.
          </span>
        </label>` : ''}

      <label class="field">
        <span>Call type</span>
        <select id="call_type">
          <option value="">— none —</option>
          ${CALL_TYPES.map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}
        </select>
      </label>

      <label class="field">
        <span>Agency Assigned</span>
        <select id="team_id">
          <option value="">— none —</option>
          ${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
        </select>
        <span class="muted" style="font-size:12px">
          Attributes this call to EWSS or SMC on the leaderboard and spend totals. Leave blank to use the agent's own team; required if the agent has none.
        </span>
      </label>

      <label class="field">
        <span>Script</span>
        <select id="script_id">
          <option value="">— none / general —</option>
          ${scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
        </select>
        <span class="muted" style="font-size:12px">
          Grades the call against this specific talk-track, in addition to the rubric.${isAdmin ? ' Manage scripts under Admin.' : ''}
        </span>
      </label>

      <label class="field">
        <span>Audio file</span>
        <div id="audio-dropzone" class="dropzone" tabindex="0" role="button">
          <input type="file" id="audio" accept="audio/*" style="display:none">
          <span id="audio-dropzone-text">Drag and drop an audio file here, or click to browse</span>
        </div>
        <span class="muted" style="font-size:12px">Optional. Up to 100 MB. Needed only if you want automatic transcription.</span>
      </label>

      <label class="field">
        <span>Transcript</span>
        <textarea id="transcript" rows="6" placeholder="Paste the transcript here, or leave blank and transcribe the audio."></textarea>
        <span class="muted" style="font-size:12px">Speaker labels help — the rubric grades the agent, not the prospect.</span>
      </label>

      <button class="btn btn--primary" type="submit" id="rec-save">Add call</button>
    </form>`;

  /* --- audio drag-and-drop --- */
  const audioInput = newCard.querySelector('#audio');
  const dropzone = newCard.querySelector('#audio-dropzone');
  const dropzoneText = newCard.querySelector('#audio-dropzone-text');
  const DROPZONE_DEFAULT = 'Drag and drop an audio file here, or click to browse';

  const syncDropzoneText = () => {
    dropzoneText.textContent = audioInput.files[0]?.name || DROPZONE_DEFAULT;
  };

  dropzone.addEventListener('click', () => audioInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); audioInput.click(); }
  });
  audioInput.addEventListener('change', syncDropzoneText);

  ['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add('dropzone--active');
  }));
  ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.remove('dropzone--active');
  }));
  dropzone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) return toast('Drop an audio file.', 'error');
    // A plain FileList can't be built directly — DataTransfer is the
    // standard way to hand a dropped file to a real <input type="file">
    // so the rest of the form (and its submit handler) sees it exactly
    // like a click-to-browse selection.
    const dt = new DataTransfer();
    dt.items.add(file);
    audioInput.files = dt.files;
    syncDropzoneText();
  });

  newCard.querySelector('#rec-form').addEventListener('submit', async e => {
    e.preventDefault();
    const val = id => newCard.querySelector('#' + id)?.value.trim() ?? '';
    const file = newCard.querySelector('#audio').files[0];
    const transcript = newCard.querySelector('#transcript').value;

    if (!file && !transcript.trim()) {
      return toast('Add an audio file or a transcript.', 'error');
    }

    let agentId = ctx.profile.id;
    let agentName = null;
    if (isAdmin) {
      const typed = val('agent_input');
      if (!typed) return toast('Enter or pick an agent.', 'error');
      const matchedId = nameToId.get(typed.toLowerCase());
      if (matchedId) { agentId = matchedId; } else { agentId = null; agentName = typed; }
    }
    if (!val('team_id') && !agentTeamFor(agentId)) return toast(NEEDS_TEAM_MSG, 'error');

    const btn = newCard.querySelector('#rec-save');
    btn.disabled = true;
    btn.textContent = file ? 'Uploading…' : 'Saving…';

    try {
      const storagePath = file ? await db.uploadAudio(file) : null;
      await db.createRecording({
        agent_id: agentId,
        agent_name: agentName,
        script_id: val('script_id') || null,
        call_type: val('call_type') || null,
        team_id: val('team_id') || null,
        title: val('title'),
        call_on: val('call_on'),
        storage_path: storagePath,
        transcript,
      });
      toast('Call added.', 'ok');
      newCard.querySelector('#rec-form').reset();
      newCard.querySelector('#call_on').value = today();
      syncDropzoneText();
      draw();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add call';
    }
  });

  /* --- list --- */
  const list = document.getElementById('list');

  // Every recording for one person, real account or label — the "folder" an
  // admin opens to see everything scored for that name so far.
  const filterOptions = isAdmin
    ? [
        { value: '', label: 'All calls' },
        ...activePeople.map(p => ({ value: `id:${p.id}`, label: p.full_name || p.email })),
        ...rememberedNames.map(n => ({ value: `name:${n}`, label: n })),
      ]
    : [];

  if (isAdmin) {
    // Persisted per tab (not per page load) so opening a call and hitting
    // Back doesn't force re-picking the same agent — reviews() re-runs from
    // scratch on every navigation to #/reviews, there's no component state
    // to carry across that. Falls back to "All calls" if the remembered
    // value no longer matches anyone in today's list (e.g. the only label
    // under that name got renamed or deleted).
    const storedFilter = sessionStorage.getItem(REVIEWS_FILTER_KEY) || '';
    const initialFilter = filterOptions.some(o => o.value === storedFilter) ? storedFilter : '';

    document.querySelector('#list').insertAdjacentHTML('beforebegin', `
      <div class="filters">${selectField('agent-filter', 'Agent', filterOptions, initialFilter)}</div>`);
    document.getElementById('agent-filter').addEventListener('change', e => {
      sessionStorage.setItem(REVIEWS_FILTER_KEY, e.target.value);
      draw();
    });
  }

  // One pending refresh at a time. Cleared on every draw and simply not
  // re-armed once the list has left the page (navigated away).
  let pollTimer = null;

  async function draw({ quiet = false } = {}) {
    clearTimeout(pollTimer);
    if (!quiet) list.innerHTML = spinner();
    const filter = isAdmin ? document.getElementById('agent-filter').value : '';
    const [kind, value] = filter.split(/:(.*)/s);
    const rows = await db.listRecordings({
      limit: filter ? 500 : 100,
      agentId: kind === 'id' ? value : undefined,
      agentName: kind === 'name' ? value : undefined,
    });

    if (rows.length === 0) {
      list.innerHTML = empty('No calls yet.');
      return;
    }

    list.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(rows.length)} call${rows.length === 1 ? '' : 's'}</h2>
        <span class="muted">${fmtNum(rows.filter(r => r.status === 'scored').length)} scored</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Date</th><th>Call</th><th>Agent</th><th class="num">Score</th><th>Length</th><th>Status</th><th>Reviewer status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(r => {
          // Mirrors RLS: an admin can touch any row; anyone else only their
          // own upload, and only before scoring has committed it — matches
          // recordings_update_own's own status check, so a click here never
          // fails against a rule the button should have hidden for.
          const canEdit = isAdmin || (r.uploaded_by === ctx.profile.id && ['uploaded', 'transcribed', 'failed'].includes(r.status));
          const canDelete = isAdmin || r.uploaded_by === ctx.profile.id;
          return `
          <tr data-id="${esc(r.id)}">
            <td class="tnum">${esc(fmtDate(r.call_on))}</td>
            <td>${esc(r.title || 'Untitled call')}${r.error_message
              ? `<br><span class="muted">${esc(r.error_message.slice(0, 80))}</span>` : ''}</td>
            <td>${esc(r.agent?.full_name || r.agent_name || '—')}${r.team?.name ? `<br><span class="muted">${esc(r.team.name)}</span>` : ''}</td>
            <td class="num tnum">${listScoreCellHtml(r)}</td>
            <td class="tnum muted">${esc(fmtDuration(r.duration_seconds))}</td>
            <td>${statusChipFor(r.status)}${scorecardStateFor(r) ? `<br>${scorecardStateChip(scorecardStateFor(r))}` : ''}</td>
            <td>${reviewerStatusChip(r.reviewer_approved)}</td>
            <td style="display:flex;gap:6px;flex-wrap:wrap">
              <a class="btn btn--ghost btn--sm" href="#/reviews/${esc(r.id)}">Open</a>
              ${canEdit ? `<button class="btn btn--ghost btn--sm" data-action="edit" type="button">Edit</button>` : ''}
              ${canDelete ? `<button class="btn btn--ghost btn--sm" data-action="delete" type="button">Delete</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;

    list.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      const row = rows.find(r => r.id === id);

      tr.querySelector('[data-action="edit"]')?.addEventListener('click', () => renderEditForm(row));

      tr.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        if (!confirm(`Delete "${row.title || 'Untitled call'}"? This removes the call record, its transcript, and any score. This cannot be undone.`)) return;
        try {
          await db.deleteRecording(id);
          toast('Call deleted.', 'ok');
          if (editCard.dataset.editing === id) editCard.hidden = true;
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    if (rows.some(rowInProgress)) {
      pollTimer = setTimeout(() => { if (list.isConnected) draw({ quiet: true }); }, LIST_POLL_MS);
    }
  }

  /* --- edit --- */
  const editCard = document.getElementById('edit-card');

  function renderEditForm(row) {
    editCard.hidden = false;
    editCard.dataset.editing = row.id;
    const currentAgentName = row.agent?.full_name || row.agent_name || '';

    editCard.innerHTML = `
      <div class="card__head"><h2>Edit call</h2></div>
      <form id="edit-form">
        <div class="grid-2">
          <label class="field">
            <span>Title</span>
            <input type="text" id="ed-title" maxlength="120" value="${esc(row.title || '')}">
          </label>
          <label class="field">
            <span>Call date *</span>
            <input type="date" id="ed-call_on" value="${esc(row.call_on)}" max="${today()}" required>
          </label>
        </div>
        ${isAdmin ? `
          <label class="field">
            <span>Agent on the call *</span>
            <input type="text" id="ed-agent" list="agent-datalist" required value="${esc(currentAgentName)}">
          </label>` : ''}
        <label class="field">
          <span>Call type</span>
          <select id="ed-call_type">
            <option value="">— none —</option>
            ${CALL_TYPES.map(t => `<option value="${esc(t.value)}"${t.value === row.call_type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>Agency Assigned</span>
          <select id="ed-team_id">
            <option value="">— none —</option>
            ${teams.map(t => `<option value="${esc(t.id)}"${t.id === row.team_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>Script</span>
          <select id="ed-script">
            <option value="">— none / general —</option>
            ${scripts.map(s => `<option value="${esc(s.id)}"${s.id === row.script_id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </label>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn btn--primary" type="submit" id="ed-save">Save changes</button>
          <button class="btn btn--ghost" type="button" id="ed-cancel">Cancel</button>
        </div>
      </form>`;

    editCard.querySelector('#ed-cancel').addEventListener('click', () => {
      editCard.hidden = true;
      delete editCard.dataset.editing;
    });

    editCard.querySelector('#edit-form').addEventListener('submit', async e => {
      e.preventDefault();
      const patch = {
        title: editCard.querySelector('#ed-title').value.trim(),
        call_on: editCard.querySelector('#ed-call_on').value,
        script_id: editCard.querySelector('#ed-script').value || null,
        call_type: editCard.querySelector('#ed-call_type').value || null,
        team_id: editCard.querySelector('#ed-team_id').value || null,
      };

      if (isAdmin) {
        const typed = editCard.querySelector('#ed-agent').value.trim();
        if (!typed) return toast('Enter or pick an agent.', 'error');
        const matchedId = nameToId.get(typed.toLowerCase());
        patch.agent_id = matchedId || null;
        patch.agent_name = matchedId ? null : typed;
      }
      if (!patch.team_id && !agentTeamFor(isAdmin ? patch.agent_id : row.agent_id)) return toast(NEEDS_TEAM_MSG, 'error');

      const btn = editCard.querySelector('#ed-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.updateRecording(row.id, patch);
        toast('Call updated.', 'ok');
        editCard.hidden = true;
        delete editCard.dataset.editing;
        draw();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save changes';
      }
    });
  }

  await draw();
}

/* === Single call ========================================================== */
export async function reviewDetail(main, ctx, recordingId) {
  main.innerHTML = `<div class="card">${spinner()}</div>`;

  async function draw() {
    const rec = await db.getRecording(recordingId);
    if (!rec) {
      main.innerHTML = `
        <div class="page__head"><h1>Call not found</h1></div>
        <div class="card">${empty('This call does not exist, or is not visible to your account.')}</div>`;
      return;
    }

    // Left null on a Medicare-only call, which takes the whole coaching
    // score off the page and out of the report; the scorecard is its grade.
    const showRubric = showsRubricScore(rec.call_type);
    const score = showRubric && rec.status === 'scored' ? await db.scoreForRecording(rec.id) : null;
    const busy = rec.status === 'transcribing' || rec.status === 'scoring';
    const turns = parseTurns(rec.transcript);

    main.innerHTML = `
      <div class="page__head">
        <div>
          <h1>${esc(rec.title || 'Untitled call')}</h1>
          <div class="page__sub">
            ${esc(fmtDate(rec.call_on))} · ${esc(rec.agent?.full_name || rec.agent_name || '—')}
            ${rec.call_type ? ` · ${esc(CALL_TYPES.find(t => t.value === rec.call_type)?.label || rec.call_type)}` : ''}
            ${rec.team?.name ? ` · Agency Assigned: ${esc(rec.team.name)}` : ''}
            ${rec.script?.name ? ` · Script: ${esc(rec.script.name)}` : ''} · ${statusChipFor(rec.status)}
          </div>
        </div>
        <a class="btn btn--ghost" href="#/reviews">Back</a>
      </div>

      ${rec.error_message ? `
        <div class="card" style="border-color:var(--critical)">
          <h2>Last attempt failed</h2>
          <p class="muted">${esc(rec.error_message)}</p>
        </div>` : ''}

      <div class="card">
        <div class="card__head">
          <h2>Actions</h2>
          ${busy ? `<span class="muted">Working… reload in a moment</span>` : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${rec.storage_path ? `<button class="btn" id="play">Play audio</button>` : ''}
          ${rec.storage_path && !rec.transcript
            ? `<button class="btn" id="transcribe"${busy ? ' disabled' : ''}>Transcribe audio</button>` : ''}
          ${rec.transcript && showRubric
            ? `<button class="btn btn--primary" id="score"${busy ? ' disabled' : ''}>
                 ${score ? 'Re-score call' : 'Score call'}
               </button>` : ''}
          <button class="btn btn--ghost" id="reload">Reload</button>
          <button class="btn btn--ghost" id="gen-report" type="button"${score?.is_overridden ? '' : ' hidden'}>Generate report</button>
        </div>
        <div id="player" style="margin-top:14px"></div>
        ${!rec.transcript ? `
          <form id="paste-form" style="margin-top:18px">
            <label class="field">
              <span>Paste a transcript</span>
              <textarea id="paste" rows="6" placeholder="Speaker 0: ..."></textarea>
            </label>
            <button class="btn" type="submit">Save transcript</button>
          </form>` : ''}
      </div>

      <div id="score-header">${score ? scoreHeaderHtml(score) : ''}</div>
      <div id="override-area">${score && ctx.profile.role === 'admin' ? spinner() : ''}</div>
      <div id="dimensions-area">${score ? spinner() : ''}</div>
      <div id="findings-area">${score ? spinner() : ''}</div>
      <div id="score-footer">${score ? scoreFooterHtml(score) : ''}</div>
      <div id="scorecard-area"></div>

      ${rec.transcript ? `
        <div class="card">
          <div class="card__head">
            <h2>Full transcript</h2>
            <span class="muted">
              ${fmtNum(rec.transcript.split(/\r?\n/).filter(l => l.trim()).length)} lines ·
              ${fmtNum(rec.transcript.length)} characters ·
              ${esc(rec.transcript_source || 'unknown source')}
            </span>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:14px">
            <button class="btn btn--ghost btn--sm" id="copy-transcript">Copy transcript</button>
            <button class="btn btn--ghost btn--sm" id="toggle-wrap">Toggle raw text</button>
          </div>
          <div id="transcript-view">${transcriptHtml(rec.transcript, rec.transcript_segments)}</div>
          <pre id="transcript-raw" class="transcript-raw" hidden>${esc(rec.transcript)}</pre>
        </div>` : ''}

      ${ctx.profile.role === 'admin' ? `
        <div class="card">
          <div class="card__head">
            <h2>Reviewer status</h2>
            ${reviewerStatusChip(rec.reviewer_approved)}
          </div>
          <p class="muted" style="margin:0 0 14px">
            ${rec.reviewer_approved
              ? `Approved by ${esc(rec.reviewer?.full_name || 'an admin')} · ${esc(fmtDate(rec.reviewer_approved_at))}`
              : 'Mark this call approved once a reviewer has gone through it.'}
          </p>
          <button class="btn ${rec.reviewer_approved ? 'btn--ghost' : 'btn--primary'}" id="reviewer-toggle" type="button">
            ${rec.reviewer_approved ? 'Mark as pending' : 'Approve'}
          </button>
        </div>` : ''}`;

    document.getElementById('reload').addEventListener('click', draw);
    document.getElementById('gen-report')?.addEventListener('click', async e => {
      const btn = e.currentTarget;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Preparing PDF…';
      let summaryUpdated = false;
      try {
        if (score?.is_overridden) {
          btn.textContent = 'Summarizing review…';
          try {
            const result = await db.generateManualSummary(score.id);
            Object.assign(score, {
              manual_summary: result.summary,
              manual_strengths: result.strengths,
              manual_improvements: result.improvements,
            });
            // Only a fresh generation changes anything worth a redraw for —
            // a cache hit returns the same text and cost that's already on
            // the page.
            summaryUpdated = !result.cached;
          } catch (err) {
            toast(`Could not refresh the AI summary, using the existing one: ${err.message}`, 'error');
          }
        }

        btn.textContent = 'Preparing PDF…';
        await loadPdfMake();
        const agentSlug = (rec.agent?.full_name || rec.agent_name || 'agent')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // A call graded against the scorecard (every Medicare call is, on
        // upload) carries that grade in the same PDF: after the coaching
        // report when the call has a reviewed score, on its own otherwise.
        let scorecardArgs = null;
        try {
          const grade = await db.scorecardForRecording(rec.id);
          if (grade?.scorecard) scorecardArgs = scorecardReportArgs(rec, grade, ctx.profile.role === 'admin');
        } catch (err) {
          if (!score?.is_overridden) throw err;
          toast(`Could not load the scorecard, so the report leaves it out: ${err.message}`, 'error');
        }

        let docDefinition;
        if (score?.is_overridden) {
          docDefinition = coachingReportDocDefinition(rec, score);
          if (scorecardArgs) docDefinition.content.push(...scorecardReportContent(scorecardArgs, { appended: true }));
        } else if (scorecardArgs) {
          docDefinition = scorecardReportDocDefinition(scorecardArgs);
        } else {
          throw new Error('Nothing to report yet. Grade this call against the scorecard first.');
        }

        const baseName = `${score?.is_overridden ? 'coaching-report' : 'call-report'}-${agentSlug}-${rec.call_on}`;
        const pdfBlob = await new Promise((resolve, reject) => {
          try {
            window.pdfMake.createPdf(pdfSafe(docDefinition)).getBlob(resolve);
          } catch (err) { reject(err); }
        });

        if (!rec.storage_path) {
          // No audio on this call (transcript-only entry) — nothing to zip
          // with, so fall back to just the PDF.
          downloadBlob(pdfBlob, `${baseName}.pdf`);
          toast('No audio file on this call — downloaded the report alone.', 'ok');
        } else {
          btn.textContent = 'Bundling audio…';
          const [audioBlob] = await Promise.all([
            db.audioUrl(rec.storage_path).then(url => fetch(url)).then(res => {
              if (!res.ok) throw new Error(`Could not download the call recording (${res.status}).`);
              return res.blob();
            }),
            loadJSZip(),
          ]);
          const ext = (rec.storage_path.split('.').pop() || 'mp3').toLowerCase();
          const zip = new window.JSZip();
          zip.file(`${baseName}.pdf`, pdfBlob);
          zip.file(`${baseName}.${ext}`, audioBlob);
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          downloadBlob(zipBlob, `${baseName}.zip`);
        }
      } catch (err) {
        toast(err.message || 'Could not generate the PDF.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        // Refreshes Cost to score and the Summary of Call banner with the
        // newly generated text/cost — the local `score` object was already
        // updated above for the PDF itself, but the rest of the page (drawn
        // before this ran) still shows the old figures until this redraws.
        if (summaryUpdated) draw();
      }
    });
    if (score && ctx.profile.role === 'admin') drawOverride(score, draw);
    if (score) drawDimensions(score, ctx, turns, draw);
    if (score) drawFindings(score, ctx, turns, draw);
    // Assigned further down, once the audio helpers it needs exist. The
    // scorecard only calls it on a click, long after this function returns.
    let jumpToTurn = () => {};
    if (rec.transcript) drawScorecard(rec, ctx, turns, idx => jumpToTurn(idx));

    document.getElementById('reviewer-toggle')?.addEventListener('click', async e => {
      const btn = e.currentTarget;
      const next = !rec.reviewer_approved;
      btn.disabled = true;
      try {
        await db.setReviewerApproval(rec.id, next);

        let msg = next ? 'Call approved.' : 'Marked as pending.';
        let tone = 'ok';
        if (next && score?.is_overridden) {
          try {
            await db.generateManualSummary(score.id);
          } catch (err) {
            msg = `Approved, but the AI summary could not be generated: ${err.message}`;
            tone = 'error';
          }
        }
        toast(msg, tone);
        draw();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    document.getElementById('play')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const url = await db.audioUrl(rec.storage_path);
        document.getElementById('player').innerHTML =
          `<audio controls id="rec-audio" src="${esc(url)}" style="width:100%"></audio>`;
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });

    // Loads the player on demand — a transcript line or a coaching quote can
    // be clicked before "Play audio" ever was — then seeks once the audio
    // actually has a duration to seek within.
    async function ensureAudioAndSeek(startSeconds) {
      if (!rec.storage_path || !Number.isFinite(startSeconds)) return;
      let audio = document.getElementById('rec-audio');
      if (!audio) {
        try {
          const url = await db.audioUrl(rec.storage_path);
          document.getElementById('player').innerHTML =
            `<audio controls id="rec-audio" src="${esc(url)}" style="width:100%"></audio>`;
          audio = document.getElementById('rec-audio');
        } catch (err) {
          toast(err.message, 'error');
          return;
        }
      }
      const seek = () => { audio.currentTime = startSeconds; audio.play(); };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }

    // Clicking a transcript line seeks the audio there directly.
    document.getElementById('transcript-view')?.addEventListener('click', e => {
      const turnEl = e.target.closest('.turn--clickable');
      if (turnEl) ensureAudioAndSeek(Number(turnEl.dataset.start));
    });

    // Clicking a coaching evidence quote scrolls to the transcript line it
    // matched and seeks the audio there — the quote is what the model says
    // proves the score, so verifying it in context is the whole point.
    jumpToTurn = idx => {
      const turnEl = document.getElementById(`turn-${idx}`);
      if (turnEl) {
        turnEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        turnEl.classList.add('turn--flash');
        setTimeout(() => turnEl.classList.remove('turn--flash'), 1500);
        if (turnEl.dataset.start !== undefined) ensureAudioAndSeek(Number(turnEl.dataset.start));
      }
    };
    const onQuoteClick = e => {
      const jumpEl = e.target.closest('[data-turn]');
      if (jumpEl) jumpToTurn(jumpEl.dataset.turn);
    };
    // Both areas get their own DOM subtree recreated on every redraw (by
    // drawDimensions/drawFindings), unlike `main` itself — attaching here
    // instead of higher up avoids piling up a duplicate listener each time.
    document.getElementById('dimensions-area')?.addEventListener('click', onQuoteClick);
    document.getElementById('findings-area')?.addEventListener('click', onQuoteClick);
    document.getElementById('scorecard-area')?.addEventListener('click', onQuoteClick);

    document.getElementById('transcribe')?.addEventListener('click', async e => {
      e.target.disabled = true;
      e.target.textContent = 'Transcribing…';
      try {
        await db.transcribeCall(rec.id);
        toast('Transcript ready.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });

    document.getElementById('score')?.addEventListener('click', async e => {
      e.target.disabled = true;
      e.target.textContent = 'Scoring…';
      try {
        const result = await db.scoreCall(rec.id);
        toast(`Scored. Cost ${fmtMoneyExact(result?.cost_usd ?? 0)}.`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });

    document.getElementById('paste-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const text = document.getElementById('paste').value;
      if (!text.trim()) return toast('Paste a transcript first.', 'error');
      try {
        await db.saveTranscript(rec.id, text);
        toast('Transcript saved.', 'ok');
        draw();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('copy-transcript')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rec.transcript);
        toast('Transcript copied.', 'ok');
      } catch {
        // clipboard API needs a secure context; localhost counts, but a plain
        // http:// LAN address does not — say so rather than failing silently.
        toast('Copy blocked by the browser. Use "Toggle raw text" and select it.', 'error');
      }
    });

    document.getElementById('toggle-wrap')?.addEventListener('click', () => {
      const pretty = document.getElementById('transcript-view');
      const raw = document.getElementById('transcript-raw');
      const showRaw = raw.hidden;
      raw.hidden = !showRaw;
      pretty.hidden = showRaw;
    });
  }

  await draw();
}

/* --- scorecard: pass/fail checklist with per-item regrade -------------------
   A second instrument beside the rubric score above (migration 035). The
   model grades every scorecard item pass / fail / N/A with a reason and the
   quotes that decided it, and flags the ones a person should look at. An
   admin can flip any item; the points recompute here from the verdicts and
   the scorecard's own point values.

   The model's grade is never edited. A regrade is saved to manual_items on
   the same row the moment it is made — there is no Save button to forget —
   and the model's score stays on screen next to the reviewed one so it is
   always clear what a person changed.

   Self-contained and failure-tolerant on purpose: if migration 035 hasn't
   been run, or the lookup fails, this section shows the error in its own
   card rather than taking the rest of the call page down with it.
   -------------------------------------------------------------------------- */
const SC_VERDICTS = [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']];
const scVerdictLabel = v => SC_VERDICTS.find(([key]) => key === v)?.[1] ?? v;
const scVerdictChip = (v, prefix = '') => {
  const tone = v === 'pass' ? 'good' : v === 'fail' ? 'critical' : null;
  return `<span class="chip${tone ? ` chip--${tone}` : ' muted'}">${esc(prefix + scVerdictLabel(v))}</span>`;
};

// The transcript line a scorecard item's feedback is about: wherever its
// first locatable quote is. -1 when the item has no quote (a fail for
// something never said) or none of them can be found in the transcript.
function scJumpTurn(ai, turns) {
  for (const quote of ai.evidence ?? []) {
    const idx = matchQuoteToTurn(quote, turns);
    if (idx !== -1) return idx;
  }
  return -1;
}
const scJumpAttrs = idx =>
  idx === -1 ? '' : ` data-turn="${idx}" role="button" tabindex="0" title="Play this part of the call"`;

// N/A items leave both numbers. Same rule as score-scorecard/index.ts — keep
// the two in step.
function scorecardTally(items, verdictOf) {
  let earned = 0;
  let possible = 0;
  for (const item of items) {
    const v = verdictOf(item.id);
    if (v === 'na') continue;
    possible += item.points;
    if (v === 'pass') earned += item.points;
  }
  return { earned, possible, percent: possible ? Math.round(1000 * earned / possible) / 10 : null };
}
// The scorecard's pass mark, on the percentage of applicable points earned.
const SC_PASS_PERCENT = 85;
// 'pass' | 'fail', or null for a call where no item applied.
const scResult = t => (t.possible ? (t.percent >= SC_PASS_PERCENT ? 'pass' : 'fail') : null);
const scResultChip = t => {
  const r = scResult(t);
  return r ? `<span style="color:var(--${r === 'pass' ? 'good' : 'critical'});margin-left:10px">${r === 'pass' ? 'PASS' : 'FAIL'}</span>` : '';
};
const SC_PASS_RULE = `${SC_PASS_PERCENT}% or higher is a Pass. Below ${SC_PASS_PERCENT}% is a Fail.`;
const scTallyText = t => t.possible ? `${t.earned}/${t.possible} · ${t.percent}%` : 'Nothing applicable';

// "Detailed call rubric report": the whole scorecard for one graded call in a
// single read — what each item requires, the verdict it got, and the points
// that verdict earned, subtotalled by section. Read-only; it shows the same
// final verdicts as the card behind it, so a reviewer's regrade is reflected
// and labelled rather than hidden.
const SC_UNGRADED = { verdict: 'na', confidence: 'low', reason: '', evidence: [], checkpoints: [], needs_review: true, review_reason: 'Not graded.' };

// The totals every form of the report prints, worked out in one place so the
// on-screen report, its PDF and the Generate report bundle cannot disagree.
function scorecardReportFigures(card, finalOf) {
  const sections = card.definition.sections;
  const allItems = sections.flatMap(s => s.items);
  const naItems = allItems.filter(i => finalOf(i.id) === 'na');
  return {
    total: scorecardTally(allItems, finalOf),
    fullPoints: card.definition.total_points ?? allItems.reduce((n, i) => n + i.points, 0),
    naItems,
    naPoints: naItems.reduce((n, i) => n + i.points, 0),
    rows: sections.map(s => {
      const tally = scorecardTally(s.items, finalOf);
      const available = s.items.reduce((n, i) => n + i.points, 0);
      return { section: s, tally, available, na: available - tally.possible };
    }),
  };
}

// Everything scorecardReportContent needs, read straight off a stored grade
// row (db.scorecardForRecording) — for callers outside drawScorecard, which
// has its own live copies of these.
function scorecardReportArgs(rec, grade, isAdmin) {
  const card = grade.scorecard;
  const aiById = new Map(grade.items.map(i => [i.id, i]));
  const manual = grade.manual_items ?? {};
  const aiOf = id => aiById.get(id) ?? SC_UNGRADED;
  const finalOf = id => manual[id]?.verdict ?? aiOf(id).verdict;
  return {
    rec, card, aiOf, finalOf, isAdmin,
    changed: id => finalOf(id) !== aiOf(id).verdict,
    noteOf: id => manual[id]?.note ?? '',
    ...scorecardReportFigures(card, finalOf),
  };
}

function openScorecardReport({ rec, card, aiOf, finalOf, changed, noteOf, isAdmin, turns = [], jumpToTurn = () => {} }) {
  document.getElementById('sc-report')?.remove();

  const pts = n => `${fmtNum(n)} pt${n === 1 ? '' : 's'}`;
  const { total, fullPoints, naItems, naPoints, rows } = scorecardReportFigures(card, finalOf);

  const itemHtml = item => {
    const ai = aiOf(item.id);
    const final = finalOf(item.id);
    const earned = final === 'pass' ? item.points : 0;
    const note = noteOf(item.id);
    const jump = scJumpTurn(ai, turns);
    return `
      <div class="sc-item sc-item--${esc(final)}">
        <div class="sc-item__head">
          <div><strong>${esc(item.id)}</strong> ${esc(item.question)}</div>
          <strong class="sc-report__pts">${final === 'na' ? 'N/A' : `${fmtNum(earned)} / ${fmtNum(item.points)}`}</strong>
        </div>
        <div class="sc-item__meta">
          ${scVerdictChip(final)}
          <span class="muted">${esc(item.weight)} · worth ${esc(pts(item.points))}${final === 'na' ? ' · not counted' : ''}</span>
          ${changed(item.id) ? `<span class="chip chip--warning">Changed by reviewer${isAdmin ? ` · AI said ${esc(scVerdictLabel(ai.verdict))}` : ''}</span>` : ''}
        </div>
        <div class="sc-report__label">What earns the points</div>
        <p class="sc-report__text">${esc(item.context)}</p>
        ${item.example ? `<p class="sc-report__text muted"><em>Example:</em> ${esc(item.example)}</p>` : ''}
        <div class="sc-report__label">How this call was graded</div>
        <p class="sc-report__text${jump === -1 ? '' : ' evidence--jump'}"${scJumpAttrs(jump)}>${esc(ai.reason || 'No explanation was recorded.')}</p>
        ${ai.checkpoints?.length ? `
          <ul class="sc-checks">${ai.checkpoints.map(c => `<li data-status="${esc(c.status)}">${esc(c.name)}</li>`).join('')}</ul>` : ''}
        <div class="sc-report__quotes">${(ai.evidence ?? []).map(q => evidenceHtml(q, turns)).join('')}</div>
        ${note ? `<p class="sc-report__text muted">Reviewer note: ${esc(note)}</p>` : ''}
      </div>`;
  };

  const dialog = document.createElement('dialog');
  dialog.id = 'sc-report';
  dialog.className = 'sc-report';
  dialog.setAttribute('aria-labelledby', 'sc-report-title');
  dialog.innerHTML = `
    <div class="sc-report__bar">
      <h2 id="sc-report-title">Detailed call rubric report</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn--primary btn--sm" type="button" data-pdf>Download as PDF</button>
        <button class="btn btn--ghost btn--sm" type="button" data-close>Close</button>
      </div>
    </div>
    <div class="sc-report__body">
      <p class="muted" style="margin:0 0 16px">
        ${esc(rec.title || 'Untitled call')} · ${esc(fmtDate(rec.call_on))} · ${esc(rec.agent?.full_name || rec.agent_name || '—')}
        · ${esc(card.name)}, version ${esc(card.version)}
      </p>
      <div class="field">
        <span class="muted">Total score</span>
        <strong style="font-size:26px">${total.possible ? `${fmtNum(total.earned)} of ${fmtNum(total.possible)} points · ${total.percent}%` : 'Nothing applicable'}${scResultChip(total)}</strong>
        <span class="muted" style="font-size:13px;display:block">
          ${SC_PASS_RULE}
          The scorecard totals ${esc(pts(fullPoints))}.
          ${naItems.length
            ? `${fmtNum(naItems.length)} item${naItems.length === 1 ? '' : 's'} worth ${esc(pts(naPoints))} did not apply to this call and ${naItems.length === 1 ? 'is' : 'are'} left out of the score.`
            : 'Every item applied to this call.'}
        </span>
      </div>

      <h3 class="sc-report__h">Points by section</h3>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Section</th><th class="num">Points available</th><th class="num">N/A</th><th class="num">Points scored</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><a href="#sc-report-s${esc(r.section.section_number)}" data-jump="sc-report-s${esc(r.section.section_number)}">${esc(r.section.section_number)}. ${esc(r.section.section_name)}</a></td>
              <td class="num">${fmtNum(r.available)}</td>
              <td class="num">${r.na ? fmtNum(r.na) : '—'}</td>
              <td class="num"><strong>${r.tally.possible ? `${fmtNum(r.tally.earned)} / ${fmtNum(r.tally.possible)}` : 'N/A'}</strong></td>
            </tr>`).join('')}
          <tr>
            <td><strong>Total</strong></td>
            <td class="num"><strong>${fmtNum(fullPoints)}</strong></td>
            <td class="num"><strong>${naPoints ? fmtNum(naPoints) : '—'}</strong></td>
            <td class="num"><strong>${total.possible ? `${fmtNum(total.earned)} / ${fmtNum(total.possible)}` : 'N/A'}</strong></td>
          </tr>
        </tbody>
      </table></div>

      ${rows.map(r => `
        <div class="sc-section" id="sc-report-s${esc(r.section.section_number)}">
          <div class="sc-section__head">
            <strong>${esc(r.section.section_number)}. ${esc(r.section.section_name)}</strong>
            <span>${r.tally.possible
              ? `Scored ${fmtNum(r.tally.earned)} of ${esc(pts(r.tally.possible))}${r.na ? ` · ${esc(pts(r.na))} N/A` : ''}`
              : `N/A · ${esc(pts(r.available))} not counted`}</span>
          </div>
          ${r.section.items.map(itemHtml).join('')}
        </div>`).join('')}
    </div>`;

  async function downloadPdf(btn) {
    btn.disabled = true;
    btn.textContent = 'Preparing PDF…';
    try {
      await loadPdfMake();
      const agentSlug = (rec.agent?.full_name || rec.agent_name || 'agent')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const doc = scorecardReportDocDefinition({
        rec, card, rows, total, fullPoints, naItems, naPoints, aiOf, finalOf, changed, noteOf, isAdmin,
      });
      const blob = await new Promise((resolve, reject) => {
        try { window.pdfMake.createPdf(pdfSafe(doc)).getBlob(resolve); } catch (err) { reject(err); }
      });
      downloadBlob(blob, `rubric-report-${agentSlug}-${rec.call_on}.pdf`);
    } catch (err) {
      toast(err.message || 'Could not generate the PDF.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download as PDF';
    }
  }

  dialog.addEventListener('click', e => {
    const pdfBtn = e.target.closest('[data-pdf]');
    if (pdfBtn) return downloadPdf(pdfBtn);
    // A click on the dialog element itself is a click on the backdrop.
    if (e.target === dialog || e.target.closest('[data-close]')) return dialog.close();
    // Feedback and quotes that point at a transcript line: the report is in
    // the way of the transcript, so step aside, then go there and play it.
    const turnEl = e.target.closest('[data-turn]');
    if (turnEl) {
      dialog.close();
      return jumpToTurn(turnEl.dataset.turn);
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      // The app's router owns the hash, so scroll instead of navigating.
      e.preventDefault();
      dialog.querySelector(`#${CSS.escape(jump.dataset.jump)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

// The same report as a pdfmake document — see coachingReportDocDefinition for
// why pdfmake. Takes the figures openScorecardReport already worked out, so
// the PDF can never disagree with the report on screen.
function scorecardReportDocDefinition(args) {
  const agentName = args.rec.agent?.full_name || args.rec.agent_name || 'Unknown agent';
  return {
    info: { title: `Detailed call rubric report - ${agentName} - ${fmtDate(args.rec.call_on)}` },
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 44],
    defaultStyle: { fontSize: 9 },
    footer: (page, pages) => ({ text: `Page ${page} of ${pages}`, alignment: 'center', fontSize: 8, color: '#888888', margin: [0, 14, 0, 0] }),
    content: scorecardReportContent(args),
  };
}

// The report's body. `appended` is for the Generate report bundle, where it
// follows the coaching report inside one PDF: it starts on a fresh page and
// drops the masthead the document already opened with.
function scorecardReportContent({
  rec, card, rows, total, fullPoints, naItems, naPoints, aiOf, finalOf, changed, noteOf, isAdmin,
}, { appended = false } = {}) {
  const agentName = rec.agent?.full_name || rec.agent_name || 'Unknown agent';
  const pts = n => `${fmtNum(n)} pt${n === 1 ? '' : 's'}`;
  // pdfmake's embedded Roboto has no tick, cross or arrow glyph; the
  // scorecard wording uses all three ("✓ PASS if…") and they would print as
  // empty boxes.
  const clean = s => String(s ?? '').replace(/[✓✔✗✘]\s*/g, '').replace(/→/g, '->').trim();
  const verdictColor = v => (v === 'pass' ? '#146c46' : v === 'fail' ? '#96281d' : '#666666');
  const tableHeader = text => ({ text, bold: true, fontSize: 8, color: '#666666' });
  const num = (text, extra = {}) => ({ ...extra, text: String(text), alignment: 'right' });
  const label = text => ({ text: text.toUpperCase(), fontSize: 7, bold: true, color: '#888888', margin: [0, 5, 0, 1] });

  // Labelled lines rather than one line joined with dots: this report goes
  // to agents as a training aid and should read as plain text.
  const infoLine = [
    `Agent: ${agentName}`,
    `Call date: ${fmtDate(rec.call_on)}`,
    rec.title ? `Call: ${rec.title}` : null,
    rec.team?.name ? `Agency Assigned: ${rec.team.name}` : null,
    rec.script?.name ? `Script: ${rec.script.name}` : null,
    `Scorecard: ${card.name}, version ${card.version}`,
  ].filter(Boolean).join('\n');

  const scored = t => (t.possible ? `${fmtNum(t.earned)} / ${fmtNum(t.possible)}` : 'N/A');
  const band = total.percent == null ? ['#444444', '#f0f0f0']
    : total.percent >= SC_PASS_PERCENT ? ['#146c46', '#e8f7ee'] : ['#96281d', '#fdeceb'];
  const result = scResult(total);

  const content = [
    ...(appended ? [] : [
      { text: [{ text: 'L', color: '#7C2FD6' }, { text: 'ANA', color: '#1E1029' }], bold: true, fontSize: 20 },
      { text: 'AI SALES COACHING & SCORING', fontSize: 8, bold: true, color: '#8B7FA0', characterSpacing: 1, margin: [0, 2, 0, 16] },
    ]),

    {
      text: appended ? card.name : 'Detailed call rubric report',
      fontSize: 18, bold: true, margin: [0, 0, 0, 4],
      ...(appended ? { pageBreak: 'before' } : {}),
    },
    { text: infoLine, fontSize: 9, color: '#666666', margin: [0, 0, 0, 14] },

    {
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: 'Total score', fontSize: 9, color: '#555555' },
            {
              text: total.possible ? `${fmtNum(total.earned)} of ${fmtNum(total.possible)} points (${total.percent}%)` : 'Nothing applicable',
              fontSize: 20, bold: true, color: band[0], margin: [0, 3, 0, 3],
            },
            ...(result ? [{
              text: [
                { text: `RESULT: ${result === 'pass' ? 'PASS' : 'FAIL'}`, bold: true, fontSize: 14, color: band[0] },
                { text: `   ${SC_PASS_RULE}`, fontSize: 8, color: '#666666' },
              ],
              margin: [0, 0, 0, 4],
            }] : []),
            {
              text: `The scorecard totals ${pts(fullPoints)}. ` + (naItems.length
                ? `${fmtNum(naItems.length)} item${naItems.length === 1 ? '' : 's'} worth ${pts(naPoints)} did not apply to this call and ${naItems.length === 1 ? 'is' : 'are'} left out of the score.`
                : 'Every item applied to this call.'),
              fontSize: 8, color: '#666666',
            },
          ],
          fillColor: band[1],
          margin: [10, 8, 10, 8],
        }]],
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 16],
    },

    { text: 'Points by section', fontSize: 13, bold: true, margin: [0, 0, 0, 6] },
    {
      table: {
        widths: ['*', 'auto', 'auto', 'auto'],
        headerRows: 1,
        body: [
          [tableHeader('Section'), num('Points available', tableHeader('')), num('N/A', tableHeader('')), num('Points scored', tableHeader(''))],
          ...rows.map(r => [
            `${r.section.section_number}. ${r.section.section_name}`,
            num(fmtNum(r.available)),
            num(fmtNum(r.na)),
            num(scored(r.tally), { bold: true }),
          ]),
          [
            { text: 'Total', bold: true },
            num(fmtNum(fullPoints), { bold: true }),
            num(fmtNum(naPoints), { bold: true }),
            num(scored(total), { bold: true }),
          ],
        ],
      },
      layout: 'lightHorizontalLines',
    },
  ];

  for (const r of rows) {
    content.push({
      columns: [
        { width: '*', text: `${r.section.section_number}. ${r.section.section_name}`, fontSize: 13, bold: true },
        {
          width: 'auto', fontSize: 10, bold: true, margin: [0, 3, 0, 0],
          text: r.tally.possible
            ? `Scored ${fmtNum(r.tally.earned)} of ${pts(r.tally.possible)}${r.na ? `, ${pts(r.na)} N/A` : ''}`
            : `N/A, ${pts(r.available)} not counted`,
        },
      ],
      margin: [0, 18, 0, 6],
    });
    content.push({
      table: {
        widths: ['30%', '13%', '*'],
        headerRows: 1,
        // An item's requirement and its grade stay on one page together.
        dontBreakRows: true,
        body: [
          [tableHeader('Item'), tableHeader('Result'), tableHeader('What earns the points, and how this call was graded')],
          ...r.section.items.map(item => {
            const ai = aiOf(item.id);
            const final = finalOf(item.id);
            const details = [
              { ...label('What earns the points'), margin: [0, 0, 0, 1] },
              { text: clean(item.context), fontSize: 8 },
            ];
            if (item.example) details.push({ text: `Example: ${clean(item.example)}`, fontSize: 8, italics: true, color: '#555555', margin: [0, 2, 0, 0] });
            details.push(label('How this call was graded'));
            details.push({ text: clean(ai.reason) || 'No explanation was recorded.', fontSize: 8 });
            if (ai.checkpoints?.length) {
              details.push({
                text: `Checkpoints: ${ai.checkpoints.map(c => `${clean(c.name)} (${c.status === 'na' ? 'N/A' : c.status})`).join(', ')}`,
                fontSize: 8, color: '#444444', margin: [0, 2, 0, 0],
              });
            }
            for (const q of ai.evidence ?? []) {
              details.push({ text: `"${clean(q)}"`, fontSize: 8, italics: true, color: '#444444', margin: [8, 3, 0, 0] });
            }
            const note = noteOf(item.id);
            if (note) details.push({ text: `Reviewer note: ${clean(note)}`, fontSize: 8, color: '#666666', margin: [0, 3, 0, 0] });

            const result = [
              { text: scVerdictLabel(final), fontSize: 9, bold: true, color: verdictColor(final) },
              { text: final === 'na' ? 'Not counted' : `${fmtNum(final === 'pass' ? item.points : 0)} / ${fmtNum(item.points)} pts`, fontSize: 9 },
            ];
            if (changed(item.id)) {
              result.push({
                text: `Changed by reviewer${isAdmin ? ` (AI said ${scVerdictLabel(ai.verdict)})` : ''}`,
                fontSize: 7, color: '#8a6508', margin: [0, 2, 0, 0],
              });
            }
            return [
              { stack: [
                { text: [{ text: `${item.id}  `, bold: true }, clean(item.question)], fontSize: 9 },
                { text: `${item.weight}, worth ${pts(item.points)}`, fontSize: 7, color: '#888888', margin: [0, 2, 0, 0] },
              ] },
              { stack: result },
              { stack: details },
            ];
          }),
        ],
      },
      layout: 'lightHorizontalLines',
    });
  }

  content.push({
    text: `Generated ${fmtDate(new Date().toISOString())}. N/A items are left out of the score.`,
    fontSize: 8,
    color: '#666666',
    margin: [0, 24, 0, 0],
  });

  return content;
}

async function drawScorecard(rec, ctx, turns, jumpToTurn = () => {}) {
  const host = document.getElementById('scorecard-area');
  if (!host) return;
  const isAdmin = ctx.profile.role === 'admin';

  let grade;
  let card;
  try {
    grade = await db.scorecardForRecording(rec.id);
    card = grade?.scorecard ?? await db.activeScorecard();
  } catch (err) {
    // Said out loud rather than left blank: an empty section is
    // indistinguishable from "this account isn't allowed to see it".
    host.innerHTML = `
      <div class="card" style="border-color:var(--critical)">
        <h2>Scorecard could not be loaded</h2>
        <p class="muted">${esc(err.message)}</p>
      </div>`;
    return;
  }
  if (!card) return;

  const sections = card.definition.sections;
  const allItems = sections.flatMap(s => s.items);
  const forScripts = card.definition.applies_to_scripts ?? [];
  const scriptNote = forScripts.length && !forScripts.includes(rec.script?.name)
    ? `<p class="muted" style="margin:0 0 14px;font-size:13px">This scorecard is written for calls on ${esc(forScripts.join(' or '))}. This call ${rec.script?.name ? `is on ${esc(rec.script.name)}` : 'has no script set'}.</p>`
    : '';

  async function runGrade(btn) {
    btn.disabled = true;
    btn.textContent = 'Grading… about a minute';
    try {
      const result = await db.gradeScorecard(rec.id);
      toast(`Graded. Cost ${fmtMoneyExact(result?.cost_usd ?? 0)}.`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    drawScorecard(rec, ctx, turns, jumpToTurn);
  }

  if (!grade) {
    host.innerHTML = `
      <div class="card">
        <div class="card__head"><h2>${esc(card.name)}</h2><span class="muted">Not graded yet</span></div>
        ${scriptNote}
        <p class="muted" style="margin:0 0 14px">
          ${fmtNum(allItems.length)} pass/fail items worth ${fmtNum(card.definition.total_points)} points,
          graded one by one with the transcript lines that decided each.
        </p>
        <button class="btn btn--primary" id="sc-grade" type="button">Grade against scorecard</button>
      </div>`;
    host.onclick = e => { if (e.target.id === 'sc-grade') runGrade(e.target); };
    host.onchange = null;
    return;
  }

  // A graded call has something to report, whether or not its coaching score
  // was ever reviewed — see the gen-report handler.
  document.getElementById('gen-report')?.removeAttribute('hidden');

  const aiById = new Map(grade.items.map(i => [i.id, i]));
  const aiOf = id => aiById.get(id) ?? SC_UNGRADED;

  // { item id: { verdict, note, checked } } — only items a reviewer touched.
  const manual = structuredClone(grade.manual_items ?? {});
  const finalOf = id => manual[id]?.verdict ?? aiOf(id).verdict;
  const changed = id => finalOf(id) !== aiOf(id).verdict;
  const pending = id => aiOf(id).needs_review && !manual[id]?.checked && !changed(id);

  const FILTERS = [
    ['all', 'All', () => true],
    ['review', 'Needs review', pending],
    ['fail', 'Failed', id => finalOf(id) === 'fail'],
    ['na', 'N/A', id => finalOf(id) === 'na'],
    ['changed', 'Changed', changed],
  ];
  let filter = 'all';

  // Saves are chained so two quick clicks can't land out of order and leave
  // the older state as the stored one.
  let saving = Promise.resolve();
  function save() {
    const snapshot = structuredClone(manual);
    const totals = scorecardTally(allItems, finalOf);
    saving = saving
      .then(() => db.saveScorecardReview(grade.id, snapshot, totals))
      .catch(err => toast(`Could not save that change: ${err.message}`, 'error'));
  }

  function itemHtml(item) {
    const ai = aiOf(item.id);
    const final = finalOf(item.id);
    const note = manual[item.id]?.note ?? '';
    const jump = scJumpTurn(ai, turns);
    return `
      <div class="sc-item sc-item--${esc(final)}">
        <div class="sc-item__head">
          <div>
            <strong>${esc(item.id)}</strong> ${esc(item.question)}
            <div class="sc-item__meta">
              ${isAdmin ? scVerdictChip(ai.verdict, 'AI: ') : scVerdictChip(final)}
              <span class="muted">${esc(item.weight)} · ${esc(item.points)} pt${item.points === 1 ? '' : 's'}${isAdmin ? ` · ${esc(ai.confidence)} confidence` : ''}</span>
              ${changed(item.id) ? `<span class="chip chip--warning">Changed by reviewer</span>` : ''}
              ${isAdmin && pending(item.id) ? `<span class="chip chip--warning"><span aria-hidden="true">!</span>Needs review</span>` : ''}
            </div>
          </div>
          ${isAdmin ? `
            <div class="sc-verdict" role="group" aria-label="Grade for ${esc(item.id)}">
              ${SC_VERDICTS.map(([v, label]) => `
                <button type="button" data-item="${esc(item.id)}" data-verdict="${v}" aria-pressed="${final === v}">${label}</button>`).join('')}
            </div>` : ''}
        </div>
        <div class="muted${jump === -1 ? '' : ' evidence--jump'}" style="margin:8px 0"${scJumpAttrs(jump)}>${esc(ai.reason)}</div>
        ${isAdmin && ai.needs_review && ai.review_reason ? `
          <div class="sc-flag">
            Flagged: ${esc(ai.review_reason)}
            ${pending(item.id) ? `<button class="btn btn--ghost btn--sm" type="button" data-confirm="${esc(item.id)}" style="margin-left:8px">AI grade is right</button>` : ''}
          </div>` : ''}
        ${ai.checkpoints?.length ? `
          <ul class="sc-checks">${ai.checkpoints.map(c => `<li data-status="${esc(c.status)}">${esc(c.name)}</li>`).join('')}</ul>` : ''}
        <div style="display:flex;flex-direction:column;gap:6px">
          ${(ai.evidence ?? []).map(q => evidenceHtml(q, turns)).join('')}
        </div>
        <details>
          <summary>Scorecard guidance</summary>
          <p>${esc(item.context)}</p>
          ${item.example ? `<p><em>Example:</em> ${esc(item.example)}</p>` : ''}
        </details>
        ${isAdmin
          ? `<textarea class="sc-note" data-note="${esc(item.id)}" placeholder="Reviewer note" aria-label="Reviewer note for ${esc(item.id)}">${esc(note)}</textarea>`
          : note ? `<div class="muted" style="font-size:12px;margin-top:6px">Reviewer note: ${esc(note)}</div>` : ''}
      </div>`;
  }

  function render() {
    const final = scorecardTally(allItems, finalOf);
    const reviewed = Object.keys(manual).length > 0;
    const left = allItems.filter(i => pending(i.id)).length;
    const test = FILTERS.find(([key]) => key === filter)[2];
    const shown = sections
      .map(s => ({ section: s, items: s.items.filter(i => test(i.id)) }))
      .filter(x => x.items.length);

    host.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2>${esc(card.name)}</h2>
          ${reviewed
            ? `<span class="chip chip--good"><span aria-hidden="true">✓</span>Reviewed${grade.reviewer?.full_name ? ` by ${esc(grade.reviewer.full_name)}` : ''}</span>`
            : `<span class="muted">As graded by the model</span>`}
        </div>
        ${scriptNote}
        ${grade.alerts?.length ? `
          <div style="border-left:3px solid var(--critical);padding:4px 0 4px 12px;margin-bottom:16px">
            <strong>Compliance alerts</strong>
            <ul style="margin:4px 0 0;padding-left:18px">${grade.alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
          </div>` : ''}
        <div class="grid-2">
          <div class="field">
            <span class="muted">${reviewed ? 'Reviewed score' : 'Score'}</span>
            <strong style="font-size:22px">${esc(scTallyText(final))}${scResultChip(final)}</strong>
            <span class="muted" style="font-size:12px;display:block">${SC_PASS_RULE}</span>
            ${reviewed ? `<span class="muted" style="font-size:12px;display:block">Model graded ${esc(scTallyText({ earned: grade.earned, possible: grade.possible, percent: Number(grade.percent) }))}</span>` : ''}
          </div>
          ${isAdmin ? `
            <div class="field">
              <span class="muted">Still to check</span>
              <strong style="font-size:22px">${fmtNum(left)}</strong>
              <span class="muted" style="font-size:12px;display:block">of ${fmtNum(allItems.filter(i => aiOf(i.id).needs_review).length)} the model flagged</span>
            </div>` : ''}
        </div>
        <button class="btn btn--primary" type="button" id="sc-report-open" style="margin-bottom:14px">Detailed call rubric report</button>
        <p class="muted" style="margin:0;font-size:13px">
          N/A items are left out of the score. Version ${esc(grade.scorecard_version)} ·
          graded ${esc(fmtDate(grade.created_at))}${isAdmin && grade.cost_usd != null ? ` · cost ${esc(fmtMoneyExact(grade.cost_usd))}` : ''}.
          ${isAdmin ? 'Changes save as you make them.' : ''}
        </p>
        <div class="sc-filters">
          ${(isAdmin ? FILTERS : FILTERS.filter(([key]) => key !== 'review')).map(([key, label, match]) => `
            <button class="btn btn--ghost btn--sm" type="button" data-filter="${key}" aria-pressed="${filter === key}">
              ${label} (${allItems.filter(i => match(i.id)).length})
            </button>`).join('')}
          ${isAdmin ? `
            <span style="flex:1"></span>
            ${reviewed ? `<button class="btn btn--ghost btn--sm" type="button" id="sc-revert">Revert to the model's grades</button>` : ''}
            <button class="btn btn--ghost btn--sm" type="button" id="sc-regrade">Re-grade</button>` : ''}
        </div>
        ${shown.length ? shown.map(({ section, items }) => `
          <div class="sc-section">
            <div class="sc-section__head">
              <strong>${esc(section.section_number)}. ${esc(section.section_name)}</strong>
              <span class="muted">${esc(scTallyText(scorecardTally(section.items, finalOf)))}</span>
            </div>
            ${items.map(itemHtml).join('')}
          </div>`).join('') : empty('Nothing in this view.')}
      </div>`;
  }

  // Assigned, not added: this function runs again after a grade or a revert,
  // on the same host element, and must replace the previous run's handlers
  // rather than stack a second set on top of them.
  host.onclick = async e => {
    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn) { filter = filterBtn.dataset.filter; return render(); }

    if (e.target.id === 'sc-report-open') {
      return openScorecardReport({
        rec, card, aiOf, finalOf, changed, isAdmin, turns, jumpToTurn,
        noteOf: id => manual[id]?.note ?? '',
      });
    }

    const verdictBtn = e.target.closest('[data-verdict]');
    if (verdictBtn && isAdmin) {
      const id = verdictBtn.dataset.item;
      manual[id] = { ...manual[id], verdict: verdictBtn.dataset.verdict, checked: true };
      save();
      return render();
    }

    const confirmBtn = e.target.closest('[data-confirm]');
    if (confirmBtn && isAdmin) {
      const id = confirmBtn.dataset.confirm;
      manual[id] = { ...manual[id], verdict: finalOf(id), checked: true };
      save();
      return render();
    }

    if (e.target.id === 'sc-revert') {
      if (!confirm("Discard every regrade and note on this scorecard and go back to the model's grades?")) return;
      try {
        await saving;
        await db.clearScorecardReview(grade.id);
        toast("Reverted to the model's grades.", 'ok');
      } catch (err) { toast(err.message, 'error'); }
      return drawScorecard(rec, ctx, turns, jumpToTurn);
    }

    if (e.target.id === 'sc-regrade') {
      const warning = Object.keys(manual).length
        ? 'Grade this call again? The new grade replaces this one on screen, and the regrades and notes made here will not carry over.'
        : 'Grade this call again?';
      if (confirm(warning)) runGrade(e.target);
    }
  };

  // Notes save when the box loses focus, not per keystroke, and without a
  // re-render — that would steal focus from whatever was clicked next.
  host.onchange = e => {
    const id = e.target.dataset?.note;
    if (!id || !isAdmin) return;
    manual[id] = { ...manual[id], verdict: finalOf(id), note: e.target.value.trim(), checked: manual[id]?.checked ?? false };
    save();
  };

  render();
}

/* --- compliance findings: per-finding manual review ------------------------
   Each finding gets its own Manual review button rather than one shared
   form — a reviewer is usually correcting one specific call, not re-grading
   every finding at once. Editing turns a finding into a 0-100 score
   (0 = most severe, 100 = no issue); severity is DERIVED from that number,
   never chosen separately, so the two can't disagree. Saving recomputes the
   whole call's overall score and compliance verdict from every surviving
   finding's severity plus the current dimension scores — see
   recomputeFromFindings() — so a finding you just fixed immediately changes
   the grade everywhere it's read, not just this table.
   -------------------------------------------------------------------------- */
async function drawFindings(score, ctx, turns, onSaved) {
  const host = document.getElementById('findings-area');
  if (!host) return;
  const isAdmin = ctx.profile.role === 'admin';

  const eff = effectiveOf(score);
  // Editing always starts from whatever is currently authoritative — the
  // last override if there is one, otherwise the model's own findings.
  const findings = (score.manual_findings ?? score.findings ?? []).map(f => ({ ...f }));

  let editingIdx = null;
  render();

  function render() {
    host.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2>Compliance findings</h2>
          <span class="muted">${eff.compliance_passed ? 'Passed' : 'Needs attention'}</span>
        </div>
        ${findings.length === 0 ? empty('No compliance issues found.') : `
          <div class="tablewrap"><table>
            <thead><tr><th>Issue</th><th>Severity</th><th>Detail</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
            <tbody>${findings.map((f, i) => i === editingIdx ? editRowHtml(f, i) : viewRowHtml(f, i)).join('')}</tbody>
          </table></div>`}
      </div>`;
    wire();
  }

  function viewRowHtml(f, i) {
    return `
      <tr>
        <td>${esc(FINDING_CODES[f.code] || f.code)}</td>
        <td>${severityChip(f.severity)}</td>
        <td>${esc(f.detail || '')}
          ${evidenceHtml(f.evidence, turns, { inline: true })}
          ${f.reason ? `<br><span class="muted" style="font-size:12px">Reviewer note: ${esc(f.reason)}</span>` : ''}</td>
        ${isAdmin ? `<td><button class="btn btn--ghost btn--sm" data-review="${i}" type="button">Manual review</button></td>` : ''}
      </tr>`;
  }

  function editRowHtml(f, i) {
    const current = f.manual_score ?? severityToScore(f.severity);
    return `
      <tr>
        <td colspan="4">
          <div style="display:flex;flex-direction:column;gap:10px;padding:6px 0">
            <div><strong>${esc(FINDING_CODES[f.code] || f.code)}</strong> — currently ${severityChip(f.severity)}</div>
            <div class="muted" style="font-size:13px">${esc(f.detail || '')}</div>
            <div class="grid-2">
              <label class="field">
                <span>Corrected score * <span class="muted">(0 = most severe, 100 = no issue)</span></span>
                <input type="number" min="0" max="100" required id="fr-score" value="${esc(current)}">
              </label>
              <label class="field">
                <span>New severity</span>
                <input type="text" id="fr-preview" disabled value="${scoreToSeverity(current)}">
              </label>
            </div>
            <label class="field">
              <span>Explanation *</span>
              <textarea id="fr-reason" rows="2" required placeholder="Why this finding was re-graded">${esc(f.reason || '')}</textarea>
            </label>
            <div style="display:flex;gap:10px">
              <button class="btn btn--primary" type="button" data-save="${i}">Save</button>
              <button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function wire() {
    host.querySelectorAll('[data-review]').forEach(btn => {
      btn.addEventListener('click', () => { editingIdx = Number(btn.dataset.review); render(); });
    });
    host.querySelector('[data-cancel]')?.addEventListener('click', () => { editingIdx = null; render(); });

    const scoreInput = host.querySelector('#fr-score');
    scoreInput?.addEventListener('input', () => {
      const n = Number(scoreInput.value);
      host.querySelector('#fr-preview').value = Number.isFinite(n) ? scoreToSeverity(n) : '—';
    });

    host.querySelector('[data-save]')?.addEventListener('click', async btnEvent => {
      const btn = btnEvent.currentTarget;
      const i = Number(btn.dataset.save);
      const n = Number(host.querySelector('#fr-score').value);
      const reason = host.querySelector('#fr-reason').value.trim();

      if (!Number.isFinite(n) || n < 0 || n > 100) return toast('Enter a score between 0 and 100.', 'error');
      if (!reason) return toast('Add an explanation for the change.', 'error');

      const updated = findings.map((f, idx) => idx === i
        ? { ...f, manual_score: n, severity: scoreToSeverity(n), reason }
        : f);
      const { overallScore, compliancePassed } = recomputeFromFindings(eff.dimensions, updated);

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveScoreOverride(score.id, {
          overall_score: overallScore,
          dimensions: eff.dimensions,
          compliance_passed: compliancePassed,
          findings: updated,
          notes: score.manual_notes || '',
        });
        toast('Finding updated.', 'ok');
        onSaved();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }
}

/* --- by dimension: per-dimension manual review -----------------------------
   Mirrors drawFindings() one card up — each dimension gets its own Manual
   review button instead of one shared form, for the same reason: a reviewer
   is usually correcting one thing they noticed, not re-grading the whole
   call. Saving recomputes the overall score and compliance verdict the same
   way a finding edit does — see recomputeFromFindings().
   -------------------------------------------------------------------------- */
async function drawDimensions(score, ctx, turns, onSaved) {
  const host = document.getElementById('dimensions-area');
  if (!host) return;
  const isAdmin = ctx.profile.role === 'admin';

  const eff = effectiveOf(score);
  const dims = entriesOf(eff.dimensions);

  let editingKey = null;
  render();

  function render() {
    host.innerHTML = `
      <div class="card">
        <div class="card__head"><h2>By dimension</h2><span class="muted">Scored 0–100</span></div>
        <div class="bars">
          ${dims.map(([key, v]) => {
            const n = Number(v.score) || 0;
            const modelN = Number(score.dimensions?.[key]?.score) || 0;
            return barRow({
              rank: null,
              label: dimLabel(key, v),
              sub: score.is_overridden && n !== modelN ? `Model said ${modelN}` : null,
              value: n,
              display: String(n),
              max: SCORE_MAX,
              color: scoreTone(n),
            });
          }).join('')}
        </div>
        <div style="margin-top:16px;display:flex;flex-direction:column;gap:14px">
          ${dims.map(([key, v]) => key === editingKey ? editRowHtml(key, v) : viewRowHtml(key, v)).join('')}
        </div>
      </div>`;
    wire();
  }

  function viewRowHtml(key, v) {
    return `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
          <strong>${esc(dimLabel(key, v))} — ${esc(v.score ?? 0)}</strong>
          ${isAdmin ? `<button class="btn btn--ghost btn--sm" data-review="${esc(key)}" type="button">Manual review</button>` : ''}
        </div>
        <div class="muted" style="margin:4px 0">${esc(v.rationale || '')}</div>
        ${evidenceHtml(v.evidence, turns)}
        ${v.reason ? `<div class="muted" style="font-size:12px;margin-top:4px">Reviewer note: ${esc(v.reason)}</div>` : ''}
      </div>`;
  }

  function editRowHtml(key, v) {
    return `
      <div>
        <div><strong>${esc(dimLabel(key, v))}</strong> — currently ${esc(v.score ?? 0)}</div>
        <div class="muted" style="margin:4px 0;font-size:13px">${esc(v.rationale || '')}</div>
        <label class="field">
          <span>Corrected score *</span>
          <input type="number" min="0" max="100" required id="dr-score" value="${esc(v.score ?? 0)}">
        </label>
        <label class="field">
          <span>Explanation *</span>
          <textarea id="dr-reason" rows="2" required placeholder="Why this dimension was re-graded">${esc(v.reason || '')}</textarea>
        </label>
        <div style="display:flex;gap:10px">
          <button class="btn btn--primary" type="button" data-save="${esc(key)}">Save</button>
          <button class="btn btn--ghost" type="button" data-cancel>Cancel</button>
        </div>
      </div>`;
  }

  function wire() {
    host.querySelectorAll('[data-review]').forEach(btn => {
      btn.addEventListener('click', () => { editingKey = btn.dataset.review; render(); });
    });
    host.querySelector('[data-cancel]')?.addEventListener('click', () => { editingKey = null; render(); });

    host.querySelector('[data-save]')?.addEventListener('click', async btnEvent => {
      const btn = btnEvent.currentTarget;
      const key = btn.dataset.save;
      const n = Number(host.querySelector('#dr-score').value);
      const reason = host.querySelector('#dr-reason').value.trim();

      if (!Number.isFinite(n) || n < 0 || n > 100) return toast('Enter a score between 0 and 100.', 'error');
      if (!reason) return toast('Add an explanation for the change.', 'error');

      const updatedDims = { ...eff.dimensions, [key]: { ...eff.dimensions[key], score: n, reason } };
      const currentFindings = score.manual_findings ?? score.findings ?? [];
      const { overallScore, compliancePassed } = recomputeFromFindings(updatedDims, currentFindings);

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await db.saveScoreOverride(score.id, {
          overall_score: overallScore,
          dimensions: updatedDims,
          compliance_passed: compliancePassed,
          findings: currentFindings,
          notes: score.manual_notes || '',
        });
        toast('Dimension updated.', 'ok');
        onSaved();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }
}

// A pure status display now — current grade vs. the model's original, side
// by side, per Ryan 2026-09-17. There's nothing left to edit here: dimension
// scores have their own Manual review buttons above, findings have theirs
// below, and overall score / compliance are always derived from both via
// recomputeFromFindings(), never typed directly.
async function drawOverride(score, onSaved) {
  const host = document.getElementById('override-area');
  if (!host) return;

  const eff = effectiveOf(score);

  host.innerHTML = `
    <div class="card">
      <div class="card__head">
        <h2>Current grade</h2>
        ${score.is_overridden
          ? `<span class="chip chip--warning"><span aria-hidden="true">!</span>Overridden</span>`
          : `<span class="muted">As scored by the model</span>`}
      </div>
      <div class="grid-2">
        <div class="field">
          <span class="muted">Overall score</span>
          <strong style="font-size:22px">${eff.overall_score}</strong>
          ${score.is_overridden ? `<span class="muted" style="font-size:12px;display:block">Model originally scored ${score.overall_score}</span>` : ''}
        </div>
        <div class="field">
          <span class="muted">Compliance</span>
          <strong style="font-size:22px">${eff.compliance_passed ? 'Pass' : 'Fail'}</strong>
          ${score.is_overridden ? `<span class="muted" style="font-size:12px;display:block">Model originally said ${score.compliance_passed ? 'pass' : 'fail'}</span>` : ''}
        </div>
      </div>
      <p class="muted" style="margin:14px 0 0;font-size:13px">
        ${score.is_overridden
          ? "Both numbers recompute automatically from the dimension scores and compliance findings below — use their own Manual review buttons to change either one."
          : "Use the Manual review button on a dimension or a compliance finding below to correct it — the overall score and compliance verdict recompute automatically from there."}
      </p>
      ${score.is_overridden ? `<div style="margin-top:14px"><button class="btn btn--ghost" type="button" id="ov-clear">Revert everything to the model's original score</button></div>` : ''}
    </div>`;

  document.getElementById('ov-clear')?.addEventListener('click', async () => {
    if (!confirm('Revert to the model score? Every dimension and finding override is kept and can be re-applied later — this only flips which set counts.')) return;
    try {
      await db.clearScoreOverride(score.id);
      toast('Reverted to model score.', 'ok');
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// The model's own columns never change after scoring; is_overridden picks
// which set — model or manual — actually counts. Kept in one place so the
// summary tiles, dimension bars and findings table can't disagree about it.
function effectiveOf(score) {
  return {
    overall_score: score.is_overridden ? score.manual_overall_score : score.overall_score,
    dimensions: score.is_overridden ? (score.manual_dimensions ?? score.dimensions) : score.dimensions,
    compliance_passed: score.is_overridden ? score.manual_compliance_passed : score.compliance_passed,
    findings: (score.is_overridden ? (score.manual_findings ?? score.findings) : score.findings) ?? [],
  };
}

// Severity value -> its display label, for describing a finding's new
// severity in prose rather than rendering a chip.
const sevLabel = v => FINDING_SEVERITIES.find(s => s.value === v)?.label || v;

// The model's summary describes the call it originally graded — once a
// reviewer changes scores or findings, that text can read as flatly wrong
// (it might say "no compliance issues" after a Critical finding was added,
// or vice versa). Per Ryan 2026-09-18: a 4-5 sentence narrative of what the
// agent did and needs to work on, built from the reviewer's own words —
// every dimension/finding reason typed on a Manual review save, sorted into
// "did well" (the reviewer scored it better than the model did) and "needs
// work" (the reviewer scored it worse), plus manual_notes. This can never
// invent anything the reviewer didn't actually write; if a reason field was
// left thin, the paragraph comes out short rather than padded with filler.
function reviewerSummaryText(score) {
  if (!score.is_overridden) return '';
  const eff = effectiveOf(score);

  const dimReasons = entriesOf(eff.dimensions)
    .map(([key, v]) => {
      const before = Number(score.dimensions?.[key]?.score) || 0;
      const after = Number(v.score) || 0;
      if (after === before || !v.reason) return null;
      return { reason: v.reason, better: after > before };
    })
    .filter(Boolean);

  const modelFindingByCode = new Map((score.findings || []).map(f => [f.code, f]));
  const findingReasons = eff.findings
    .map(f => {
      const before = modelFindingByCode.get(f.code);
      if (!before || before.severity === f.severity || !f.reason) return null;
      const better = (SEVERITY_RANK[f.severity] ?? 0) < (SEVERITY_RANK[before.severity] ?? 0);
      return { reason: f.reason, better };
    })
    .filter(Boolean);

  const strengths = [...dimReasons, ...findingReasons].filter(c => c.better).map(c => c.reason);
  const improvements = [...dimReasons, ...findingReasons].filter(c => !c.better).map(c => c.reason);

  const band = eff.overall_score >= 80 ? 'good' : eff.overall_score >= 70 ? 'needs review' : 'critical';
  const sentences = [
    `After manual review, this call scored ${eff.overall_score}/100 (${band}) with compliance ${eff.compliance_passed ? 'passed' : 'failed'}.`,
  ];
  if (strengths.length) sentences.push(`What the agent did well: ${strengths.join('; ')}.`);
  if (improvements.length) sentences.push(`What the agent needs to work on: ${improvements.join('; ')}.`);
  if (score.manual_notes) sentences.push(score.manual_notes);
  if (!strengths.length && !improvements.length && !score.manual_notes) {
    sentences.push('The reviewer confirmed this grade with no specific notes recorded.');
  }
  sentences.push('Use this feedback to guide the agent’s coaching before their next call.');

  return sentences.join(' ');
}

/* --- finding score <-> severity ------------------------------------------
   A finding never had a number, only a severity — the rubric assigns one
   directly. A manual re-grade puts a number in (0 = most severe, 100 = no
   issue) and severity is derived from it, per Ryan 2026-09-17, so the two
   can never drift apart the way a separate severity dropdown could. A
   perfect 100 reads as "Good" (green), not "Low" — the model never assigns
   that tier itself, since it only reports findings that are issues; "Good"
   only exists as the outcome of a manual correction, per Ryan 2026-09-17.
   -------------------------------------------------------------------------- */
const scoreToSeverity = n =>
  n >= 100 ? 'good' : n <= 39 ? 'critical' : n <= 59 ? 'high' : n <= 79 ? 'medium' : 'low';

// Starting point when a finding has no manual score yet — the midpoint of
// its current severity's band, so the input opens already agreeing with
// what the AI decided rather than an arbitrary number.
const severityToScore = sev => ({ critical: 20, high: 50, medium: 70, low: 90, good: 100 }[sev] ?? 70);

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0, good: -1 };

// Per Ryan 2026-09-17: overall score starts from the dimension average, then
// gets capped by the worst surviving finding — a Critical finding can never
// let the call read better than "critical" overall, High never better than
// "serious", matching the tone bands used everywhere else in the app
// (scoreTone: <40 critical, 40-59 serious). Compliance passes only when
// nothing High or Critical survived — same rule the rubric itself uses.
function recomputeFromFindings(dimensions, findings) {
  const dims = entriesOf(dimensions).map(([, v]) => Number(v.score) || 0);
  const dimensionAvg = dims.length ? Math.round(dims.reduce((a, b) => a + b, 0) / dims.length) : 0;

  const worst = findings
    .filter(f => !f.dismissed)
    .reduce((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'low');

  const cap = worst === 'critical' ? 39 : worst === 'high' ? 59 : 100;
  return {
    overallScore: Math.min(dimensionAvg, cap),
    compliancePassed: worst !== 'critical' && worst !== 'high',
  };
}

// Wraps an evidence quote so a click scrolls the transcript to the matching
// line and seeks the audio there — but only when a match was actually found;
// an unmatched quote (paraphrased, or from a manually pasted transcript with
// no timing) stays plain text rather than promising a jump that goes nowhere.
function evidenceHtml(text, turns, { inline = false } = {}) {
  if (!text) return '';
  const idx = matchQuoteToTurn(text, turns);
  const jumpAttrs = idx !== -1 ? ` data-turn="${idx}" role="button" tabindex="0" title="Play from here"` : '';
  const jumpClass = idx !== -1 ? ' evidence--jump' : '';
  return inline
    ? `<br><span class="muted evidence${jumpClass}" style="font-size:12px"${jumpAttrs}>“${esc(text)}”</span>`
    : `<blockquote class="evidence${jumpClass}" style="margin:0;padding-left:12px;border-left:2px solid var(--grid);font-size:13px"${jumpAttrs}>${esc(text)}</blockquote>`;
}

// KPIs + Summary. Split from scoreFooterHtml() so the interactive By
// dimension and Compliance findings sections can render between them in the
// page's actual visual order, instead of being appended after everything.
function scoreHeaderHtml(score) {
  const eff = effectiveOf(score);
  const visibleFindings = eff.findings.filter(f => !f.dismissed);

  return `
    ${score.is_overridden ? `
      <div class="card" style="border-color:var(--warning)">
        <div class="card__head">
          <h2>Summary of Call</h2>
          <span class="chip chip--warning"><span aria-hidden="true">!</span>Overridden</span>
        </div>
        <p class="muted" style="margin:0">
          By ${esc(score.overridden_by_profile?.full_name || 'an admin')}
          ${score.overridden_at ? `· ${esc(fmtDate(score.overridden_at))}` : ''}
          ${score.manual_summary ? '· AI-summarized from the review' : '· not yet AI-summarized — click Generate report or Approve'}
        </p>
        <p style="margin:10px 0 0">${esc(score.manual_summary || reviewerSummaryText(score))}</p>
      </div>` : ''}

    <div class="kpis">
      ${statTile({
        label: 'Overall score',
        value: String(eff.overall_score),
        note: score.is_overridden
          ? `Model scored ${score.overall_score}`
          : (score.coaching_focus ? `Focus: ${esc(score.coaching_focus)}` : ''),
        meter: { pct: eff.overall_score, aria: `${eff.overall_score} out of 100` },
      })}
      ${statTile({
        label: 'Compliance',
        value: eff.compliance_passed ? 'Pass' : 'Fail',
        note: score.is_overridden
          ? `Model said ${score.compliance_passed ? 'pass' : 'fail'}`
          : (visibleFindings.length
            ? `${fmtNum(visibleFindings.length)} finding${visibleFindings.length === 1 ? '' : 's'}`
            : 'No findings'),
      })}
      ${statTile({
        label: 'Cost to score',
        // Includes the AI summary's cost once summarize-review has run —
        // that's a real Anthropic charge tied to this call, so it belongs
        // in the figure shown here. Deliberately NOT folded into cost_usd
        // itself or into spend_summary()/my_metrics(): those aggregate by
        // the day a call was SCORED, and a summary generated days later
        // would misattribute its cost to the wrong day there.
        value: fmtMoneyExact(Number(score.cost_usd || 0) + Number(score.manual_summary_cost_usd || 0)),
        note: score.manual_summary_cost_usd
          ? `${fmtNum(score.input_tokens)} in · ${fmtNum(score.output_tokens)} out · ${fmtNum(score.cache_read_tokens)} cached + ${fmtMoneyExact(score.manual_summary_cost_usd)} AI summary`
          : `${fmtNum(score.input_tokens)} in · ${fmtNum(score.output_tokens)} out · ${fmtNum(score.cache_read_tokens)} cached`,
      })}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>${score.is_overridden ? "Model's original summary" : 'Summary'}</h2>
        <span class="muted">${esc(score.model)} · rubric ${esc(score.rubric_version)}${score.script?.name ? ` · script: ${esc(score.script.name)}` : ''}</span>
      </div>
      <p style="margin:0">${esc(score.summary)}</p>
    </div>`;
}

function scoreFooterHtml(score) {
  // Once a reviewer's override has been AI-summarized (Generate report or
  // Approve — see summarize-review), that reflects the reviewer's actual
  // grading and replaces the model's own first-pass lists. Before that's
  // run, the model's lists are still shown rather than nothing.
  const usingReviewerVersion = score.is_overridden && Array.isArray(score.manual_strengths);
  const strengths = usingReviewerVersion ? score.manual_strengths : (Array.isArray(score.strengths) ? score.strengths : []);
  const improvements = usingReviewerVersion ? score.manual_improvements : (Array.isArray(score.improvements) ? score.improvements : []);

  return `
    <div class="card">
      <div class="card__head">
        <span class="muted" style="font-size:12px">${usingReviewerVersion ? 'Based on the reviewer’s grading' : "Model's first pass"}</span>
      </div>
      <div class="grid-2">
        <div>
          <h3 style="margin-bottom:8px">What went well</h3>
          ${strengths.length === 0 ? `<p class="muted">—</p>` :
            `<ul style="margin:0;padding-left:18px">${strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`}
        </div>
        <div>
          <h3 style="margin-bottom:8px">What to work on</h3>
          ${improvements.length === 0 ? `<p class="muted">—</p>` :
            `<ul style="margin:0;padding-left:18px">${improvements.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`}
        </div>
      </div>
    </div>

    <p class="muted" style="font-size:12px;margin:0 0 18px">
      Scores are model-generated and meant for coaching, not for discipline or
      compliance sign-off. Read the evidence quotes before acting on a finding.
    </p>`;
}

/* --- coaching report -------------------------------------------------------
   A pdfmake document definition — real vector PDF content (tables, text,
   colors), not HTML rasterized into an image and not a browser print. Two
   things that follows from that: nothing to clip on the right edge (pdfmake
   lays out and wraps text itself, the way the old html2canvas screenshot
   never reliably did), and pdfMake.createPdf(...).download() saves the file
   directly with no print dialog — the point of switching to this, so a
   report can go straight from "Generate report" to an email attachment.
   Only offered once a call has an actual manual grade on it
   (score.is_overridden): the point is to hand an agent the reviewer's
   corrected read of the call, not the model's unreviewed first pass.
   -------------------------------------------------------------------------- */
function coachingReportDocDefinition(rec, score) {
  const eff = effectiveOf(score);
  const agentName = rec.agent?.full_name || rec.agent_name || 'Unknown agent';
  const dims = entriesOf(eff.dimensions);
  const findings = eff.findings.filter(f => !f.dismissed);
  const usingReviewerVersion = score.is_overridden && Array.isArray(score.manual_strengths);
  const strengths = usingReviewerVersion ? score.manual_strengths : (Array.isArray(score.strengths) ? score.strengths : []);
  const improvements = usingReviewerVersion ? score.manual_improvements : (Array.isArray(score.improvements) ? score.improvements : []);
  const toneColor = tone => ({
    good: '#1b8a5a', warning: '#b8860b', serious: '#d2691e', critical: '#c0392b',
  }[tone] || '#666666');
  const sevMeta = sev => FINDING_SEVERITIES.find(s => s.value === sev) || { label: sev, tone: 'warning' };
  // Same 0-69/70-79/80+ bands as the leaderboard's red/yellow/green legend.
  const bandColor = n => (n >= 80 ? '#146c46' : n >= 70 ? '#8a6508' : '#96281d');
  const bandBg = n => (n >= 80 ? '#e8f7ee' : n >= 70 ? '#fff6e0' : '#fdeceb');

  const infoLine = [
    agentName,
    fmtDate(rec.call_on),
    rec.title || null,
    rec.call_type ? (CALL_TYPES.find(t => t.value === rec.call_type)?.label || rec.call_type) : null,
    rec.team?.name ? `Agency Assigned: ${rec.team.name}` : null,
    rec.script?.name ? `Script: ${rec.script.name}` : null,
  ].filter(Boolean).join('  ·  ');

  const reviewedLine = `Reviewed by ${score.overridden_by_profile?.full_name || 'an admin'}` +
    (score.overridden_at ? `  ·  ${fmtDate(score.overridden_at)}` : '');

  // Each KPI is its own single-cell borderless table so it can carry a
  // background fill — pdfmake has no free-floating "card", a table cell is
  // the only content node that takes a fillColor.
  const kpiBox = (label, value, sub, color, bg) => ({
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: label, fontSize: 9, color: '#555555' },
          { text: String(value), fontSize: 22, bold: true, color, margin: [0, 3, 0, 3] },
          { text: sub, fontSize: 8, color: '#666666' },
        ],
        fillColor: bg,
        margin: [10, 8, 10, 8],
      }]],
    },
    layout: 'noBorders',
  });

  const notesStack = (rationale, evidence, reason) => {
    const stack = [{ text: rationale || '', fontSize: 8 }];
    if (evidence) stack.push({ text: `"${evidence}"`, fontSize: 8, italics: true, color: '#444444', margin: [8, 3, 0, 0] });
    if (reason) stack.push({ text: `Reviewer note: ${reason}`, fontSize: 8, color: '#666666', margin: [0, 3, 0, 0] });
    return stack;
  };

  const tableHeader = text => ({ text, bold: true, fontSize: 8, color: '#666666' });

  const dimensionRows = dims.map(([key, v]) => {
    const modelScore = Number(score.dimensions?.[key]?.score) || 0;
    const n = Number(v.score) || 0;
    return [
      { text: dimLabel(key, v), fontSize: 9, bold: true },
      { text: n !== modelScore ? `${n} (model said ${modelScore})` : String(n), fontSize: 9 },
      { stack: notesStack(v.rationale, v.evidence, v.reason) },
    ];
  });

  const findingRows = findings.map(f => {
    const sev = sevMeta(f.severity);
    return [
      { text: FINDING_CODES[f.code] || f.code, fontSize: 9 },
      { text: sev.label, fontSize: 9, bold: true, color: toneColor(sev.tone) },
      { stack: notesStack(f.detail, f.evidence, f.reason) },
    ];
  });

  const content = [
    { text: [{ text: 'L', color: '#7C2FD6' }, { text: 'ANA', color: '#1E1029' }], bold: true, fontSize: 20 },
    { text: 'AI SALES COACHING & SCORING', fontSize: 8, bold: true, color: '#8B7FA0', characterSpacing: 1, margin: [0, 2, 0, 16] },

    { text: 'Coaching report', fontSize: 18, bold: true, margin: [0, 0, 0, 4] },
    { text: infoLine, fontSize: 9, color: '#666666', margin: [0, 0, 0, 2] },
    { text: reviewedLine, fontSize: 9, color: '#666666', margin: [0, 0, 0, 14] },

    {
      columns: [
        kpiBox('Overall score', eff.overall_score, `Model originally scored ${score.overall_score}`,
          bandColor(eff.overall_score), bandBg(eff.overall_score)),
        { width: 14, text: '' },
        kpiBox('Compliance', eff.compliance_passed ? 'Pass' : 'Fail',
          `Model originally said ${score.compliance_passed ? 'pass' : 'fail'}`,
          eff.compliance_passed ? '#146c46' : '#96281d', eff.compliance_passed ? '#e8f7ee' : '#fdeceb'),
      ],
      margin: [0, 0, 0, 18],
    },
  ];

  if (score.is_overridden) {
    content.push({ text: 'Summary of Call', fontSize: 13, bold: true, margin: [0, 8, 0, 4] });
    content.push({ text: score.manual_summary || reviewerSummaryText(score), fontSize: 9, margin: [0, 0, 0, 6] });
  } else if (score.summary) {
    content.push({ text: 'Call summary', fontSize: 13, bold: true, margin: [0, 8, 0, 4] });
    content.push({ text: score.summary, fontSize: 9, margin: [0, 0, 0, 6] });
  }

  content.push({ text: 'By dimension', fontSize: 13, bold: true, margin: [0, 10, 0, 6] });
  content.push({
    table: {
      widths: ['22%', '16%', '*'],
      headerRows: 1,
      body: [
        [tableHeader('Dimension'), tableHeader('Score'), tableHeader('Notes')],
        ...dimensionRows,
      ],
    },
    layout: 'lightHorizontalLines',
  });

  content.push({ text: 'Compliance findings', fontSize: 13, bold: true, margin: [0, 14, 0, 6] });
  if (findings.length === 0) {
    content.push({ text: 'No compliance issues found.', fontSize: 9, color: '#666666' });
  } else {
    content.push({
      table: {
        widths: ['22%', '16%', '*'],
        headerRows: 1,
        body: [
          [tableHeader('Issue'), tableHeader('Severity'), tableHeader('Detail')],
          ...findingRows,
        ],
      },
      layout: 'lightHorizontalLines',
    });
  }

  content.push({ text: 'Coaching focus', fontSize: 13, bold: true, margin: [0, 14, 0, 6] });
  content.push({
    columns: [
      {
        width: '*',
        stack: [
          { text: 'What went well', bold: true, fontSize: 9, margin: [0, 0, 0, 4] },
          strengths.length === 0
            ? { text: '—', fontSize: 9, color: '#666666' }
            : { ul: strengths.map(s => ({ text: s, fontSize: 9 })) },
        ],
      },
      { width: 18, text: '' },
      {
        width: '*',
        stack: [
          { text: 'What to work on', bold: true, fontSize: 9, margin: [0, 0, 0, 4] },
          improvements.length === 0
            ? { text: '—', fontSize: 9, color: '#666666' }
            : { ul: improvements.map(s => ({ text: s, fontSize: 9 })) },
        ],
      },
    ],
  });

  content.push({
    text: `Generated ${fmtDate(new Date().toISOString())}  ·  For coaching use, not a disciplinary or compliance record.`,
    fontSize: 8,
    color: '#666666',
    margin: [0, 24, 0, 0],
  });

  return {
    info: { title: `Coaching report - ${agentName} - ${fmtDate(rec.call_on)}` },
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { fontSize: 9 },
    content,
  };
}

/* === Calibration ==========================================================
   Model vs human, per dimension. Delta is a signed quantity around zero, so it
   is drawn as a diverging bar from a centre line rather than a length from the
   left edge — a plain bar chart would make "-8" and "+8" look like the same
   magnitude of the same thing, when they mean opposite problems.
   ========================================================================== */
export async function calibration(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Calibration</h1>
      <div class="page__sub">Where the model and your reviewers disagree — and what to change</div>
    </div></div>
    <div class="filters">
      ${selectField('cal-range', 'Period', RANGES, 'quarter')}
      ${selectField('cal-call-type', 'Call type', [{ value: '', label: 'All types' }, ...CALL_TYPES], '')}
    </div>
    <div id="body">${spinner()}</div>`;

  const body = document.getElementById('body');
  const rangeSel = document.getElementById('cal-range');
  const callTypeSel = document.getElementById('cal-call-type');

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const callType = callTypeSel.value || undefined;
    const [summary, dims] = await Promise.all([
      db.calibrationSummary(start, end, callType),
      db.calibrationByDimension(start, end, callType),
    ]);

    if (!Number(summary.reviews)) {
      body.innerHTML = `<div class="card">${empty(
        'No manually reviewed calls in this period yet. Use Manual review on a scored call\'s dimensions, findings, or overall score — this page needs at least a few to say anything useful.'
      )}</div>`;
      return;
    }

    const n = Number(summary.reviews);
    const agree10 = Math.round((Number(summary.within_10) / n) * 100);
    const maxAbs = Math.max(5, ...dims.map(d => Math.abs(Number(d.delta) || 0)));

    body.innerHTML = `
      <div class="kpis">
        ${statTile({ label: 'Graded calls', value: fmtNum(n), note: `${esc(fmtDate(start))} – ${esc(fmtDate(end))}` })}
        ${statTile({
          label: 'Overall gap',
          value: `${Number(summary.delta) > 0 ? '+' : ''}${summary.delta ?? '—'}`,
          note: Number(summary.delta) > 0 ? 'Model scores higher than people' : 'People score higher than the model',
        })}
        ${statTile({
          label: 'Within 10 points',
          value: `${agree10}%`,
          note: `${fmtNum(summary.within_5)} of ${fmtNum(n)} within 5`,
          meter: { pct: agree10, aria: `${agree10}% agree within 10 points` },
        })}
        ${statTile({
          label: 'Compliance disputed',
          value: fmtNum(summary.compliance_disputed),
          note: Number(summary.compliance_disputed) ? 'Read these first' : 'No disagreements',
        })}
      </div>

      <div class="card">
        <div class="card__head">
          <h2>Gap by dimension</h2>
          <span class="muted">Model minus human · ${dims.length} dimensions</span>
        </div>
        ${dims.length === 0 ? empty('No per-dimension grades yet.') : `
          <div class="diverge">
            ${dims.map(d => {
              const delta = Number(d.delta) || 0;
              const pct = Math.min(50, (Math.abs(delta) / maxAbs) * 50);
              const warm = delta > 0;
              return `
                <div class="dv">
                  <div class="dv__label">${esc(dimLabel(d.dimension_key, {}))}
                    <span class="bar__sub">${fmtNum(d.reviews)} graded · model ${d.model_avg} vs you ${d.human_avg}</span>
                  </div>
                  <div class="dv__track">
                    <div class="dv__mid"></div>
                    <div class="dv__fill" style="
                      ${warm ? 'left:50%' : `left:${50 - pct}%`};
                      width:${pct}%;
                      background:var(${warm ? '--diverge-warm' : '--diverge-cool'})"></div>
                  </div>
                  <div class="dv__val" style="color:var(${warm ? '--diverge-warm' : '--diverge-cool'})">
                    ${delta > 0 ? '+' : ''}${delta}
                  </div>
                </div>`;
            }).join('')}
          </div>
          <div class="legend" style="margin-top:14px">
            <span class="legend__item"><span class="legend__swatch" style="background:var(--diverge-warm)"></span>Model scores higher — criteria may be too loose</span>
            <span class="legend__item"><span class="legend__swatch" style="background:var(--diverge-cool)"></span>People score higher — criteria may be too harsh</span>
          </div>
          <details style="margin-top:16px">
            <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
            <div class="tablewrap" style="margin-top:10px"><table>
              <thead><tr><th>Dimension</th><th class="num">Graded</th><th class="num">Model avg</th>
                <th class="num">Human avg</th><th class="num">Delta</th><th class="num">Mean gap</th></tr></thead>
              <tbody>${dims.map(d => `
                <tr>
                  <td>${esc(dimLabel(d.dimension_key, {}))}</td>
                  <td class="num">${esc(fmtNum(d.reviews))}</td>
                  <td class="num">${esc(d.model_avg)}</td>
                  <td class="num">${esc(d.human_avg)}</td>
                  <td class="num">${Number(d.delta) > 0 ? '+' : ''}${esc(d.delta)}</td>
                  <td class="num">${esc(d.mean_abs_gap)}</td>
                </tr>`).join('')}
              </tbody>
            </table></div>
          </details>`}
      </div>

      <div class="card">
        <div class="card__head"><h2>How to read this</h2></div>
        <p class="muted" style="margin:0 0 10px">
          <strong>Delta</strong> is the average signed gap — model minus human. A
          <strong>+8</strong> on Discovery means the model is eight points more generous
          than your reviewers, which usually means that dimension's criteria are too easy
          to satisfy. Tighten the wording on the Rubric page and the gap should close.
        </p>
        <p class="muted" style="margin:0 0 10px">
          <strong>Mean gap</strong> is the average distance ignoring direction. A small delta
          with a large mean gap is the tricky case: the model is not biased, it is
          <em>inconsistent</em> — it scores some calls high and others low and they cancel out.
          Tightening criteria will not fix that; adding concrete criteria usually will.
        </p>
        <p class="muted" style="margin:0">
          Before trusting any of this, check your reviewers agree with <em>each other</em>.
          Two managers 20 points apart on the same call means there is no agreed standard yet,
          and no rubric wording will make the model's number feel right.
        </p>
      </div>`;
  }

  rangeSel.addEventListener('change', draw);
  callTypeSel.addEventListener('change', draw);
  await draw();
}

/* === Agent leaderboard (by call score) ====================================
   Ranks every scored agent by average call score, highest first — the same
   number the Scorecard shows, just framed for a quick team-accountability
   view instead of a spend/compliance rollup. Tabs filter by team; "All
   agents" is the scoring_leaderboard RPC's own order, since it already ranks
   across every team combined.
   -------------------------------------------------------------------------- */
const scoreLevel = score => {
  const n = Number(score) || 0;
  return n >= 80 ? 'good' : n >= 70 ? 'warning' : 'critical';
};

const scoreLevelChip = level => {
  const meta = {
    good:     { label: 'Good',         icon: '✓' },
    warning:  { label: 'Needs review', icon: '!' },
    critical: { label: 'Critical',     icon: '✕' },
  }[level];
  return `<span class="chip chip--${level}"><span aria-hidden="true">${meta.icon}</span>${meta.label}</span>`;
};

// Two leaderboards, one layout. The first ranks every scored call on the
// rubric's 0-100 coaching score; the Medicare one ranks only calls graded
// against the pass/fail scorecard, on scorecard percentage. They are kept as
// separate pages rather than blended because the two numbers measure
// different things and are not comparable.
const LEADERBOARDS = {
  rubric: {
    title: 'Leaderboard',
    sub: 'Average call score, ranked highest to lowest',
    fetch: (start, end) => db.scoringLeaderboard(start, end),
    countLabel: 'Calls scored',
    scoreLabel: 'Avg score',
    emptyText: 'No scored calls in this period.',
  },
  medicare: {
    title: 'Medicare leaderboard',
    sub: 'Average Medicare scorecard percentage, ranked highest to lowest',
    fetch: (start, end) => db.scorecardLeaderboard(start, end),
    countLabel: 'Calls graded',
    scoreLabel: 'Avg scorecard %',
    emptyText: 'No calls graded against the Medicare scorecard in this period.',
  },
};

export const agentLeaderboard = main => drawLeaderboard(main, LEADERBOARDS.rubric);
export const medicareLeaderboard = main => drawLeaderboard(main, LEADERBOARDS.medicare);

async function drawLeaderboard(main, board) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>${esc(board.title)}</h1>
      <div class="page__sub">${esc(board.sub)}</div>
    </div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card__head"><h2>What the colors mean</h2></div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div>${scoreLevelChip('critical')} <span class="muted">0–69% average — needs immediate coaching and a performance review.</span></div>
        <div>${scoreLevelChip('warning')} <span class="muted">70–79% average — needs agent review.</span></div>
        <div>${scoreLevelChip('good')} <span class="muted">80% or higher — good to go, no coaching needed.</span></div>
      </div>
    </div>
    <div class="filters">${selectField('alb-range', 'Period', RANGES, 'year')}</div>
    <div id="alb-tabs" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"></div>
    <div class="card" id="alb-body">${spinner()}</div>`;

  const rangeSel = document.getElementById('alb-range');
  const tabsHost = document.getElementById('alb-tabs');
  const body = document.getElementById('alb-body');

  const teams = await db.listTeams();
  let activeTab = 'all';

  function renderTabs() {
    const tabs = [{ key: 'all', label: 'All agents' }, ...teams.map(t => ({ key: t.name, label: t.name }))];
    tabsHost.innerHTML = tabs.map(t =>
      `<button type="button" class="btn ${t.key === activeTab ? 'btn--primary' : 'btn--ghost'}" data-tab="${esc(t.key)}">${esc(t.label)}</button>`
    ).join('');
    tabsHost.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        draw();
      });
    });
  }

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    let rows;
    try {
      rows = await board.fetch(start, end);
    } catch (err) {
      body.innerHTML = empty(`Could not load this leaderboard: ${err.message}`);
      return;
    }
    const filtered = activeTab === 'all' ? rows : rows.filter(r => r.team_name === activeTab);

    if (filtered.length === 0) {
      body.innerHTML = empty(board.emptyText);
      return;
    }

    // Re-rank within the filtered set — a team tab should read 1..N for that
    // team, not carry the gaps left by agents on other teams.
    const ranked = filtered
      .slice()
      .sort((a, b) => Number(b.avg_score) - Number(a.avg_score))
      .map((r, i) => ({ ...r, displayRank: i + 1 }));

    body.innerHTML = `
      <div class="card__head">
        <h2>${fmtNum(ranked.length)} agent${ranked.length === 1 ? '' : 's'}</h2>
        <span class="muted">${esc(fmtDate(start))} – ${esc(fmtDate(end))}</span>
      </div>
      <div class="tablewrap"><table>
        <thead><tr>
          <th>Rank</th><th>Agent</th><th>Team</th>
          <th class="num">${esc(board.countLabel)}</th><th class="num">${esc(board.scoreLabel)}</th><th></th>
        </tr></thead>
        <tbody>${ranked.map(r => {
          const level = scoreLevel(r.avg_score);
          return `
            <tr class="lb-row--${level}">
              <td class="tnum">${r.displayRank}</td>
              <td>${esc(r.full_name)}</td>
              <td class="muted">${esc(r.team_name)}</td>
              <td class="num">${esc(fmtNum(r.calls_scored))}</td>
              <td class="num tnum"><strong>${esc(r.avg_score ?? 0)}</strong></td>
              <td>${scoreLevelChip(level)}</td>
            </tr>`;
        }).join('')}
        </tbody>
      </table></div>`;
  }

  rangeSel.addEventListener('change', draw);
  renderTabs();
  await draw();
}

// Fixed day/week/month grading spend — always "right now," independent of
// the Period dropdown below it, which looks at a chosen range instead. Team
// rows come from whatever spend_summary() actually returned, so a new team
// shows up here with no code change.
function spendSectionHtmlFor(rows) {
  const find = (scope, period) => rows.find(r => r.scope === scope && r.period === period)
    ?? { total_cost: 0, calls_scored: 0 };
  const day = find('All', 'day');
  const week = find('All', 'week');
  const month = find('All', 'month');
  const teams = [...new Set(rows.filter(r => r.scope !== 'All').map(r => r.scope))];

  const callsNote = n => `${fmtNum(n)} call${Number(n) === 1 ? '' : 's'}`;

  return `
    <div class="card">
      <div class="card__head">
        <h2>Spend</h2>
        <span class="muted">Grading cost only — transcription cost isn't tracked per call</span>
      </div>
      <div class="kpis">
        ${statTile({ label: 'Daily spend', value: fmtMoneyExact(day.total_cost), note: `${callsNote(day.calls_scored)} today` })}
        ${statTile({ label: 'Weekly spend', value: fmtMoneyExact(week.total_cost), note: 'Monday–Sunday, this week' })}
        ${statTile({ label: 'Monthly spend', value: fmtMoneyExact(month.total_cost), note: 'This month' })}
      </div>
      ${teams.map(name => {
        const w = find(name, 'week');
        const m = find(name, 'month');
        return `
          <div class="card__head" style="margin-top:18px"><h3 style="margin:0">${esc(name)}</h3></div>
          <div class="kpis">
            ${statTile({ label: 'This week', value: fmtMoneyExact(w.total_cost), note: callsNote(w.calls_scored) })}
            ${statTile({ label: 'This month', value: fmtMoneyExact(m.total_cost), note: callsNote(m.calls_scored) })}
          </div>`;
      }).join('')}
    </div>`;
}

/* === Admin scorecard ====================================================== */
export async function scorecard(main) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Scorecard</h1>
      <div class="page__sub">Average call scores, compliance, and what scoring costs</div>
    </div></div>
    <div class="filters">${selectField('sc-range', 'Period', RANGES, 'month')}</div>
    <div id="body">${spinner()}</div>`;

  const body = document.getElementById('body');
  const rangeSel = document.getElementById('sc-range');

  async function draw() {
    body.innerHTML = spinner();
    const { start, end } = range(rangeSel.value);
    const [board, spend, spendFixed] = await Promise.all([
      db.scoringLeaderboard(start, end),
      db.scoringSpend(start, end),
      db.spendSummary(),
    ]);

    const spendSectionHtml = spendSectionHtmlFor(spendFixed);

    if (board.length === 0) {
      body.innerHTML = spendSectionHtml + `<div class="card">${empty('No calls scored in this period.')}</div>`;
      return;
    }

    body.innerHTML = spendSectionHtml + `
      <div class="kpis">
        ${statTile({ label: 'Calls scored', value: fmtNum(spend.calls_scored), note: `${esc(fmtDate(start))} – ${esc(fmtDate(end))}` })}
        ${statTile({ label: 'Scoring spend', value: fmtMoneyExact(spend.total_cost_usd), note: `${fmtMoneyExact(spend.avg_cost_usd)} per call` })}
        ${statTile({
          label: 'Compliance pass rate',
          value: spend.calls_scored > 0
            ? `${Math.round((board.reduce((s, r) => s + Number(r.compliance_ok), 0) / Number(spend.calls_scored)) * 100)}%`
            : '—',
          note: `${fmtNum(board.reduce((s, r) => s + Number(r.open_findings), 0))} findings total`,
        })}
        ${statTile({
          label: 'Cache savings',
          value: fmtNum(spend.cache_read_tokens),
          note: 'Rubric tokens served from cache',
        })}
      </div>

      <div class="card">
        <div class="card__head"><h2>Average score by agent</h2><span class="muted">Scored 0–100</span></div>
        <div class="bars">
          ${board.map(r => barRow({
            rank: r.rank,
            label: r.full_name,
            sub: `${r.team_name} · ${fmtNum(r.calls_scored)} calls · ${fmtNum(r.open_findings)} findings`,
            value: r.avg_score,
            display: String(r.avg_score ?? 0),
            max: SCORE_MAX,
            color: scoreTone(Number(r.avg_score) || 0),
          })).join('')}
        </div>
        <details style="margin-top:16px">
          <summary class="muted" style="cursor:pointer;font-size:12px">Table view</summary>
          <div class="tablewrap" style="margin-top:10px"><table>
            <thead><tr>
              <th>Agent</th><th>Team</th><th class="num">Calls</th>
              <th class="num">Avg score</th><th class="num">Compliance OK</th><th class="num">Findings</th>
            </tr></thead>
            <tbody>${board.map(r => `
              <tr>
                <td>${esc(r.full_name)}</td>
                <td class="muted">${esc(r.team_name)}</td>
                <td class="num">${esc(fmtNum(r.calls_scored))}</td>
                <td class="num">${esc(r.avg_score ?? 0)}</td>
                <td class="num">${esc(fmtNum(r.compliance_ok))}</td>
                <td class="num">${esc(fmtNum(r.open_findings))}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </details>
      </div>`;
  }

  rangeSel.addEventListener('change', draw);
  await draw();
}
