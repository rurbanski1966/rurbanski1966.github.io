// ---------------------------------------------------------------------------
// Every read and write goes through here, so RLS behaviour is handled in one
// place rather than at each call site.
//
// The trap this module exists to close: under row level security a blocked
// read is not an error. Postgres filters the rows out and returns an empty
// array with a 200. A dashboard that trusts that renders a confident zero —
// the leaderboard looks empty, month AP reads $0, and nothing anywhere says
// "you are not allowed to see this." So every query below runs behind
// requireSession(), which throws when the session is gone instead of letting
// an unauthenticated empty array reach the UI.
// ---------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=82';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export class NotSignedIn extends Error {
  constructor() {
    super('Your session expired. Sign in again.');
    this.name = 'NotSignedIn';
  }
}

async function requireSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new NotSignedIn();
  return data.session;
}

/* --- demo (test) logins ---------------------------------------------------
   A demo login sees every tab with nothing in it (migration 049). The
   database is the real lock: it refuses a demo login every request except
   reading its own profile. This side just answers every read with an empty
   result up front, so pages render empty instead of showing errors, and
   every save, upload, scoring run or payment says changes are turned off.
   -------------------------------------------------------------------------- */
const DEMO_MSG = 'Demo login: changes are turned off.';
const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);
let demoMode = false;
export const isDemo = () => demoMode;

// Stands in for a PostgREST query: any chain of builder calls, awaited,
// gives an empty read (or a refusal, if the chain included a write).
function demoQuery() {
  let write = false;
  let single = false;
  const q = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const res = write
          ? { data: null, error: { message: DEMO_MSG } }
          : { data: single ? null : [], error: null, count: 0 };
        return (ok, bad) => Promise.resolve(res).then(ok, bad);
      }
      return () => {
        if (WRITES.has(prop)) write = true;
        if (prop === 'single' || prop === 'maybeSingle') single = true;
        return q;
      };
    },
  });
  return q;
}

function enableDemo() {
  if (demoMode) return;
  demoMode = true;
  const realFrom = supabase.from.bind(supabase);
  const refuse = async () => ({ data: null, error: { message: DEMO_MSG } });
  // Own profile stays real: signing in and the Agents page read it, and the
  // database allows exactly that.
  Object.defineProperty(supabase, 'from', {
    value: table => (table === 'profiles' ? realFrom(table) : demoQuery()),
  });
  Object.defineProperty(supabase, 'rpc', { value: () => demoQuery() });
  Object.defineProperty(supabase, 'functions', {
    value: { invoke: async () => ({ data: null, error: new Error(DEMO_MSG) }) },
  });
  Object.defineProperty(supabase, 'storage', {
    value: { from: () => new Proxy({}, { get: () => refuse }) },
  });
}

// Unwraps a PostgREST response, turning `{ error }` into a thrown Error.
function unwrap({ data, error }) {
  if (error) throw new Error(error.message || 'Request failed');
  return data;
}

/* --- auth ---------------------------------------------------------------- */
export const auth = {
  signIn: (email, password) =>
    supabase.auth.signInWithPassword({ email, password }).then(unwrap),

  signUp: (email, password, fullName) =>
    supabase.auth
      .signUp({ email, password, options: { data: { full_name: fullName } } })
      .then(unwrap),

  signOut: () => supabase.auth.signOut(),

  updatePassword: password =>
    supabase.auth.updateUser({ password }).then(unwrap),

  // redirectTo must be on Supabase's allow-list: Authentication → URL
  // Configuration → Redirect URLs. Using the current origin means this works
  // from both the deployed site and a local dev server without editing code.
  requestPasswordReset: email =>
    supabase.auth
      .resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })
      .then(unwrap),

  session: () => supabase.auth.getSession().then(r => r.data.session),

  onChange: cb => supabase.auth.onAuthStateChange((_e, session) => cb(session)),
};

