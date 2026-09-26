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
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=55';

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
      .select('id, email, full_name, role, team_id, active, teams(name)')
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
      .select('id, email, full_name, role, team_id, active, created_at, teams(name)')
      .order('full_name')
  );
}

export async function updateAgent(id, patch) {
  await requireSession();
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
const RECORDING_COLS =
  'id, agent_id, agent_name, uploaded_by, title, call_on, duration_seconds, storage_path, ' +
  'transcript_source, status, error_message, created_at, script_id, call_type, team_id, ' +
  'reviewer_approved, reviewer_approved_at, ' +
  'agent:profiles!call_recordings_agent_id_fkey(full_name), script:scripts(name), ' +
  'team:teams(name), ' +
  'reviewer:profiles!call_recordings_reviewer_approved_by_fkey(full_name)';

// Deliberately omits `transcript`. A list of 50 calls would otherwise pull
// 50 full transcripts over the wire to render 50 table rows.
export async function listRecordings({ agentId, agentName, status, limit = 100 } = {}) {
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
  return unwrap(await q);
}

// Every free-text name ever typed for a label-only call, for the "remembered
// names" dropdown on the upload form and the agent filter on the call list.
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

// AI-written coaching note built only from the reviewer's own manual
// changes — see summarize-review. Safe to call repeatedly: the function
// caches its own result and skips the Anthropic call when nothing has
// changed since the last generation.
export const generateManualSummary = scoreId => invokeFunction('summarize-review', { score_id: scoreId });

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

export const deleteAgent = userId =>
  invokeFunction('admin-users', { action: 'delete', user_id: userId });

/* --- scoring aggregates (RPC) -------------------------------------------- */
export async function scoringLeaderboard(start, end) {
  await requireSession();
  return unwrap(await supabase.rpc('scoring_leaderboard', { p_start: start, p_end: end }));
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
