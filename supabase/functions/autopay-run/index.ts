// ---------------------------------------------------------------------------
// autopay-run — Supabase Edge Function (Deno)
//
// Called every evening by pg_cron (migration 058). On the last day of the
// month (America/Chicago), each agency with autopay on gets a Stripe invoice
// for its whole balance, sales tax added by Stripe Tax, charged straight to
// its card on file. stripe-webhook records the payment when Stripe reports
// the invoice paid; a declined card is retried by Stripe and emailed to the
// agency.
//
// WHICH MONTH: on the last day, this month; on any other day, last month. A
// month is billed once (autopay_invoices is unique on agency + month), so the
// other evenings are no-ops, and an evening the schedule missed is caught up
// the next. A month that ended before the agency's autopay was turned on is
// never billed.
//
// DOUBLE-CHARGE SAFETY: the month is claimed in autopay_invoices before any
// Stripe call, and every Stripe call carries an idempotency key for that
// agency and month. Anything unexpected leaves the month 'failed' with the
// error for an admin to see; it is never retried blindly.
//
// AUTH: JWT verification is off (config.toml); the caller must send the
// x-autopay-token that pg_cron reads from lana_private.cron_token.
//
// Secrets: STRIPE_SECRET_KEY.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const AUTOPAY_AGENCIES = ['SBA', 'SMC'];
// Stripe's smallest card charge in USD.
const MIN_CENTS = 50;
const TZ = 'America/Chicago';

const pad = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

// The month due tonight and the day it ended, by the Chicago calendar.
function duePeriod(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now); // YYYY-MM-DD
  const [y, m, d] = today.split('-').map(Number);
  if (d === lastDayOf(y, m)) return { period: `${y}-${pad(m)}`, periodEnd: today };
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { period: `${py}-${pad(pm)}`, periodEnd: `${py}-${pad(pm)}-${pad(lastDayOf(py, pm))}` };
}

const monthName = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

async function stripe(key: string, path: string, params: Record<string, string>, idempotencyKey: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  return { ok: res.ok, body };
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'STRIPE_SECRET_KEY is not set' }, 503);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const token = req.headers.get('x-autopay-token') ?? '';
  const { data: tokenOk } = await service.rpc('autopay_token_ok', { p_token: token });
  if (!token || tokenOk !== true) return json({ error: 'Bad token' }, 401);

  const { period, periodEnd } = duePeriod();

  const { data: rows, error: rowsError } = await service
    .from('agency_autopay')
    .select('team_id, stripe_customer_id, payment_method_id, enabled_since, team:teams(name)')
    .eq('enabled', true);
  if (rowsError) return json({ error: rowsError.message }, 500);

  const results: Record<string, string> = {};

  for (const row of rows ?? []) {
    const name = (row.team as { name?: string } | null)?.name ?? '';
    if (!AUTOPAY_AGENCIES.includes(name)) continue;
    if (!row.stripe_customer_id || !row.payment_method_id) { results[name] = 'no card on file'; continue; }
    if (row.enabled_since && row.enabled_since > periodEnd) { results[name] = `autopay started after ${period}`; continue; }

    const { data: already } = await service
      .from('autopay_invoices').select('status').eq('team_id', row.team_id).eq('period', period).maybeSingle();
    if (already) { results[name] = `${period} already ${already.status}`; continue; }

    const { data: balance, error: balError } = await service.rpc('agency_balance_for_billing', { p_team_id: row.team_id });
    if (balError) { results[name] = `balance error: ${balError.message}`; continue; }
    const cents = Math.round(Number(balance ?? 0) * 100);

    // Claim the month. A second run racing this one hits the unique key and
    // stops here.
    const { error: claimError } = await service.from('autopay_invoices').insert({
      team_id: row.team_id,
      period,
      amount_usd: cents / 100,
      status: cents >= MIN_CENTS ? 'creating' : 'skipped',
      error: cents >= MIN_CENTS ? null : cents <= 0 ? 'Nothing owed.' : 'Under the $0.50 card minimum; carries over.',
    });
    if (claimError) { results[name] = `not claimed: ${claimError.message}`; continue; }
    if (cents < MIN_CENTS) { results[name] = 'skipped (nothing to bill)'; continue; }

    const key = `lana-autopay-${row.team_id}-${period}`;
    const fail = async (message: string, invoiceId?: string) => {
      await service.from('autopay_invoices').update({
        status: 'failed', error: message, stripe_invoice_id: invoiceId ?? null, updated_at: new Date().toISOString(),
      }).eq('team_id', row.team_id).eq('period', period);
      results[name] = `failed: ${message}`;
    };

    const inv = await stripe(stripeKey, 'invoices', {
      customer: row.stripe_customer_id,
      collection_method: 'charge_automatically',
      auto_advance: 'true',
      // No default_payment_method here: Stripe charges the customer's own
      // default card, which is the one the agency last set, in Lana or in
      // the Stripe customer portal.
      'automatic_tax[enabled]': 'true',
      pending_invoice_items_behavior: 'exclude',
      description: `${name} — Lana AI call grading, ${monthName(period)}`,
      'metadata[team_id]': row.team_id,
      'metadata[purpose]': 'autopay',
      'metadata[period]': period,
    }, `${key}-invoice`);
    if (!inv.ok) { await fail(`Stripe: ${inv.body?.error?.message ?? 'could not create the invoice'}`); continue; }
    const invoiceId = inv.body.id as string;

    const item = await stripe(stripeKey, 'invoiceitems', {
      customer: row.stripe_customer_id,
      invoice: invoiceId,
      amount: String(cents),
      currency: 'usd',
      tax_behavior: 'exclusive',
      description: `${name} — Lana AI call grading balance`,
    }, `${key}-item`);
    if (!item.ok) { await fail(`Stripe: ${item.body?.error?.message ?? 'could not add the balance'}`, invoiceId); continue; }

    const fin = await stripe(stripeKey, `invoices/${invoiceId}/finalize`, {}, `${key}-finalize`);
    if (!fin.ok) { await fail(`Stripe: ${fin.body?.error?.message ?? 'could not finalize the invoice'}`, invoiceId); continue; }

    await service.from('autopay_invoices').update({
      status: 'open', stripe_invoice_id: invoiceId, updated_at: new Date().toISOString(),
    }).eq('team_id', row.team_id).eq('period', period).eq('status', 'creating');

    // Charge now rather than waiting for Stripe's own attempt about an hour
    // later. A decline is not a failure here: the invoice stays open, Stripe
    // retries it and emails the agency, and stripe-webhook records it once
    // it's paid.
    const charge = await stripe(stripeKey, `invoices/${invoiceId}/pay`, {}, `${key}-pay`);
    if (!charge.ok) {
      await service.from('autopay_invoices').update({
        error: `First charge declined: ${charge.body?.error?.message ?? 'unknown'}. Stripe will retry.`,
        updated_at: new Date().toISOString(),
      }).eq('team_id', row.team_id).eq('period', period);
      results[name] = `invoiced ${cents / 100}, first charge declined`;
      continue;
    }
    results[name] = `invoiced and charged ${cents / 100}`;
  }

  return json({ period, results });
});