/* --- profile ------------------------------------------------------------- */
export async function myProfile() {
  const session = await requireSession();

  const row = unwrap(
    await supabase
      .from('profiles')
      .select('id, email, full_name, role, team_id, active, is_demo, teams(name)')
      .eq('id', session.user.id)
      .maybeSingle()
  );

  // The signup trigger creates this row. A null here means the trigger did not
  // fire — usually schema.sql was never run — which is worth saying plainly
  // rather than rendering an app with no identity.
  if (!row) {
    throw new Error(
      'No profile row for your account. Run supabase/schema.sql, then sign out and back in.'
    );
  }
  if (!row.active) throw new Error('This account has been deactivated. Contact an admin.');
  if (row.is_demo) enableDemo();

  return row;
}

export async function updateMyName(fullName) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', session.user.id)
      .select()
      .single()
  );
}

/* --- reference data ------------------------------------------------------ */
export async function listProducts() {
  await requireSession();
  return unwrap(
    await supabase
      .from('products')
      .select('id, name, carrier, category, active')
      .eq('active', true)
      .order('category')
      .order('carrier')
  );
}

export async function listTeams() {
  await requireSession();
  return unwrap(await supabase.from('teams').select('id, name').order('name'));
}

export async function createTeam(name) {
  await requireSession();
  return unwrap(await supabase.from('teams').insert({ name }).select().single());
}

/* --- scripts --------------------------------------------------------------
   The talk-track an agent is supposed to follow, separate from the rubric
   (which is how every call gets graded regardless of which script it was).
   Readable by anyone signed in — anyone uploading a call needs the list for
   the picker — but only admins can create, edit, or delete one (RLS).
   -------------------------------------------------------------------------- */
export async function listScripts({ activeOnly = false } = {}) {
  await requireSession();
  let q = supabase.from('scripts').select('id, name, active, created_at').order('name');
  if (activeOnly) q = q.eq('active', true);
  return unwrap(await q);
}

export async function getScript(id) {
  await requireSession();
  return unwrap(await supabase.from('scripts').select('*').eq('id', id).maybeSingle());
}

export async function createScript(name, content) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('scripts')
      .insert({ name, content, created_by: session.user.id })
      .select()
      .single()
  );
}

export async function updateScript(id, patch) {
  await requireSession();
  return unwrap(await supabase.from('scripts').update(patch).eq('id', id).select().single());
}

