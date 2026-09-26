// ---------------------------------------------------------------------------
// score-call — Supabase Edge Function (Deno)
//
// Scores one transcribed call and writes call_scores.
//
// This runs server-side because ANTHROPIC_API_KEY cannot go in the browser:
// the frontend ships with the Supabase publishable key, and anything alongside
// it is published. It is also the only writer to call_scores — that table has
// no insert policy, so an agent cannot grade their own call.
//
// TWO WAYS IN, authorized differently:
//
//   1. The "Score call" button — carries the user's JWT. The recording is read
//      through that JWT, so RLS decides whether this user may score it.
//
//   2. A Database Webhook on UPDATE — no user session, proves itself with a
//      shared secret header and reads with the service role. Postgres already
//      established the row exists; there is nothing for RLS to decide.
//
// Loop safety for the webhook path: this function moves the row through
// 'scoring' and then 'scored', and each of those is an UPDATE that re-fires
// the webhook. Scoring only runs when status is exactly 'transcribed', so the
// echoes exit immediately instead of scoring the same call forever.
// ---------------------------------------------------------------------------
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  BUILTIN_RUBRIC, buildOutputSchema, buildSystemPrompt, validateRubric, type Rubric,
} from './rubric.ts';

const MODEL = Deno.env.get('SCORING_MODEL') ?? 'claude-opus-5';
const EFFORT = Deno.env.get('SCORING_EFFORT') ?? 'high';
const MAX_TRANSCRIPT_CHARS = Number(Deno.env.get('MAX_TRANSCRIPT_CHARS') ?? 200_000);

// Kill switch for the automatic path. Set AUTO_SCORE=off to stop webhook-driven
// scoring without deleting the webhook or redeploying — the button keeps
// working. Useful when a bulk import would otherwise score hundreds of calls.
const AUTO_SCORE = (Deno.env.get('AUTO_SCORE') ?? 'on').toLowerCase() !== 'off';

