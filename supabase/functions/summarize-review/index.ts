// ---------------------------------------------------------------------------
// summarize-review — Supabase Edge Function (Deno)
//
// Writes call_scores.manual_summary / manual_strengths / manual_improvements
// for an already-overridden call: a short, AI-written coaching note built
// ONLY from the reviewer's own manual changes (per-dimension and
// per-finding reasons, plus manual_notes) — never the transcript, never the
// model's own summary. Per Ryan 2026-09-18: "Summary of Call" and "What
// went well" / "What to work on" should reflect the reviewer's own grading,
// not a re-analysis of the call.
//
// Triggered from two places in the UI: the Generate report button, and the
// Reviewer status Approve button (only when approving, and only once —
// see the cache check below).
//
// Auth: the caller's JWT is used only to confirm they may see this score at
// all (scores_select_own / scores_admin — the same rule the call detail
// page itself is gated by). The actual write goes through the service role,
// same reasoning as score-call: an agent has no UPDATE policy on
// call_scores, but can still legitimately trigger this on their own graded
// call via Generate report.
// ---------------------------------------------------------------------------
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = Deno.env.get('SUMMARY_MODEL') ?? 'claude-haiku-4-5';

// Same table used by score-call — kept in sync manually, not imported,
// since these are two independently deployed functions.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0, good: -1 };

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Dim = { label?: string; score?: number; reason?: string };
type Finding = { code?: string; severity?: string; detail?: string; reason?: string };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const scoreId = body.score_id as string | undefined;
  if (!scoreId) return json({ error: 'score_id is required' }, 400);

  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

  const COLS =
    'id, overall_score, dimensions, compliance_passed, findings, is_overridden, ' +
    'manual_overall_score, manual_dimensions, manual_compliance_passed, manual_findings, ' +
    'manual_notes, overridden_at, manual_summary, manual_strengths, manual_improvements, ' +
    'manual_summary_generated_at';

  // Authorization IS this read, same pattern as score-call: a score this
  // caller may not see comes back null.
  const { data: score, error: readError } = await userClient
    .from('call_scores')
    .select(COLS)
    .eq('id', scoreId)
    .maybeSingle();
  if (readError) return json({ error: readError.message }, 400);
  if (!score) return json({ error: 'Score not found, or not yours to view.' }, 404);
  if (!score.is_overridden) {
    return json({ error: 'This call has no manual review yet — nothing to summarize.' }, 409);
  }

  // Cache hit: nothing has changed since the last generation, so skip the
  // Anthropic call entirely. Clicking Approve then Generate report (or
  // either one twice) costs nothing after the first real generation.
  if (
    score.manual_summary &&
    score.manual_summary_generated_at &&
    score.overridden_at &&
    new Date(score.manual_summary_generated_at) >= new Date(score.overridden_at)
  ) {
    return json({
      summary: score.manual_summary,
      strengths: score.manual_strengths ?? [],
      improvements: score.manual_improvements ?? [],
      cached: true,
    });
  }

  const effDimensions = (score.manual_dimensions ?? score.dimensions ?? {}) as Record<string, Dim>;
  const effFindings = (score.manual_findings ?? score.findings ?? []) as Finding[];
  const modelDimensions = (score.dimensions ?? {}) as Record<string, Dim>;
  const modelFindingByCode = new Map(
    ((score.findings ?? []) as Finding[]).map(f => [f.code, f])
  );

  // Every dimension the reviewer's effective grade covers, whether they
  // changed its score from the model's or confirmed it as-is. A reviewer who
  // looked at a call and agreed with the model on every point still has an
  // opinion worth an agent hearing — "confirmed strong" and "confirmed weak"
  // are both real feedback, not the absence of any.
  const dimensionSummaries = Object.entries(effDimensions).map(([key, v]) => {
    const modelScore = Number(modelDimensions[key]?.score ?? 0);
    const afterScore = Number(v?.score ?? 0);
    return {
      label: v?.label || key,
      score: afterScore,
      changed_from_model: afterScore !== modelScore,
      model_score: modelScore,
      reviewer_reason: v?.reason || null,
    };
  });

  const findingSummaries = effFindings.map(f => {
    const before = f.code ? modelFindingByCode.get(f.code) : undefined;
    return {
      detail: f.detail || f.code || 'finding',
      severity: f.severity,
      changed_from_model: !!before && before.severity !== f.severity,
      model_severity: before?.severity ?? null,
      reviewer_reason: f.reason || null,
    };
  });

  if (dimensionSummaries.length === 0 && findingSummaries.length === 0 && !score.manual_notes) {
    // The only real "nothing here" case — no dimensions, no findings, no
    // notes at all to draw from (e.g. a call re-scored and marked reviewed
    // before any per-dimension grade even exists yet).
    return json({
      summary: 'The reviewer confirmed this grade with no specific notes recorded.',
      strengths: [],
      improvements: [],
      cached: false,
    });
  }

  const effOverallScore = score.is_overridden ? score.manual_overall_score : score.overall_score;
  const effCompliancePassed = score.is_overridden ? score.manual_compliance_passed : score.compliance_passed;

  const systemPrompt =
    `You help a call-quality reviewer turn their final grade on an AI-scored call into a short coaching ` +
    `note for the agent. You are given the reviewer's final (effective) score for every dimension and ` +
    `finding — each one flagged as either changed from the model's own score or confirmed as-is — plus ` +
    `any reasons the reviewer wrote and any overall notes. A dimension the reviewer confirmed (didn't ` +
    `change) is still their real judgment of that dimension, not something to skip: a confirmed high ` +
    `score is a genuine strength, a confirmed low score is a genuine area to improve. Use ONLY this ` +
    `information — do not guess at what happened on the call itself, and do not invent detail beyond ` +
    `what the reviewer's final scores and reasons support. If the reviewer wrote little, keep your ` +
    `output thin rather than padding it.\n\n` +
    `Write:\n` +
    `- summary: 4-5 sentences a manager could hand directly to the agent — the overall outcome, what ` +
    `went well, and what to work on.\n` +
    `- strengths: short bullet points for whichever dimensions rate well in the reviewer's final grade ` +
    `(changed upward or confirmed high), especially any the reviewer explicitly praised.\n` +
    `- improvements: short bullet points for whichever dimensions rate poorly in the reviewer's final ` +
    `grade (changed downward or confirmed low), or any compliance finding still present in it.`;

  const userContent = JSON.stringify({
    overall_score: effOverallScore,
    compliance_passed: effCompliancePassed,
    dimensions: dimensionSummaries,
    findings: findingSummaries,
    reviewer_notes: score.manual_notes || null,
  }, null, 2);

  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools: [{
        name: 'submit_summary',
        description: 'Submit the coaching summary.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            strengths: { type: 'array', items: { type: 'string' } },
            improvements: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'strengths', 'improvements'],
        },
      }],
      tool_choice: { type: 'tool', name: 'submit_summary' },
    });

    const toolUse = message.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Model did not return a summary.');
    }
    const parsed = toolUse.input as { summary?: string; strengths?: string[]; improvements?: string[] };

    const price = PRICING[MODEL] ?? { input: 0, output: 0 };
    const costUsd =
      ((message.usage.input_tokens ?? 0) * price.input +
        (message.usage.output_tokens ?? 0) * price.output) / 1_000_000;

    const summary = String(parsed.summary ?? '').trim();
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths : [];
    const improvements = Array.isArray(parsed.improvements) ? parsed.improvements : [];

    const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { error: writeError } = await serviceClient
      .from('call_scores')
      .update({
        manual_summary: summary,
        manual_strengths: strengths,
        manual_improvements: improvements,
        manual_summary_generated_at: new Date().toISOString(),
        manual_summary_cost_usd: Number(costUsd.toFixed(5)),
      })
      .eq('id', scoreId);
    if (writeError) throw new Error(writeError.message);

    return json({ summary, strengths, improvements, cached: false, cost_usd: Number(costUsd.toFixed(5)) });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    console.error('summarize-review failed', { score_id: scoreId, error: messageText });
    return json({ error: messageText }, 500);
  }
});
