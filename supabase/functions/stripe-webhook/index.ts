// ---------------------------------------------------------------------------
// stripe-webhook — Supabase Edge Function (Deno)
//
// The URL Stripe posts to when a Checkout payment finishes. This is the only
// place an agency payment is recorded: a row in agency_payments, which
// agency_balances() subtracts from the balance.
//
// AUTH: Stripe holds no Supabase login, so this is deployed with JWT
// verification OFF (config.toml) and instead checks the Stripe-Signature
// header against STRIPE_WEBHOOK_SECRET (whsec_…). An unsigned or forged
// request is refused before anything is read from it.
//
// Events used (pick these when adding the endpoint in Stripe):
//   checkout.session.completed              — card payments
//   checkout.session.async_payment_succeeded — delayed methods, if enabled
// Stripe retries and can send an event twice; stripe_session_id is unique,
// so a repeat is a no-op.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Reject signatures older than this, so a captured request can't be replayed.
const TOLERANCE_SECONDS = 300;

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

function constantTimeEquals(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe signs `${timestamp}.${raw body}` with HMAC-SHA256.
// https://docs.stripe.com/webhooks#verify-manually
async function verifySignature(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const parts = header.split(',').map(p => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  return sigs.some(s => constantTimeEquals(s, expected));
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'STRIPE_WEBHOOK_SECRET is not set' }, 503);

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('Stripe-Signature'), secret))) {
    return json({ error: 'Bad signature' }, 400);
  }

  const event = JSON.parse(raw);
  const type = event?.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return json({ ok: true, ignored: type });
  }

  const s = event.data?.object ?? {};
  // A completed session can still be unpaid (a bank transfer that hasn't
  // cleared); that arrives later as async_payment_succeeded.
  if (s.payment_status !== 'paid') return json({ ok: true, pending: s.id });

  const teamId = s.metadata?.team_id ?? s.client_reference_id;
  // Not one of Lana's checkouts (e.g. Stripe's "Send test event", or a
  // payment made some other way on the same account). Answered 200 so Stripe
  // doesn't keep retrying something there's nothing to do with.
  if (!teamId || !s.amount_total) return json({ ok: true, ignored: 'no Lana team on this session' });

  // amount_total includes sales tax (Stripe Tax). Only the pre-tax part pays
  // down the balance; the tax is kept beside it (migration 050).
  const taxCents = Number(s.total_details?.amount_tax ?? 0);
  const balanceCents = Number(s.amount_subtotal ?? s.amount_total - taxCents);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { error } = await service.from('agency_payments').upsert({
    team_id: teamId,
    amount_usd: balanceCents / 100,
    tax_usd: taxCents / 100,
    stripe_session_id: s.id,
    stripe_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null,
    paid_by: s.metadata?.user_id || null,
    paid_by_email: s.customer_details?.email ?? s.customer_email ?? null,
    paid_at: new Date((event.created ?? Date.now() / 1000) * 1000).toISOString(),
  }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });

  // A 500 makes Stripe retry, which is what we want if the insert failed.
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
});