// Claude Opus 5 list pricing, USD per million tokens. Cache reads bill at
// ~0.1x input. Update these together with MODEL — a stale table produces
// confidently wrong cost reporting, which is worse than none.
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1 },
};

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Length-independent compare so a wrong secret can't be narrowed down by
// timing the response.
function constantTimeEquals(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const bearer = (h: string | null) => (h ?? '').replace(/^Bearer\s+/i, '').trim();

// Two ways a request can prove it is machine-to-machine, and accepting BOTH is
// deliberate.
//
// The shared header is explicit but has to be kept identical in three places —
// this secret, and the header on every webhook. Change one and automation dies
// with no error anywhere a person looks. Supabase already attaches the service
// role key to webhook calls, so accepting that too means a correctly-created
// webhook works with nothing to keep in sync.
function classifyCaller(req: Request) {
  const providedSecret = req.headers.get('x-webhook-secret');
  const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
  const authValue = bearer(req.headers.get('Authorization'));

  if (constantTimeEquals(providedSecret, expectedSecret)) {
    return { kind: 'webhook' as const, via: 'shared-secret' };
  }
  if (constantTimeEquals(authValue, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
    return { kind: 'webhook' as const, via: 'service-role' };
  }
  // A wrong secret used to fall through and report "Missing Authorization
  // header", which is actively misleading — it sent us debugging the wrong
  // header for an hour. Name what actually failed.
  if (providedSecret) {
    return { kind: 'bad-secret' as const, via: 'shared-secret' };
  }
  return { kind: 'user' as const, via: 'jwt' };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // GET = config self-check. Every misconfiguration in this system so far has
  // been invisible until a call failed hours later: a missing key, a rubric
  // that was never published, a secret that matched in one place and not
  // another. This answers all of it in one request, before anyone uploads
  // anything. Booleans only — no secret values are ever returned.
  if (req.method === 'GET') {
    let rubricVersion: string | null = null;
    let rubricError: string | null = null;
    try {
      const { data, error } = await serviceClient.rpc('active_rubric');
      if (error) rubricError = error.message;
      else {
        const row = Array.isArray(data) ? data[0] : data;
        rubricVersion = row?.version ?? null;
      }
    } catch (e) {
      rubricError = e instanceof Error ? e.message : String(e);
    }

    const caller = classifyCaller(req);
    return json({
      function: 'score-call',
      // Scoring works with the built-in rubric, so readiness turns on the API
      // key alone. rubric.in_use tells you which one would actually grade.
      ok: Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
      rubric_in_use: rubricVersion ?? BUILTIN_RUBRIC.version,
      secrets: {
        ANTHROPIC_API_KEY: Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
        WEBHOOK_SECRET: Boolean(Deno.env.get('WEBHOOK_SECRET')),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
      },
      rubric: { active_version: rubricVersion, error: rubricError },
      scoring: { model: MODEL, effort: EFFORT, auto_score: AUTO_SCORE },
      // Lets you confirm a webhook's credentials are right by replaying its
      // headers here, instead of discovering it when a call silently fails.
      your_credentials: caller.kind === 'webhook'
        ? `accepted (${caller.via})`
        : caller.kind === 'bad-secret'
          ? 'x-webhook-secret was sent but does NOT match WEBHOOK_SECRET'
          : 'no machine credentials (would be treated as a user request)',
    });
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST only' }, 405);

  const caller = classifyCaller(req);
  if (caller.kind === 'bad-secret') {
    return json({ error: 'x-webhook-secret does not match WEBHOOK_SECRET on this project.' }, 401);
  }
  const isWebhook = caller.kind === 'webhook';

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  // A webhook posts { type, table, record, old_record }; the UI posts
  // { recording_id }. Accept both shapes.
  const record = (body.record ?? null) as Record<string, unknown> | null;
  const recordingId = (body.recording_id ?? record?.id) as string | undefined;
  if (!recordingId) return json({ error: 'recording_id is required' }, 400);

  const COLS = 'id, agent_id, transcript, status, title, call_on, duration_seconds, script_id, call_type';
  let rec: {
    id: string; agent_id: string; transcript: string | null; status: string; script_id: string | null;
    call_type: string | null;
  } | null;

  if (isWebhook) {
    if (!AUTO_SCORE) return json({ skipped: 'AUTO_SCORE is off' });
    const { data, error } = await serviceClient
      .from('call_recordings').select(COLS).eq('id', recordingId).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  } else {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

    // Authorization IS this read: a recording the caller may not see comes
    // back null, which is exactly the answer we want.
    const { data, error } = await userClient
      .from('call_recordings').select(COLS).eq('id', recordingId).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  }

  if (!rec) return json({ error: 'Recording not found, or not yours to score.' }, 404);

  if (isWebhook) {
    // The narrow gate that makes the automatic path safe. Every other status —
    // including the 'scoring' and 'scored' updates this function itself
    // writes — exits here. 200 rather than 4xx so the webhook log shows real
    // failures instead of routine no-ops.
    if (rec.status !== 'transcribed') return json({ skipped: `status is ${rec.status}` });
    if (!rec.transcript?.trim()) return json({ skipped: 'no transcript' });
  } else {
    if (!rec.transcript?.trim()) return json({ error: 'This recording has no transcript yet.' }, 409);
    if (rec.status === 'scoring') return json({ error: 'This recording is already being scored.' }, 409);
  }

  const full = rec.transcript!.trim();
  const transcript = full.slice(0, MAX_TRANSCRIPT_CHARS);
  const truncated = full.length > MAX_TRANSCRIPT_CHARS;

  await serviceClient
    .from('call_recordings')
    .update({ status: 'scoring', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', rec.id);

  try {
    // The rubric comes from the database, not from this file. No fallback: if
    // there is no active rubric, fail rather than grade with something other
    // than what the app displays.
    // Database rubric wins when one is active; otherwise fall back to the copy
    // compiled into this function so scoring works before migration 004 is
    // applied. The fallback's version string is prefixed `builtin/` and is
    // written to the score row, so you can always tell which criteria graded
    // a given call.
    let rubric: Rubric = BUILTIN_RUBRIC;
    try {
      const { data, error } = await serviceClient.rpc('active_rubric');
      if (!error) {
        const row = (Array.isArray(data) ? data[0] : data) as Rubric | null;
        if (row?.version) rubric = row;
      }
    } catch {
      // Missing RPC or unreachable table — the built-in rubric stands in.
    }

    const problems = validateRubric(rubric);
    if (problems.length) {
      throw new Error(`Active rubric "${rubric.version}" is invalid: ${problems.join(' ')}`);
    }

    const systemPrompt = buildSystemPrompt(rubric);
    const outputSchema = buildOutputSchema(rubric);

    // The script is per-call, like the transcript — it goes in the user
    // message, never the cached system block, or every script would fork the
    // prompt cache and the rubric would never be read from it again.
    let script: { name: string; content: string } | null = null;
    if (rec.script_id) {
      const { data } = await serviceClient
        .from('scripts')
        .select('name, content')
        .eq('id', rec.script_id)
        .maybeSingle();
      script = data;
    }
    const scriptBlock = script?.content?.trim()
      ? `\n\nThe agent was expected to follow this specific script on this call. Judge how closely ` +
        `they followed it — required points covered, order, disclosures, and language — and factor ` +
        `adherence into your dimension scores (particularly Presentation) and into the summary and ` +
        `coaching_focus. A good-faith adaptation that still hits the script's substance is not itself ` +
        `a violation; skipping a required point or disclosure is.` +
        `\n\n<script name="${script!.name.replace(/"/g, "'")}">\n${script!.content.trim()}\n</script>`
      : '';

    // Per-call metadata, like the transcript and script — goes in the user
    // message, never the cached system block. Without this the model has to
    // infer the product purely from what's said, which calibration showed is
    // unreliable: Medicare-only criteria (doctor/prescription discovery,
    // scope of appointment, network verification) were being applied to
    // ancillary calls that have no such things, dragging every dimension down
    // hard and inflating false compliance findings. An untagged call
    // (call_type is null — not every recording has been categorized) gets no
    // steer either way; the rubric's own product-type language is what
    // handles that case.
    const callTypeLine = rec.call_type === 'medicare'
      ? `\n\nThis call is tagged as a Medicare Advantage / Part D product call.`
      : rec.call_type === 'ancillary'
      ? `\n\nThis call is tagged as an ancillary (non-Medicare) product call — e.g. final expense, ` +
        `dental/vision/hearing, hospital indemnity, or critical illness. Do not apply Medicare-specific ` +
        `criteria or compliance rules (provider/network checks, prescription discovery, scope of ` +
        `appointment, the "not every plan" disclaimer) to this call — they do not apply to this product.`
      : '';

    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! });

    // Prompt cache layout. Render order is tools -> system -> messages, so the
    // breakpoint on the system block caches the whole rubric; the transcript
    // sits after it and varies per call without touching the cached prefix.
    // Everything before that marker must be byte-identical across calls —
    // interpolating the agent's name or today's date up here would give every
    // request its own cache entry and nothing would ever be read.
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      // Thinking is on by default on Opus 5 and its tokens count against
      // max_tokens, so the ceiling above is sized for reasoning + output.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: outputSchema },
      },
      // Opus 5's safety classifiers can decline a request. Without a fallback
      // the call just stops; "default" re-runs it on Anthropic's recommended
      // substitute, routed by refusal category.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content:
            `Score this sales call.${truncated ? '\n\nNOTE: the transcript was truncated for length; score only what is present and say so in the summary.' : ''}` +
            callTypeLine +
            scriptBlock +
            `\n\n<transcript>\n${transcript}\n</transcript>`,
        },
      ],
    });

    const message = await stream.finalMessage();

    // Check stop_reason before touching content. On a refusal, content is
    // empty or partial — indexing it blind throws, and a truncated response
    // would parse as a real score.
    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Scoring was declined by the model's safety classifiers` +
        (message.stop_details?.category ? ` (${message.stop_details.category}).` : '.')
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('Model hit the output limit before finishing. Raise max_tokens or lower effort.');
    }

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Model returned no text block.');
    }

    const parsed = JSON.parse(textBlock.text);

    // The schema guarantees shape, not range: structured outputs don't support
    // JSON Schema numeric bounds, so "0-100" lives in the prompt and is
    // enforced here.
    const dimensions: Record<string, unknown> = {};
    for (const dim of rubric.dimensions) {
      const d = parsed.dimensions?.[dim.key] ?? {};
      dimensions[dim.key] = {
        // Label is stored alongside the score so an old row still renders
        // correctly after the rubric renames or drops that dimension.
        label: dim.label,
        score: clamp(d.score),
        rationale: String(d.rationale ?? ''),
        evidence: String(d.evidence ?? ''),
      };
    }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    // Recompute rather than trusting the model's own boolean — this is the
    // field a manager acts on, and it must follow from the findings.
    const compliancePassed = !findings.some(
      (f: { severity?: string }) => f.severity === 'high' || f.severity === 'critical'
    );

    const usage = message.usage;
    const price = PRICING[MODEL] ?? { input: 0, output: 0, cacheRead: 0 };
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const costUsd =
      (inputTokens * price.input +
        outputTokens * price.output +
        cacheRead * price.cacheRead +
        cacheWrite * price.input * 1.25) / 1_000_000;

    const { data: score, error: insertError } = await serviceClient
      .from('call_scores')
      .insert({
        recording_id: rec.id,
        agent_id: rec.agent_id,
        script_id: rec.script_id,
        overall_score: clamp(parsed.overall_score),
        dimensions,
        compliance_passed: compliancePassed,
        findings,
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        summary: String(parsed.summary ?? ''),
        coaching_focus: String(parsed.coaching_focus ?? ''),
        model: message.model ?? MODEL,
        rubric_version: rubric.version,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cost_usd: Number(costUsd.toFixed(5)),
      })
      .select()
      .single();

    if (insertError) throw new Error(insertError.message);

    await serviceClient
      .from('call_recordings')
      .update({ status: 'scored', updated_at: new Date().toISOString() })
      .eq('id', rec.id);

    return json({
      score,
      cached_tokens: cacheRead,
      cost_usd: score.cost_usd,
      via: isWebhook ? 'webhook' : 'ui',
    });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);

    // Park the row in a state the UI can retry from rather than leaving it
    // stuck on 'scoring' forever.
    await serviceClient
      .from('call_recordings')
      .update({
        status: 'failed',
        error_message: messageText.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rec.id);

    console.error('score-call failed', { recording_id: rec.id, error: messageText });
    return json({ error: messageText }, 500);
  }
});
