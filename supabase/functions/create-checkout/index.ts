// ---------------------------------------------------------------------------
// create-checkout — Supabase Edge Function (Deno)
//
// Starts a Stripe Checkout payment for an agency's balance and returns the
// Stripe-hosted page URL for the browser to go to. Card details never touch
// Lana; Stripe collects them on its own page.
//
// The amount is never taken from the request. The function reads the balance
// itself through agency_balances() on a JWT-scoped client, so RLS decides
// which agency the caller may pay for (their own; admins any), and the
// figure charged is the server's, not one the browser could edit.
//
// Nothing is marked paid here. That happens only in stripe-webhook, after
// Stripe reports the payment completed.
//
// Secrets: STRIPE_SECRET_KEY (sk_test_… or sk_live_…). Optional APP_URL,
// the address Stripe sends people back to (default the live site).
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Stripe's smallest card charge in USD.
const MIN_CENTS = 50;

const APP_URL = (Deno.env.get('APP_URL') ?? 'https://rurbanski1966.github.io/').replace(/\/?$/, '/');

// Send people back where they came from when that's the app itself (the live
// site or a local dev server); anything else gets the live site. Never an
// arbitrary Origin, which would make this an open redirect.
function returnBase(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return `${origin}/`;
  return APP_URL;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'Payments are not set up yet (STRIPE_SECRET_KEY is missing).' }, 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body: pay own agency */ }

  // Only agencies this caller is allowed to see come back, so a team_id for
  // someone else's agency simply isn't found.
  const { data: balances, error: balError } = await userClient.rpc('agency_balances');
  if (balError) return json({ error: balError.message }, 400);

  const { data: me } = await userClient
    .from('profiles').select('team_id, full_name').eq('id', userData.user.id).maybeSingle();

  const teamId = String(body.team_id ?? me?.team_id ?? '');
  const agency = (balances ?? []).find((b: { team_id: string }) => b.team_id === teamId);
  if (!agency) return json({ error: 'Your login is not in an agency that can be billed.' }, 403);

  const cents = Math.round(Number(agency.balance_usd) * 100);
  if (cents < MIN_CENTS) {
    return json({ error: cents <= 0 ? `${agency.team_name} has nothing to pay.` : 'Balances under $0.50 can’t be paid by card.' }, 400);
  }

  const base = returnBase(req);
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': `${agency.team_name} — Lana AI call grading balance`,
    success_url: `${base}?checkout=success#/billing`,
    cancel_url: `${base}?checkout=cancelled#/billing`,
    client_reference_id: agency.team_id,
    'metadata[team_id]': agency.team_id,
    'metadata[user_id]': userData.user.id,
    'payment_intent_data[metadata][team_id]': agency.team_id,
    'payment_intent_data[description]': `${agency.team_name} Lana balance`,
  });
  if (userData.user.email) form.set('customer_email', userData.user.email);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const session = await res.json();
  if (!res.ok) return json({ error: `Stripe: ${session?.error?.message ?? res.statusText}` }, 502);

  return json({ url: session.url });
});
