// ---------------------------------------------------------------------------
// enrollhere-webhook — Supabase Edge Function (Deno)
//
// The URL EnrollHere posts to when a call is dispositioned as a sale.
//
// STAGE 1 (this version): capture only. Every authorized request is written
// to public.enrollhere_events exactly as received (migration 038) and
// answered 200. Nothing is created in call_recordings yet — EnrollHere's
// payload format is not published, so the mapping (recording URL → audio,
// client name → title, agent → profile) is built once real events are on
// file to build it against.
//
// AUTH: EnrollHere will not hold a Supabase login, so this function must be
// deployed with JWT verification OFF and checks its own shared token
// instead, ENROLLHERE_WEBHOOK_TOKEN. Accepted in any of the places a vendor
// webhook form usually lets you put one:
//   ?token=...                      on the URL (works with every vendor)
//   x-webhook-token: ...            header
//   Authorization: Bearer ...       header
//
// GET with a valid token answers {ok:true}, for vendors that test a URL with
// a GET before saving it.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

// Generous for a JSON event; a vendor sending the audio itself in the body
// would blow past this, and that is a format we'd want to know about rather
// than silently store.
const MAX_BODY_BYTES = 1_000_000;

// Never stored: anything that carries a credential.
const DROP_HEADERS = new Set(['authorization', 'cookie', 'apikey', 'x-webhook-token']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Length-independent compare so a wrong token can't be narrowed down by
// timing the response. Same as the other functions.
function constantTimeEquals(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function providedToken(req: Request, url: URL) {
  return url.searchParams.get('token')
    ?? req.headers.get('x-webhook-token')
    ?? ((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || null);
}

function parseBody(raw: string, contentType: string): unknown {
  if (!raw.trim()) return null;
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  // Tried regardless of content type: plenty of senders post JSON as
  // text/plain or with no content type at all.
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

Deno.serve(async req => {
  const url = new URL(req.url);
  const expected = Deno.env.get('ENROLLHERE_WEBHOOK_TOKEN');
  if (!expected) {
    return json({ error: 'ENROLLHERE_WEBHOOK_TOKEN is not set on this project.' }, 500);
  }
  if (!constantTimeEquals(providedToken(req, url), expected)) {
    return json({ error: 'Missing or wrong token.' }, 401);
  }

  if (req.method === 'GET') return json({ ok: true, function: 'enrollhere-webhook' });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ error: `Body is larger than ${MAX_BODY_BYTES} bytes.` }, 413);
  }

  const contentType = req.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!DROP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });

  const serviceClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await serviceClient
    .from('enrollhere_events')
    .insert({
      content_type: contentType || null,
      payload: parseBody(raw, contentType),
      raw_body: raw,
      headers,
    })
    .select('id')
    .single();

  // A 5xx tells a sender that retries to try again later, which is what we
  // want if the insert failed — the event is not on file.
  if (error) return json({ error: `Could not store the event: ${error.message}` }, 500);
  return json({ ok: true, id: data.id });
});