export async function deleteScript(id) {
  await requireSession();
  const { error } = await supabase.from('scripts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* --- submissions --------------------------------------------------------- */
const SUBMISSION_COLS =
  'id, agent_id, category, client_name, policy_number, carrier, ap_amount, ' +
  'status, submitted_on, notes, created_at, products(name), profiles!submissions_agent_id_fkey(full_name)';

export async function mySubmissions({ limit = 100 } = {}) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('submissions')
      .select(SUBMISSION_COLS)
      .eq('agent_id', session.user.id)
      .order('submitted_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

export async function deleteSubmission(id) {
  await requireSession();
  const { error } = await supabase.from('submissions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* --- agents (admin) ------------------------------------------------------ */
export async function listAgents() {
  await requireSession();
  return unwrap(
    await supabase
      .from('profiles')
      .select('id, email, full_name, role, team_id, active, is_demo, created_at, teams(name)')
      .order('full_name')
  ).map(p => (p.is_demo ? { ...p, role: 'demo' } : p));
}

export async function updateAgent(id, patch) {
  await requireSession();
  // "demo" is stored as a dialer with is_demo set (migration 049).
  if ('role' in patch) {
    patch = patch.role === 'demo'
      ? { ...patch, role: 'dialer', is_demo: true }
      : { ...patch, is_demo: false };
  }
  return unwrap(
    await supabase.from('profiles').update(patch).eq('id', id).select().single()
  );
}

export async function setGoal(agentId, period, targetAp) {
  await requireSession();
  return unwrap(
    await supabase
      .from('goals')
      .upsert({ agent_id: agentId, period, target_ap: targetAp }, { onConflict: 'agent_id,period' })
      .select()
      .single()
  );
}

/* --- aggregates (RPC) ---------------------------------------------------- */
export async function myMetrics() {
  await requireSession();
  const rows = unwrap(await supabase.rpc('my_metrics'));
  return (
    rows?.[0] ?? {
      daily_ap: 0, daily_spend: 0, smc_daily_spend: 0, ewss_daily_spend: 0,
      weekly_spend: 0, smc_weekly_spend: 0, ewss_weekly_spend: 0,
      monthly_spend: 0, smc_monthly_spend: 0, ewss_monthly_spend: 0, yearly_spend: 0,
      month_ap: 0, pace: 0, target_ap: 0,
      days_elapsed: 0, days_in_month: 0, month_count: 0, pending_count: 0,
      unassigned_daily_spend: 0, unassigned_weekly_spend: 0, unassigned_monthly_spend: 0,
      smc_yearly_spend: 0, ewss_yearly_spend: 0, unassigned_yearly_spend: 0,
    }
  );
}

export async function adminReport(start, end) {
  await requireSession();
  return unwrap(await supabase.rpc('admin_report', { p_start: start, p_end: end }));
}

export async function agentSpendReport() {
  await requireSession();
  return unwrap(await supabase.rpc('agent_spend_report'));
}

// Calls whose AI cost is in none of SMC, EWSS or SBA: no Agency Assigned and an
// agent with no team (migration 039). Admin-only; empty for anyone else.
// Before migration 039 has run the function doesn't exist; the Dashboard
// shows no list rather than failing to load.
export async function unassignedCostCalls() {
  await requireSession();
  const { data, error } = await supabase.rpc('unassigned_cost_calls');
  if (error) { console.warn('unassigned_cost_calls:', error.message); return []; }
  return data ?? [];
}

// Daily billed spend per agency (SMC / EWSS / SBA / Unassigned), every day in
// the range including zeros (migration 045). Before 045 has run the function
// doesn't exist; returns null so the Dashboard chart can say so instead of
// failing the whole page.
export async function agencySpendDaily(start, end) {
  await requireSession();
  const { data, error } = await supabase.rpc('agency_spend_daily', { p_start: start, p_end: end });
  if (error) { console.warn('agency_spend_daily:', error.message); return null; }
  return data ?? [];
}

/* --- billing -------------------------------------------------------------- */
// Each agency's AI grading balance (migration 046): billed charges, payments
// through Stripe, balance due. Admins get every agency, everyone else their
// own. Before 046 has run the function doesn't exist; returns null so the
// Billing page can say so.
export async function agencyBalances() {
  await requireSession();
  const { data, error } = await supabase.rpc('agency_balances');
  if (error) { console.warn('agency_balances:', error.message); return null; }
  return data ?? [];
}

export async function agencyPayments({ limit = 50 } = {}) {
  await requireSession();
  const { data, error } = await supabase
    .from('agency_payments')
    .select('id, team_id, amount_usd, tax_usd, kind, paid_by_email, paid_at, team:teams(name), payer:profiles(full_name)')
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('agency_payments:', error.message); return []; }
  return data ?? [];
}

// EWSS only, admins only (migration 048): records a write-off for EWSS's
// current balance. Returns the amount cleared.
export async function zeroOutBalance(teamId) {
  await requireSession();
  return unwrap(await supabase.rpc('zero_out_agency_balance', { p_team_id: teamId }));
}

/* --- analytics ------------------------------------------------------------ */
export async function analyticsAgents() {
  await requireSession();
  return unwrap(await supabase.rpc('analytics_agents'));
}

export async function analyticsTrend({ bucket, agentId, agentName, teamId } = {}) {
  await requireSession();
  return unwrap(await supabase.rpc('analytics_trend', {
    p_bucket: bucket,
    p_agent_id: agentId ?? null,
    p_agent_name: agentName ?? null,
    p_team_id: teamId ?? null,
  }));
}

export async function agentScoreRoster({ bucket, teamId } = {}) {
  await requireSession();
  return unwrap(await supabase.rpc('agent_score_roster', {
    p_bucket: bucket,
    p_team_id: teamId ?? null,
  }));
}

/* --- call scoring -------------------------------------------------------- */
// call_scores embeds every score row this recording has ever had, not just
// the current one (re-scoring adds a row rather than replacing it — see
// migration 031) — the list view picks the latest by created_at itself,
// the same resolution call_scores_effective does server-side. call_scorecards
// is embedded the same way, for the Medicare grade in the list's Score column.
const RECORDING_COLS =
  'id, agent_id, agent_name, uploaded_by, title, call_on, duration_seconds, storage_path, ' +
  'transcript_source, status, error_message, created_at, updated_at, script_id, call_type, team_id, ' +
  'reviewer_approved, reviewer_approved_at, ' +
  'agent:profiles!call_recordings_agent_id_fkey(full_name, team:teams(name, cost_markup, markups:team_cost_markups(markup, effective_from))), script:scripts(name), ' +
  'team:teams(name, cost_markup, markups:team_cost_markups(markup, effective_from)), ' +
  'reviewer:profiles!call_recordings_reviewer_approved_by_fkey(full_name), ' +
  'call_scores(overall_score, manual_overall_score, is_overridden, created_at), ' +
  'call_scorecards(percent, possible, manual_percent, manual_possible, created_at)';

// Deliberately omits `transcript`. A list of 50 calls would otherwise pull
// 50 full transcripts over the wire to render 50 table rows.
// The multiplier a call's AI cost is billed at: the markup of its Agency
// Assigned, else its agent's own team, in effect at `at` (when the cost was
// incurred; now for a grade that just finished). Same rule as
// ai_cost_events / cost_markup_at() (migration 047): SBA 1.10 then 1.11 from 2026-10-30, SMC (1.025, 1.03, then 1.035 from 2026-10-31)
// 1.025 from 2026-10-26 then 1.03 from 2026-10-30, everyone else 1.
export function costMarkup(rec, at = new Date()) {
  const team = rec?.team ?? rec?.agent?.team;
  if (!team) return 1;
  if (!Array.isArray(team.markups)) return Number(team.cost_markup ?? 1);
  const t = new Date(at).getTime();
  const current = team.markups
    .filter(m => new Date(m.effective_from).getTime() <= t)
    .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from))[0];
  return Number(current?.markup ?? 1);
}

// agency: { teamId, agentIds } — calls whose Agency Assigned is that team,
// or that have none and whose agent is on it (agentIds: the team's
// accounts). Same rule as cost_category in ai_cost_events.
export async function listRecordings({ agentId, agentName, status, agency, limit = 100 } = {}) {
  await requireSession();
  let q = supabase
    .from('call_recordings')
    .select(RECORDING_COLS)
    .order('call_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (agentId) q = q.eq('agent_id', agentId);
  if (agentName) q = q.eq('agent_name', agentName);
  if (status) q = q.eq('status', status);
  if (agency) {
    q = agency.agentIds.length
      ? q.or(`team_id.eq.${agency.teamId},and(team_id.is.null,agent_id.in.(${agency.agentIds.join(',')}))`)
      : q.eq('team_id', agency.teamId);
  }
  return unwrap(await q);
}

// Every free-text name ever typed for a label-only call, for the "remembered
// names" dropdown on the upload form and the agent filter on the call list.
// Typed-in agent names (no login) with the agencies their calls were
// assigned to (migration 053). Before 053 has run, null: the Agent dropdown
// then keeps every typed-in name under any agency.
export async function recordingLabelAgencies() {
  await requireSession();
  const { data, error } = await supabase.rpc('recording_label_agencies');
  if (error) { console.warn('recording_label_agencies:', error.message); return null; }
  return data ?? [];
}

export async function recordingAgentNames() {
  await requireSession();
  return (unwrap(await supabase.rpc('recording_agent_names')) ?? []).map(r => r.agent_name);
}

export async function getRecording(id) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_recordings')
      .select(`${RECORDING_COLS}, transcript, transcript_segments`)
      .eq('id', id)
      .maybeSingle()
  );
}

export async function createRecording(input) {
  const session = await requireSession();
  const hasTranscript = Boolean(input.transcript?.trim());
  return unwrap(
    await supabase
      .from('call_recordings')
      .insert({
        agent_id: input.agent_id || null,
        agent_name: input.agent_id ? null : (input.agent_name?.trim() || null),
        uploaded_by: session.user.id,
        appointment_id: input.appointment_id || null,
        script_id: input.script_id || null,
        call_type: input.call_type || null,
        team_id: input.team_id || null,
        title: input.title || '',
        call_on: input.call_on,
        duration_seconds: input.duration_seconds ?? null,
        storage_path: input.storage_path ?? null,
        transcript: hasTranscript ? input.transcript.trim() : null,
        transcript_source: hasTranscript ? 'manual' : null,
        status: hasTranscript ? 'transcribed' : 'uploaded',
      })
      .select()
      .single()
  );
}

export async function saveTranscript(id, transcript) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_recordings')
      .update({
        transcript: transcript.trim(),
        transcript_source: 'manual',
        status: 'transcribed',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
  );
}

export async function updateRecording(id, patch) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_recordings')
      .update(patch)
      .eq('id', id)
      .select()
      .single()
  );
}

