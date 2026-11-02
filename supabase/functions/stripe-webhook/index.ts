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
//   checkout.session.completed              — card payments, and a card saved
//                                             for autopay (setup mode)
//   checkout.session.async_payment_succeeded — delayed methods, if enabled
//   invoice.paid                            — an autopay invoice was charged
//   invoice.payment_failed                  — an autopay charge was declined
//   invoice.voided, invoice.marked_uncollectible — Stripe gave up on one
// Stripe retries and can send an event twice; stripe_session_id and
// stripe_invoice_id are unique, so a repeat is a no-op.
// ---------------------------------------------------------------------------
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const chicagoToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());

async function stripeApi(path: string, params?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.statusText}`);
  return body;
}

// An admin saved a card through autopay-setup. Make it the customer's
// default for invoices, copy its billing address onto the customer (Stripe
// Tax needs one to tax an invoice), and turn autopay on.
async function handleCardSaved(service: SupabaseClient, s: Record<string, any>) {
  const teamId = s.metadata?.team_id;
  if (s.metadata?.purpose !== 'autopay' || !teamId || !s.setup_intent) {
    return json({ ok: true, ignored: 'setup session not from Lana autopay' });
  }
  try {
    const si = await stripeApi(`setup_intents/${s.setup_intent}?expand[]=payment_method`);
    const pm = si.payment_method;
    if (!pm?.id) throw new Error('setup intent has no payment method');

    const params: Record<string, string> = { 'invoice_settings[default_payment_method]': pm.id };
    const addr = pm.billing_details?.address ?? {};
    for (const k of ['line1', 'line2', 'city', 'state', 'postal_code', 'country']) {
      if (addr[k]) params[`address[${k}]`] = addr[k];
    }
    await stripeApi(`customers/${s.customer}`, params);

    const { data: existing } = await service
      .from('agency_autopay').select('enabled_since').eq('team_id', teamId).maybeSingle();
    const brand = String(pm.card?.brand ?? 'card');
    const { error } = await service.from('agency_autopay').upsert({
      team_id: teamId,
      stripe_customer_id: s.customer,
      payment_method_id: pm.id,
      card_label: `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${pm.card?.last4 ?? '????'}`,
      enabled: true,
      enabled_since: existing?.enabled_since ?? chicagoToday(),
      updated_by: s.metadata?.user_id || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'team_id' });
    if (error) throw new Error(error.message);
    return json({ ok: true, autopay: 'card saved' });
  } catch (err) {
    // 500 so Stripe retries.
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// Autopay invoices (autopay-run). Only invoices Lana created carry
// metadata.purpose = 'autopay'; anything else on the account is ignored.
async function handleInvoice(service: SupabaseClient, event: Record<string, any>) {
  const inv = event.data?.object ?? {};
  const teamId = inv.metadata?.team_id;
  const period = inv.metadata?.period;
  if (inv.metadata?.purpose !== 'autopay' || !teamId || !period) {
    return json({ ok: true, ignored: 'invoice not from Lana autopay' });
  }
  const month = (patch: Record<string, unknown>) =>
    service.from('autopay_invoices')
      .update({ ...patch, stripe_invoice_id: inv.id, updated_at: new Date().toISOString() })
      .eq('team_id', teamId).eq('period', period);

  if (event.type === 'invoice.paid') {
    // The balance is the pre-tax subtotal; Stripe Tax's part is kept beside
    // it, the same split as a Checkout payment.
    const subtotalCents = Number(inv.subtotal ?? 0);
    const paidCents = Number(inv.amount_paid ?? inv.total ?? 0);
    if (subtotalCents <= 0) return json({ ok: true, ignored: 'zero invoice' });
    const paidAt = inv.status_transitions?.paid_at ?? event.created ?? Date.now() / 1000;
    const { error } = await service.from('agency_payments').upsert({
      team_id: teamId,
      kind: 'autopay',
      amount_usd: subtotalCents / 100,
      tax_usd: Math.max(0, paidCents - subtotalCents) / 100,
      stripe_invoice_id: inv.id,
      stripe_payment_intent: typeof inv.payment_intent === 'string' ? inv.payment_intent : null,
      paid_by_email: inv.customer_email ?? null,
      paid_at: new Date(paidAt * 1000).toISOString(),
    }, { onConflict: 'stripe_invoice_id', ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    await month({ status: 'paid', error: null });
    return json({ ok: true });
  }
  if (event.type === 'invoice.payment_failed') {
    await month({ status: 'open', error: 'Card declined. Stripe will retry and email the agency.' });
    return json({ ok: true });
  }
  if (event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
    await month({ status: 'failed', error: 'Stripe stopped retrying this invoice. Pay it by card on this page.' });
    return json({ ok: true });
  }
  return json({ ok: true, ignored: event.type });
}

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
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (typeof type === 'string' && type.startsWith('invoice.')) return handleInvoice(service, event);
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return json({ ok: true, ignored: type });
  }

  const s = event.data?.object ?? {};
  if (s.mode === 'setup') return handleCardSaved(service, s);
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
