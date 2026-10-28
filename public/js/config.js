// ---------------------------------------------------------------------------
// Fill these in from Supabase → Project Settings → API.
//
// The anon key is safe to ship in client code — it is not a secret. Every table
// is protected by row level security in schema.sql; the key only ever grants
// what those policies allow. Never put the *service role* key here.
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://dnxuzdylyvurbyeyzfxy.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_hqi0FUr-xJ5RG7I5K1t9Bg_qGNY5ON9';

export const isConfigured = () =>
  SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 40;

// Reporting timezone. Must match the timezone baked into schema.sql so that
// "today" means the same day in Postgres and in the browser.
export const TIMEZONE = 'America/Chicago';

export const CATEGORIES = [
  { value: 'mapd',      label: 'MAPD' },
  { value: 'ancillary', label: 'Ancillary' },
  { value: 'combined',  label: 'Combined' },
];

export const STATUSES = [
  { value: 'pending',    label: 'Pending',    tone: 'warning',  icon: '◷' },
  { value: 'approved',   label: 'Approved',   tone: 'good',     icon: '✓' },
  { value: 'rejected',   label: 'Rejected',   tone: 'serious',  icon: '✕' },
  { value: 'chargeback', label: 'Chargeback', tone: 'critical', icon: '↩' },
];

export const ROLES = [
  { value: 'agent',  label: 'Agent' },
  { value: 'admin',  label: 'Admin' },
  { value: 'dialer', label: 'Dialer' },
  // A test login: every tab, no data, no changes (migration 049).
  { value: 'demo',   label: 'Demo (no data)' },
];

// A call's category, separate from CATEGORIES above, which is for sales
// submissions, not calls. Must match the check constraint in migration 036.
export const CALL_TYPES = [
  { value: 'ancillary', label: 'Ancillary' },
  { value: 'medicare',  label: 'Medicare' },
  { value: 'medicare_ancillary', label: 'Medicare + Ancillary' },
];

// A Medicare-only call is graded by the Medicare scorecard alone, so its
// coaching-rubric score (overall, By dimension, findings) is not shown. A
// Medicare + Ancillary call shows both: the scorecard for the Medicare
// portion, the rubric for the ancillary portion.
export const showsRubricScore = callType => callType !== 'medicare';

// Must match the DIMENSIONS array in supabase/functions/score-call/rubric.ts.
// If you add a dimension there, add it here or the UI silently drops it.
export const SCORE_DIMENSIONS = [
  { key: 'opening',            label: 'Opening & rapport' },
  { key: 'discovery',          label: 'Discovery' },
  { key: 'presentation',       label: 'Presentation' },
  { key: 'objection_handling', label: 'Objection handling' },
  { key: 'closing',            label: 'Closing' },
];

export const FINDING_CODES = {
  recording_disclosure:   'Recording not disclosed',
  scope_of_appointment:   'Scope of appointment',
  permission_to_contact:  'Permission to contact',
  missing_disclaimer:     'Missing disclaimer',
  misleading_claim:       'Misleading claim',
  provider_network_claim: 'Unverified network claim',
  unsolicited_cross_sell: 'Unsolicited cross-sell',
  pressure_tactic:        'Pressure tactic',
};

export const FINDING_SEVERITIES = [
  // 'good' only ever comes from a manual re-grade scored a perfect 100 — the
  // model itself never assigns it, since it only reports findings that ARE
  // issues. A fully-corrected finding reads as resolved, not merely "low".
  { value: 'good',     label: 'Good',     tone: 'good',     icon: '✓' },
  { value: 'low',      label: 'Low',      tone: 'warning',  icon: '·' },
  { value: 'medium',   label: 'Medium',   tone: 'warning',  icon: '!' },
  { value: 'high',     label: 'High',     tone: 'serious',  icon: '!!' },
  { value: 'critical', label: 'Critical', tone: 'critical', icon: '✕' },
];

export const RECORDING_STATUSES = [
  { value: 'uploaded',     label: 'Needs transcript', tone: 'warning',  icon: '◷' },
  { value: 'transcribing', label: 'Transcribing',     tone: 'warning',  icon: '◷' },
  { value: 'transcribed',  label: 'Ready to score',   tone: 'good',     icon: '✓' },
  { value: 'scoring',      label: 'Scoring',          tone: 'warning',  icon: '◷' },
  { value: 'scored',       label: 'Scored',           tone: 'good',     icon: '★' },
  { value: 'failed',       label: 'Failed',           tone: 'critical', icon: '✕' },
];

// `scheduled` is the only non-terminal state; the other four resolve an
// appointment and are what the held/close rates are computed from.
export const APPT_STATUSES = [
  { value: 'scheduled', label: 'Scheduled', tone: 'warning',  icon: '◷' },
  { value: 'held',      label: 'Held',      tone: 'good',     icon: '✓' },
  { value: 'sold',      label: 'Sold',      tone: 'good',     icon: '★' },
  { value: 'no_show',   label: 'No show',   tone: 'serious',  icon: '✕' },
  { value: 'lost',      label: 'Lost',      tone: 'critical', icon: '↩' },
];