// Separate from the AI score and any manual override of it — just whether a
// human has looked at the call and signed off.
export async function setReviewerApproval(id, approved) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('call_recordings')
      .update({
        reviewer_approved: approved,
        reviewer_approved_by: approved ? session.user.id : null,
        reviewer_approved_at: approved ? new Date().toISOString() : null,
      })
      .eq('id', id)
      .select()
      .single()
  );
}

export async function deleteRecording(id) {
  await requireSession();
  const { error } = await supabase.from('call_recordings').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// The bucket's storage policy keys ownership off the first path segment, so
// the uploader's own UUID has to lead the object name.
export async function uploadAudio(file) {
  const session = await requireSession();
  const ext = (file.name.split('.').pop() || 'mp3').toLowerCase().slice(0, 8);
  const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from('call-recordings')
    .upload(path, file, { contentType: file.type || undefined, upsert: false });

  if (error) throw new Error(error.message);
  return path;
}

export async function audioUrl(storagePath) {
  await requireSession();
  const { data, error } = await supabase.storage
    .from('call-recordings')
    .createSignedUrl(storagePath, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function scoreForRecording(recordingId) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_scores')
      .select('*, overridden_by_profile:profiles!call_scores_overridden_by_fkey(full_name), script:scripts(name)')
      .eq('recording_id', recordingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

// The one admin-made call that's authoritative for a score — separate from
// score_reviews, which are independent opinions used to tune the rubric and
// never override anything on their own. RLS (scores_admin) already restricts
// this write to admins; nothing further to check client-side.
export async function saveScoreOverride(scoreId, patch) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('call_scores')
      .update({
        manual_overall_score: patch.overall_score,
        manual_dimensions: patch.dimensions,
        manual_compliance_passed: patch.compliance_passed,
        manual_findings: patch.findings,
        manual_notes: patch.notes || '',
        is_overridden: true,
        overridden_by: session.user.id,
        overridden_at: new Date().toISOString(),
      })
      .eq('id', scoreId)
      .select()
      .single()
  );
}

export async function clearScoreOverride(scoreId) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_scores')
      .update({ is_overridden: false })
      .eq('id', scoreId)
      .select()
      .single()
  );
}

