// ---------------------------------------------------------------------------
// Rubric assembly.
//
// The rubric itself is no longer here — it lives in public.scoring_rubrics and
// is edited from the app. This module turns a rubric row into the two things
// the model call needs: a system prompt and an output schema.
//
// There is deliberately NO built-in fallback rubric. If no active row exists,
// scoring fails loudly. A fallback would mean the app could display one set of
// criteria while a different set silently graded the calls — the exact bug
// that makes a score impossible to trust or reproduce.
//
// Assembly is DETERMINISTIC: fixed section order, fixed separators, no dates,
// no per-call values. That is what lets the prompt cache work — caching is a
// byte-exact prefix match, so the same rubric row must produce the same bytes
// every time. Reordering these sections would invalidate the cache on every
// call without changing a word of the rubric.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BUILTIN_RUBRIC — used only when the database has no active rubric.
//
// This exists so scoring works before migration 004 is applied, and keeps
// working if the rubrics table is ever empty. It is NOT silent: the version
// string is prefixed `builtin/`, and that string is written to
// call_scores.rubric_version, so any score graded this way says so on its own
// row. A fallback you can't identify afterwards would be worse than no
// fallback — you could never tell which criteria produced a given score.
//
// The database rubric always wins when one is active. Edits made on the Rubric
// page therefore take effect immediately and this block stops being consulted.
// Keep the text here in sync with the seed in 004_rubric.sql, or the two paths
// will grade differently.
// ---------------------------------------------------------------------------
export const BUILTIN_RUBRIC: Rubric = {
  version: 'builtin/2026-08-26.1',
  intro:
`You are a sales-quality reviewer for an insurance agency. You score recorded sales calls against a fixed rubric and return structured findings that a manager will use for coaching.

You are scoring the AGENT, not the prospect. A call where the prospect was rude or hung up early can still be a high-scoring call if the agent handled it well. A call that closed a sale can still be a low-scoring call if the agent got there by cutting corners.`,
  scale: [
    { min: 90, max: 100, label: 'Exemplary', description: 'Would be used as a training example.' },
    { min: 75, max: 89, label: 'Strong', description: 'Minor refinements only.' },
    { min: 60, max: 74, label: 'Competent', description: 'Did the job; clear room to improve.' },
    { min: 40, max: 59, label: 'Weak', description: 'Missed material opportunities or made avoidable errors.' },
    { min: 0, max: 39, label: 'Poor', description: "Would damage the agency's results or reputation." },
  ],
  scale_note:
`Use the whole range — a competent, unremarkable call is a 70, not a 90.

If a dimension genuinely did not occur in the call — the prospect hung up during the opening, so there was no close — score it 0 and say plainly in the rationale that it did not occur. Do not score an absent stage as average.`,
  dimensions: [
    {
      key: 'opening', label: 'Opening & rapport', weight: 1,
      description: 'Did the agent establish who they are, why they are calling, and earn permission to continue — without launching straight into a pitch?',
      criteria: [
        'Gives their name and the agency name unprompted, early.',
        'States the reason for the call in one plain sentence.',
        'Confirms they are speaking to the intended person before discussing anything specific.',
        'Asks whether it is a workable time, and honours the answer.',
        'Tone is unhurried and conversational rather than read-aloud or apologetic.',
        'Does not begin presenting a product before the prospect has agreed to talk.',
      ],
    },
    {
      key: 'discovery', label: 'Discovery', weight: 2,
      description: "Did the agent learn the prospect's actual situation before proposing anything? This is the dimension that most often separates a good call from a bad one — an agent who presents before discovering should score low here regardless of how polished the presentation was.",
      criteria: [
        'Asks what coverage the prospect has now, and what prompted them to look.',
        'Establishes which doctors, hospitals, or clinics the prospect wants to keep.',
        'Establishes current prescriptions by name where relevant.',
        'Surfaces budget or affordability constraints without pressuring.',
        'Asks open questions rather than yes/no ones.',
        'Lets the prospect finish; does not talk over or rush the answer.',
        'Reflects back what was heard to confirm it landed correctly.',
      ],
    },
    {
      key: 'presentation', label: 'Presentation', weight: 2,
      description: 'Was the recommendation tied to what discovery surfaced, and described accurately? Penalize accuracy problems hard: a fluent, friendly misstatement of a benefit is worse than an awkward correct one.',
      criteria: [
        'Explicitly connects the recommendation to something the prospect said.',
        'States premium and the cost-sharing that will actually affect this prospect.',
        'States meaningful limitations and exclusions, not only benefits.',
        'Confirms — rather than assumes — whether named doctors or drugs are covered.',
        'Uses plain language; defines any insurance term it uses.',
        'Checks the prospect is following before moving to the next point.',
        'Presents one clear recommendation rather than an unfiltered list of options.',
      ],
    },
    {
      key: 'objection_handling', label: 'Objection handling', weight: 1,
      description: 'Did the agent find and answer the real concern? Distinguish handling from steamrolling — repeating the pitch louder is not handling. If no objection arose, score on whether the agent surfaced and addressed unspoken hesitation.',
      criteria: [
        'Acknowledges the objection before answering it.',
        'Asks a clarifying question to find the concern underneath the stated one.',
        'Answers the actual concern rather than an easier adjacent one.',
        'Stays calm and does not interrupt or raise pressure.',
        'Accepts a genuine no without escalating.',
        'Confirms the concern is resolved before moving on.',
      ],
    },
    {
      key: 'closing', label: 'Closing', weight: 1,
      description: 'Was there a clear, specific, agreed next step? A polite ending with no next step is a weak close, not a neutral one.',
      criteria: [
        'Proposes a concrete next step rather than "I will follow up".',
        'Attaches a specific day and time to it.',
        'Gets explicit agreement from the prospect.',
        'Recaps what will happen and what the prospect needs to have ready.',
        'Leaves a direct way to make contact in the meantime.',
        'Ends without applying last-minute pressure.',
      ],
    },
  ],
  compliance_intro:
'Report every compliance issue you observe as a separate finding. These are regulatory and reputational matters, so they are graded independently of the sales dimensions — a smooth, high-scoring sales call can still fail compliance, and you must say so when it does.',
  finding_codes: [
    { code: 'recording_disclosure', label: 'Recording not disclosed',
      description: 'The call is being recorded and the agent did not disclose it.' },
    { code: 'scope_of_appointment', label: 'Scope of appointment',
      description: 'The agent discussed a Medicare Advantage or Part D plan without an agreed scope of appointment covering that product type.' },
    { code: 'permission_to_contact', label: 'Permission to contact',
      description: 'No established basis for the outbound contact, or the prospect asked not to be contacted and the agent continued.' },
    { code: 'missing_disclaimer', label: 'Missing disclaimer',
      description: "The agent did not state that they do not offer every plan available in the prospect's area, where that statement was required." },
    { code: 'misleading_claim', label: 'Misleading claim',
      description: 'A benefit, cost, or affiliation was stated in a way that is inaccurate or would leave a reasonable listener with a false impression. Includes implying endorsement by Medicare or a government body.' },
    { code: 'provider_network_claim', label: 'Unverified network claim',
      description: 'The agent asserted a specific doctor, hospital, or drug is covered without verifying it.' },
    { code: 'unsolicited_cross_sell', label: 'Unsolicited cross-sell',
      description: "The agent moved to a different product line without the prospect's agreement." },
    { code: 'pressure_tactic', label: 'Pressure tactic',
      description: 'Manufactured urgency, refusing to end the call, or discouraging the prospect from consulting someone else.' },
  ],
  severity_guidance:
'Severity: `critical` for anything that likely breaks a rule on its own, `high` for a clear violation needing prompt correction, `medium` for a practice that will become a violation if repeated, `low` for a habit worth correcting. Set `compliance_passed` to false if any finding is `high` or `critical`.',
  evidence_rules:
`Every dimension rationale and every compliance finding must quote the transcript. Quote the shortest span that supports the point, verbatim, from the transcript you were given. If you cannot find a supporting quote, you do not have grounds for the point — drop it.

Do not infer facts that are not in the transcript. Transcripts are imperfect: speaker labels can be wrong and words are sometimes garbled. When a passage is ambiguous, say so in the rationale and score conservatively rather than assuming the worse reading. Never report a compliance finding that rests on a garbled passage.`,
  output_guidance:
`The bulleted criteria under each dimension are the specific behaviours to look for. They are a guide to what good looks like, not a checklist to tally — a call can score well while missing a bullet that did not apply, and can score badly while technically hitting several. Judge the dimension, and use the bullets to explain why.

Where a dimension carries a weight above 1, it matters proportionally more to the overall score.

\`overall_score\` is your holistic judgment of the call, not an average of the dimensions — weight what actually mattered here, informed by the dimension weights. Keep it 0-100.

\`summary\` is two or three sentences a manager can read without opening the transcript. \`coaching_focus\` is the single highest-leverage thing this agent should work on next; name one thing, not a list.`,
};

