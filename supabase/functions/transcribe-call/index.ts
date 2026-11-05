// ---------------------------------------------------------------------------
// transcribe-call — Supabase Edge Function (Deno)
//
// Turns stored audio into text. Claude has no audio input, so scoring needs a
// transcript; this is the optional half that produces one. Without a
// DEEPGRAM_API_KEY it returns a clear error and the manual paste path in the
// UI still works end to end.
//
// TWO WAYS IN, and they authorize differently:
//
//   1. From the UI button — carries the user's JWT. The row is read through
//      that JWT so RLS decides whether this user may touch this recording.
//
//   2. From a Database Webhook — fires on INSERT, has no user session. It
//      proves itself with a shared secret header instead, and the row is read
//      with the service role. Postgres already established the row exists and
//      who owns it, so there is nothing for RLS to decide.
//
// Swapping providers means replacing transcribe() and nothing else — its whole
// contract is: signed URL in, { text, segments } out. segments is null when
// the provider gave no per-utterance timing (or wasn't diarized) — the
// transcript still works, it just can't be seeked to a specific line.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

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

// Accepts the shared header OR the service role key Supabase already attaches
// to webhook calls, so a correctly-created webhook works with nothing to keep
// manually in sync. A wrong secret is reported as a wrong secret rather than
// falling through to a misleading "missing Authorization header".
function classifyCaller(req: Request) {
  const providedSecret = req.headers.get('x-webhook-secret');

  if (constantTimeEquals(providedSecret, Deno.env.get('WEBHOOK_SECRET'))) {
    return { kind: 'webhook' as const, via: 'shared-secret' };
  }
  if (constantTimeEquals(bearer(req.headers.get('Authorization')), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
    return { kind: 'webhook' as const, via: 'service-role' };
  }
  if (providedSecret) return { kind: 'bad-secret' as const, via: 'shared-secret' };
  return { kind: 'user' as const, via: 'jwt' };
}

// part: which recording of the call the line is from (0 = the first), so the
// player knows which file to seek. Absent on single-recording calls.
type Segment = { start: number; end: number; speaker: number; text: string; part?: number };

// The line between two recordings of one call (migration 061). It has no
// "Name:" prefix, so the transcript view shows it as its own plain line, and
// the graders' instructions say what it means.
const partMarker = (i: number, n: number) =>
  `--- Call dropped. Follow-up call (recording ${i + 1} of ${n}) continues the same call ---`;

// Each recording transcribed on its own, then joined in call order. Line
// timings stay relative to their own recording; `part` says which. If any
// part came back without timings, the joined call has none either.
function joinParts(parts: { text: string; segments: Segment[] | null }[]) {
  if (parts.length === 1) return parts[0];
  const n = parts.length;
  const text = parts.map((p, i) => (i === 0 ? p.text : `${partMarker(i, n)}\n${p.text}`)).join('\n');
  if (parts.some(p => !p.segments)) return { text, segments: null };
  const segments = parts.flatMap((p, i) => [
    ...(i === 0 ? [] : [{ start: 0, end: 0, speaker: -1, text: partMarker(i, n), part: i }]),
    ...p.segments!.map(s => ({ ...s, part: i })),
  ]);
  return { text, segments };
}

async function transcribe(audioUrl: string): Promise<{ text: string; segments: Segment[] | null }> {
  const key = Deno.env.get('DEEPGRAM_API_KEY');
  if (!key) {
    throw new Error(
      'No transcription provider configured. Set DEEPGRAM_API_KEY, or paste the transcript manually.'
    );
  }

  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: audioUrl }),
  });

  if (!res.ok) {
    throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const utterances = data?.results?.utterances;

  // Speaker labels matter — the rubric grades the agent, not the prospect.
  // Keep each utterance's start time too: it's what lets the transcript view
  // seek the audio player to the line a coaching quote came from, one line
  // of text mapping to one array entry in the same order.
  if (Array.isArray(utterances) && utterances.length > 0) {
    const segments: Segment[] = utterances.map(
      (u: { start?: number; end?: number; speaker?: number; transcript?: string }) => ({
        start: u.start ?? 0,
        end: u.end ?? 0,
        speaker: u.speaker ?? 0,
        text: u.transcript ?? '',
      })
    );
    const text = segments.map(s => `Speaker ${s.speaker}: ${s.text}`.trim()).join('\n');
    return { text, segments };
  }

  // An undiarized transcript still scores, just worse — better than failing.
  // There's no per-line timing to align to, so no segments.
  const flat = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof flat === 'string' && flat.trim()) return { text: flat.trim(), segments: null };

  throw new Error('Transcription returned no text. The audio may be silent or unreadable.');
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // GET = config self-check. Booleans only; no secret values are returned.
  if (req.method === 'GET') {
    const caller = classifyCaller(req);
    return json({
      function: 'transcribe-call',
      ok: Boolean(Deno.env.get('DEEPGRAM_API_KEY')),
      secrets: {
        DEEPGRAM_API_KEY: Boolean(Deno.env.get('DEEPGRAM_API_KEY')),
        WEBHOOK_SECRET: Boolean(Deno.env.get('WEBHOOK_SECRET')),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
      },
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

  // A webhook posts { type, table, record: {...} }; the UI posts
  // { recording_id }. Accept both shapes.
  const record = (body.record ?? null) as Record<string, unknown> | null;
  const recordingId = (body.recording_id ?? record?.id) as string | undefined;
  if (!recordingId) return json({ error: 'recording_id is required' }, 400);

  let rec: {
    id: string; storage_path: string | null; extra_storage_paths: string[] | null;
    status: string; transcript: string | null;
  } | null;

  if (isWebhook) {
    const { data, error } = await serviceClient
      .from('call_recordings')
      .select('id, storage_path, extra_storage_paths, status, transcript')
      .eq('id', recordingId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  } else {
    // Interactive call: authorization is the RLS-scoped read.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

    const { data, error } = await userClient
      .from('call_recordings')
      .select('id, storage_path, extra_storage_paths, status, transcript')
      .eq('id', recordingId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 400);
    rec = data;
  }

  if (!rec) return json({ error: 'Recording not found, or not yours.' }, 404);

  // Webhook fires on every insert, including transcript-only rows that have no
  // audio and rows a person is already working on. Skipping quietly with 200
  // keeps those out of the webhook's failure log — a 4xx here would show up as
  // a broken integration rather than the no-op it is.
  if (isWebhook) {
    if (!rec.storage_path) return json({ skipped: 'no audio on this row' });
    if (rec.transcript) return json({ skipped: 'already has a transcript' });
    if (rec.status !== 'uploaded') return json({ skipped: `status is ${rec.status}` });
  } else {
    if (!rec.storage_path) return json({ error: 'This recording has no audio file.' }, 409);
    if (rec.status === 'transcribing') return json({ error: 'Already transcribing.' }, 409);
  }

  await serviceClient
    .from('call_recordings')
    .update({ status: 'transcribing', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', rec.id);

  try {
    // The bucket is private, so hand the provider a short-lived signed URL
    // rather than making the object public or streaming 100 MB through here.
    // Every recording of the call (migration 061), transcribed side by side.
    const paths = [rec.storage_path!, ...(rec.extra_storage_paths ?? [])];
    const parts = await Promise.all(paths.map(async (path, i) => {
      const { data: signed, error: signError } = await serviceClient
        .storage.from('call-recordings')
        .createSignedUrl(path, 3600);
      if (signError || !signed?.signedUrl) {
        throw new Error(signError?.message ?? 'Could not sign the audio URL.');
      }
      try {
        return await transcribe(signed.signedUrl);
      } catch (err) {
        if (paths.length === 1) throw err;
        throw new Error(`Recording ${i + 1} of ${paths.length}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));

    const { text: transcript, segments } = joinParts(parts);

    await serviceClient
      .from('call_recordings')
      .update({
        transcript,
        transcript_segments: segments,
        transcript_source: 'deepgram',
        status: 'transcribed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', rec.id);

    return json({ ok: true, characters: transcript.length, recordings: paths.length, via: isWebhook ? 'webhook' : 'ui' });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);

    await serviceClient
      .from('call_recordings')
      .update({
        status: 'failed',
        error_message: messageText.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rec.id);

    console.error('transcribe-call failed', { recording_id: rec.id, error: messageText });
    return json({ error: messageText }, 500);
  }
});