export async function myScores({ limit = 50 } = {}) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('call_scores')
      .select('*, call_recordings(title, call_on)')
      .eq('agent_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

/* --- Edge Functions ------------------------------------------------------ */
// The model call lives server-side because the Anthropic key cannot ship with
// the frontend. invoke() attaches the caller's JWT, which is what the function
// uses to decide whether this user may score this call.
async function invokeFunction(name, body) {
  await requireSession();
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    // FunctionsHttpError carries the real reason in the response body; the
    // error object alone just says "non-2xx status", which is useless to a user.
    let detail = error.message;
    try {
      const payload = await error.context?.json?.();
      if (payload?.error) detail = payload.error;
    } catch {
      /* body wasn't JSON — keep the generic message */
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const scoreCall = recordingId => invokeFunction('score-call', { recording_id: recordingId });
export const transcribeCall = recordingId => invokeFunction('transcribe-call', { recording_id: recordingId });
// Returns { url } for the Stripe-hosted payment page. The amount is worked
// out server-side; the browser only says which agency.
export const startCheckout = teamId => invokeFunction('create-checkout', { team_id: teamId });

// AI-written coaching note built only from the reviewer's own manual
// changes — see summarize-review. Safe to call repeatedly: the function
// caches its own result and skips the Anthropic call when nothing has
// changed since the last generation.
export const generateManualSummary = scoreId => invokeFunction('summarize-review', { score_id: scoreId });

/* --- Pass/fail scorecard (migration 035) ---------------------------------
   A second instrument beside the rubric score: a checklist graded item by
   item by its own Edge Function, score-scorecard. The model's grade is never
   edited; a reviewer's regrade is written to the manual_* columns beside it.
   -------------------------------------------------------------------------- */
export const gradeScorecard = recordingId => invokeFunction('score-scorecard', { recording_id: recordingId });

export async function activeScorecard() {
  await requireSession();
  return unwrap(
    await supabase.from('scorecards').select('id, name, version, definition').eq('is_active', true).maybeSingle()
  );
}

// Latest grade for a call, with the scorecard version that produced it — the
// item wording and point values shown must be the ones it was graded under,
// not whatever is active today.
export async function scorecardForRecording(recordingId) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_scorecards')
      .select('*, scorecard:scorecards(id, name, version, definition), reviewer:profiles!call_scorecards_reviewed_by_fkey(full_name)')
      .eq('recording_id', recordingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

// RLS (call_scorecards_admin) restricts this to admins.
export async function saveScorecardReview(id, manualItems, totals) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('call_scorecards')
      .update({
        manual_items: manualItems,
        manual_earned: totals.earned,
        manual_possible: totals.possible,
        manual_percent: totals.percent,
        reviewed_by: session.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id')
      .single()
  );
}

export async function clearScorecardReview(id) {
  await requireSession();
  return unwrap(
    await supabase
      .from('call_scorecards')
      .update({
        manual_items: null, manual_earned: null, manual_possible: null, manual_percent: null,
        reviewed_by: null, reviewed_at: null,
      })
      .eq('id', id)
      .select('id')
      .single()
  );
}

// Creating a user with an admin-chosen password, and deleting one, both need
// the Auth Admin API — the anon key this file holds can't do either, so both
// go through the admin-users Edge Function instead of a table write.
export const createAgent = (firstName, lastName, email, password, role) =>
  invokeFunction('admin-users', {
    action: 'create',
    first_name: firstName,
    last_name: lastName,
    email,
    password,
    role,
  });

// Name, email, role, team, and optionally a new password (blank = unchanged).
// Email and password live on the login itself, so this goes through the
// Edge Function rather than a profiles update.
export const editAgent = (userId, { fullName, email, role, teamId, password }) =>
  invokeFunction('admin-users', {
    action: 'update',
    user_id: userId,
    full_name: fullName,
    email,
    role,
    team_id: teamId || null,
    password: password || '',
  });

export const deleteAgent = userId =>
  invokeFunction('admin-users', { action: 'delete', user_id: userId });

/* --- scoring aggregates (RPC) -------------------------------------------- */
export async function scoringLeaderboard(start, end) {
  await requireSession();
  return unwrap(await supabase.rpc('scoring_leaderboard', { p_start: start, p_end: end }));
}

// Medicare leaderboard — same row shape, ranked on scorecard percentage
// (migration 035) instead of the rubric score.
export async function scorecardLeaderboard(start, end) {
  await requireSession();
  return unwrap(await supabase.rpc('scorecard_leaderboard', { p_start: start, p_end: end }));
}

/* --- calibration ----------------------------------------------------------
   Calibration compares each overridden call's model score against the
   admin's manual override on it (call_scores.manual_*) — the same
   per-dimension/per-finding Manual review data already captured in the
   call detail page. There's no separate "grade it again" step; per Ryan
   2026-09-17, that would just duplicate the manual review sections.
   -------------------------------------------------------------------------- */
export async function calibrationByDimension(start, end, callType) {
  await requireSession();
  return unwrap(
    await supabase.rpc('calibration_by_dimension', { p_start: start, p_end: end, p_call_type: callType ?? null })
  );
}

export async function calibrationSummary(start, end, callType) {
  await requireSession();
  const rows = unwrap(await supabase.rpc('calibration_summary', { p_start: start, p_end: end, p_call_type: callType ?? null }));
  return (
    rows?.[0] ?? {
      reviews: 0, model_avg: null, human_avg: null, delta: null,
      mean_abs_gap: null, within_5: 0, within_10: 0, compliance_disputed: 0,
    }
  );
}

/* --- scoring rubric ------------------------------------------------------ */
const RUBRIC_COLS =
  'id, version, is_active, intro, scale, scale_note, dimensions, compliance_intro, ' +
  'finding_codes, severity_guidance, evidence_rules, output_guidance, notes, created_at';

export async function activeRubric() {
  await requireSession();
  return unwrap(
    await supabase
      .from('scoring_rubrics')
      .select(RUBRIC_COLS)
      .eq('is_active', true)
      .maybeSingle()
  );
}

export async function listRubrics({ limit = 50 } = {}) {
  await requireSession();
  return unwrap(
    await supabase
      .from('scoring_rubrics')
      .select(`${RUBRIC_COLS}, profiles:created_by(full_name)`)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

export async function getRubric(id) {
  await requireSession();
  return unwrap(
    await supabase.from('scoring_rubrics').select(RUBRIC_COLS).eq('id', id).maybeSingle()
  );
}

// Publishing is two steps on purpose: insert the new version, then flip the
// active flag through the RPC. The flag move is atomic in Postgres — doing it
// from here in two updates would briefly leave two rows active, which the
// partial unique index rejects.
export async function createRubricVersion(input) {
  const session = await requireSession();
  return unwrap(
    await supabase
      .from('scoring_rubrics')
      .insert({
        version: input.version,
        is_active: false,
        intro: input.intro,
        scale: input.scale,
        scale_note: input.scale_note,
        dimensions: input.dimensions,
        compliance_intro: input.compliance_intro,
        finding_codes: input.finding_codes,
        severity_guidance: input.severity_guidance,
        evidence_rules: input.evidence_rules,
        output_guidance: input.output_guidance,
        notes: input.notes || '',
        created_by: session.user.id,
      })
      .select()
      .single()
  );
}

export async function publishRubric(id) {
  await requireSession();
  return unwrap(await supabase.rpc('publish_rubric', { p_rubric_id: id }));
}

export async function scoringSpend(start, end) {
  await requireSession();
  const rows = unwrap(await supabase.rpc('scoring_spend', { p_start: start, p_end: end }));
  return (
    rows?.[0] ?? {
      calls_scored: 0, total_cost_usd: 0, avg_cost_usd: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    }
  );
}

// Fixed day/week(Mon-Sun)/month(1st-last) grading spend, org-wide and per
// team — not tied to the Period selector elsewhere on Scorecard, since these
// windows are always "right now," not a chosen range.
export async function spendSummary() {
  await requireSession();
  return unwrap(await supabase.rpc('spend_summary')) ?? [];
}