export interface ScaleBand {
  min: number;
  max: number;
  label: string;
  description: string;
}

export interface Dimension {
  key: string;
  label: string;
  description: string;
  // Concrete, checkable behaviours. These do the real work: "was discovery
  // good" is not gradeable, "asked about current prescriptions before
  // recommending" is. Editable per dimension from the Rubric page.
  criteria?: string[];
  // Relative importance when forming the overall score. 1 is normal; 2 counts
  // double. Not a strict multiplier — the model is told to weight its holistic
  // judgment, not to compute an average.
  weight?: number;
}

export interface FindingCode {
  code: string;
  label: string;
  description: string;
}

export interface Rubric {
  version: string;
  intro: string;
  scale: ScaleBand[];
  scale_note: string;
  dimensions: Dimension[];
  compliance_intro: string;
  finding_codes: FindingCode[];
  severity_guidance: string;
  evidence_rules: string;
  output_guidance: string;
}

// A dimension key becomes a JSON object key in the output schema. Anything
// outside this shape produces a schema the API rejects, and the failure
// surfaces as an opaque 400 rather than "your rubric is malformed".
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

export function validateRubric(r: Rubric): string[] {
  const problems: string[] = [];

  if (!r.dimensions?.length) problems.push('Rubric has no dimensions.');
  if (!r.finding_codes) problems.push('Rubric has no finding_codes array.');

  const seenDim = new Set<string>();
  for (const d of r.dimensions ?? []) {
    if (!KEY_RE.test(d.key)) {
      problems.push(`Dimension key "${d.key}" must be lowercase letters, digits and underscores, starting with a letter.`);
    }
    if (seenDim.has(d.key)) problems.push(`Duplicate dimension key "${d.key}".`);
    seenDim.add(d.key);
  }

  const seenCode = new Set<string>();
  for (const c of r.finding_codes ?? []) {
    if (!KEY_RE.test(c.code)) {
      problems.push(`Finding code "${c.code}" must be lowercase letters, digits and underscores, starting with a letter.`);
    }
    if (seenCode.has(c.code)) problems.push(`Duplicate finding code "${c.code}".`);
    seenCode.add(c.code);
  }

  return problems;
}

