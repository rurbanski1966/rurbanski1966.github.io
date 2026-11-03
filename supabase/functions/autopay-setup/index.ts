// ---------------------------------------------------------------------------
// autopay-setup — Supabase Edge Function (Deno)
//
// Admins only. Saves a card on file for an agency (SBA or SMC) so autopay-run
// can charge its balance on the last day of each month (migration 058).
//
//   { team_id, action: 'setup' }   → { url } of a Stripe Checkout page in
//                                    setup mode: the admin enters the card
//                                    there, nothing is charged. stripe-webhook
//                                    stores the card and turns autopay on.
//   { team_id, action: 'disable' } → autopay off. The card stays saved at
//                                    Stripe; 'setup' again turns it back on.
//
// The agency gets one Stripe customer, created here the first time and kept
// in agency_autopay. The card number never reaches Lana.
//
// Secrets: STRIPE_SECRET_KEY. Optional APP_URL (as in create-checkout).
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

const AUTOPAY_AGENCIES = ['SBA', 'SMC'];

const APP_URL = (Deno.env.get('APP_URL') ?? 'https://rurbanski1966.github.io/').replace(/\/?$/, '/');

// Same rule as create-checkout: back to a local dev server or the live site,
// never an arbitrary Origin.
function returnBase(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return `${origin}/`;
  return APP_URL;
}

async function stripe(key: string, path: string, params: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST', headers, body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.statusText}`);
  return body;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'Payments are not set up yet (STRIPE_SECRET_KEY is missing).' }, 503);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

  const { data: isAdmin, error: adminError } = await userClient.rpc('is_admin');
  if (adminError) return json({ error: adminError.message }, 403);
  if (!isAdmin) return json({ error: 'Only an admin can set up autopay.' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const teamId = String(body.team_id ?? '');
  const action = String(body.action ?? 'setup');

  const service = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: team } = await service.from('teams').select('id, name').eq('id', teamId).maybeSingle();
  if (!team || !AUTOPAY_AGENCIES.includes(team.name)) {
    return json({ error: 'Autopay is only for SBA and SMC.' }, 400);
  }

  const { data: existing } = await service
    .from('agency_autopay').select('*').eq('team_id', team.id).maybeSingle();

  if (action === 'disable') {
    const { error } = await service.from('agency_autopay').upsert({
      team_id: team.id,
      enabled: false,
      updated_by: userData.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'team_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, enabled: false });
  }
  if (action !== 'setup') return json({ error: `Unknown action "${action}"` }, 400);

  // Billing contact (migration 059): who Stripe sends receipts and declined-
  // card notices to.
  const contact: Record<string, string> = { name: existing?.billing_name || `${team.name} (Lana)` };
  if (existing?.billing_email) contact.email = existing.billing_email;

  try {
    let customerId = existing?.stripe_customer_id as string | undefined;
    if (customerId) {
      await stripe(stripeKey, `customers/${customerId}`, contact);
    } else {
      const customer = await stripe(stripeKey, 'customers', {
        ...contact,
        'metadata[team_id]': team.id,
        'metadata[lana_account]': team.name,
      }, `lana-customer-${team.id}-v2`);
      customerId = customer.id as string;
      const { error } = await service.from('agency_autopay').upsert({
        team_id: team.id,
        stripe_customer_id: customerId,
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'team_id' });
      if (error) throw new Error(error.message);
    }

    const base = returnBase(req);
    const session = await stripe(stripeKey, 'checkout/sessions', {
      mode: 'setup',
      customer: customerId,
      'payment_method_types[0]': 'card',
      billing_address_collection: 'required',
      success_url: `${base}?autopay=success#/billing`,
      cancel_url: `${base}?autopay=cancelled#/billing`,
      client_reference_id: team.id,
      'metadata[team_id]': team.id,
      'metadata[purpose]': 'autopay',
      'metadata[user_id]': userData.user.id,
      'setup_intent_data[metadata][team_id]': team.id,
    });
    return json({ url: session.url });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