const MULTI_RECORDING_NOTE =
  'A transcript can hold more than one recording of the same call, joined by a line starting "--- Call dropped. Follow-up call": ' +
  'the call dropped and the agent picked it back up. Score the recordings together as one call, in order. Something done in any ' +
  'recording counts, and speaker numbers restart in each recording, so tell the agent from the prospect by what they say.';

export function buildSystemPrompt(r: Rubric): string {
  const scaleLines = (r.scale ?? [])
    .map(b => `- ${b.min}-${b.max}  ${b.label}. ${b.description}`)
    .join('\n');

  const dimensionLines = (r.dimensions ?? [])
    .map(d => {
      const weight = d.weight && d.weight !== 1 ? ` [weight: ${d.weight}x]` : '';
      const criteria = d.criteria?.length
        ? '\n' + d.criteria.map(c => `  - ${c}`).join('\n')
        : '';
      return `**${d.key}** (${d.label})${weight} — ${d.description}${criteria}`;
    })
    .join('\n\n');

  const codeLines = (r.finding_codes ?? [])
    .map(c => `- \`${c.code}\` (${c.label}) — ${c.description}`)
    .join('\n');

  // Fixed section order. Do not reorder — see the caching note at the top.
  return [
    r.intro,
    '## Scoring scale\n\nEvery dimension is scored 0-100 on this scale.\n\n' + scaleLines,
    r.scale_note,
    '## Dimensions\n\n' + dimensionLines,
    '## Compliance\n\n' + r.compliance_intro,
    'Finding codes:\n\n' + codeLines,
    r.severity_guidance,
    '## Evidence\n\n' + r.evidence_rules,
    // Fixed, not part of the editable rubric: how transcribe-call joins a
    // call's recordings (migration 061). Constant text, so the cache holds.
    MULTI_RECORDING_NOTE,
    '## Output\n\n' + r.output_guidance,
  ]
    .map(s => (s ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// Structured-output schema, derived from the rubric so the model can only
// return the dimensions and codes that are actually defined.
//
// Note what is NOT expressible here: JSON Schema numeric bounds and string
// lengths are unsupported by structured outputs, so "0-100" lives in the
// prompt text and index.ts clamps on the way in.
export function buildOutputSchema(r: Rubric) {
  const dimensionSchema = {
    type: 'object',
    properties: {
      score: { type: 'integer', description: '0-100 on the rubric scale.' },
      rationale: { type: 'string', description: 'Two or three sentences justifying the score.' },
      evidence: { type: 'string', description: 'A short verbatim quote from the transcript.' },
    },
    required: ['score', 'rationale', 'evidence'],
    additionalProperties: false,
  };

  const keys = r.dimensions.map(d => d.key);
  const codes = r.finding_codes.map(c => c.code);

  return {
    type: 'object',
    properties: {
      overall_score: { type: 'integer', description: 'Holistic 0-100 score for the call.' },
      dimensions: {
        type: 'object',
        properties: Object.fromEntries(keys.map(k => [k, dimensionSchema])),
        required: keys,
        additionalProperties: false,
      },
      compliance_passed: {
        type: 'boolean',
        description: 'False if any finding is high or critical severity.',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // An empty enum is invalid JSON Schema, so a rubric with no
            // compliance codes falls back to a free string rather than
            // producing a schema the API rejects.
            code: codes.length
              ? { type: 'string', enum: codes }
              : { type: 'string', description: 'Compliance issue identifier.' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            detail: { type: 'string', description: 'What happened, in one or two sentences.' },
            evidence: { type: 'string', description: 'Verbatim quote from the transcript.' },
          },
          required: ['code', 'severity', 'detail', 'evidence'],
          additionalProperties: false,
        },
      },
      strengths: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      coaching_focus: { type: 'string' },
    },
    required: [
      'overall_score', 'dimensions', 'compliance_passed', 'findings',
      'strengths', 'improvements', 'summary', 'coaching_focus',
    ],
    additionalProperties: false,
  };
}
