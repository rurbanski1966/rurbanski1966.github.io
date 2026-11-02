-- ============================================================================
-- Lana — migration 058: autopay — SBA and SMC charged on the last day of
-- each month
--
-- Additive. Run after 057. Safe to re-run.
--
-- Per Ryan 2026-11-02: SBA's and SMC's balances are invoiced through Stripe
-- on the last day of every month and charged to the card on file
-- automatically. Only admins add or change an agency's card.
--
--   1. agency_autopay — one row per agency with a card on file: the Stripe
--      customer, the saved card (brand + last 4 only; the number never
--      reaches Lana) and whether autopay is on. Written only by the Edge
--      Functions (service role); admins and the agency's own logins read it.
--
--   2. autopay_invoices — one row per agency per month billed. The unique
--      (team_id, period) is what makes a month impossible to charge twice,
--      however many times the job runs.
--
--   3. agency_payments gains kind 'autopay', keyed by stripe_invoice_id,
--      recorded by stripe-webhook when Stripe reports the invoice paid.
--
--   4. agency_balance_for_billing() — agency_balances() for one agency
--      without the caller check, for the scheduled job (service role only).
--
--   5. The schedule: pg_cron calls the autopay-run Edge Function every
--      evening. The function itself decides whether a month is due (the last
--      day of the month, or a missed one), so a skipped evening catches up
--      the next. It proves itself with a random token generated here and
--      kept in a schema the API can't reach; no secret is typed by anyone.
-- ============================================================================

create table if not exists public.agency_autopay (
  team_id             uuid primary key references public.teams (id) on delete cascade,
  stripe_customer_id  text,
  payment_method_id   text,
  card_label          text,
  enabled             boolean not null default false,
  -- The day autopay was first turned on (America/Chicago). Months that ended
  -- before it are never billed automatically.
  enabled_since       date,
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);

create table if not exists public.autopay_invoices (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams (id) on delete restrict,
  period             text not null check (period ~ '^\d{4}-\d{2}$'),
  amount_usd         numeric(12, 2) not null,
  stripe_invoice_id  text unique,
  -- creating: claimed, Stripe calls under way. open: invoice sent, charge
  -- pending or being retried. paid. failed: needs a person (see error).
  -- skipped: nothing (or under $0.50) to bill that month.
  status             text not null check (status in ('creating', 'open', 'paid', 'failed', 'skipped')),
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (team_id, period)
);

alter table public.agency_autopay   enable row level security;
alter table public.autopay_invoices enable row level security;

drop policy if exists agency_autopay_select   on public.agency_autopay;
drop policy if exists autopay_invoices_select on public.autopay_invoices;

create policy agency_autopay_select on public.agency_autopay
  for select to authenticated using (public.is_admin() or team_id = public.my_team_id());

create policy autopay_invoices_select on public.autopay_invoices
  for select to authenticated using (public.is_admin() or team_id = public.my_team_id());


-- ---------------------------------------------------------------------------
-- agency_payments: autopay rows
-- ---------------------------------------------------------------------------
alter table public.agency_payments
  add column if not exists stripe_invoice_id text;

create unique index if not exists agency_payments_invoice_uidx
  on public.agency_payments (stripe_invoice_id) where stripe_invoice_id is not null;

alter table public.agency_payments drop constraint if exists agency_payments_kind_check;
alter table public.agency_payments add constraint agency_payments_kind_check check (
  (kind = 'stripe' and stripe_session_id is not null)
  or (kind = 'write_off' and stripe_session_id is null)
  or (kind = 'autopay' and stripe_invoice_id is not null)
);


-- ---------------------------------------------------------------------------
-- agency_balance_for_billing — same arithmetic as agency_balances()
-- ---------------------------------------------------------------------------
create or replace function public.agency_balance_for_billing(p_team_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select
    round(coalesce((
      select sum(e.cost_usd)
      from public.ai_cost_events e
      join public.teams t on t.name = e.cost_category
      where t.id = p_team_id
        and (t.billing_starts_on is null or e.incurred_on >= t.billing_starts_on)
    ), 0), 2)
    - coalesce((select sum(p.amount_usd) from public.agency_payments p where p.team_id = p_team_id), 0);
$$;

revoke all on function public.agency_balance_for_billing(uuid) from public, anon, authenticated;
grant execute on function public.agency_balance_for_billing(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- The schedule's token
-- ---------------------------------------------------------------------------
create schema if not exists lana_private;
revoke all on schema lana_private from public, anon, authenticated;

create table if not exists lana_private.cron_token (
  id    boolean primary key default true check (id),
  token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into lana_private.cron_token (id) values (true) on conflict (id) do nothing;

create or replace function public.autopay_token_ok(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select token = p_token from lana_private.cron_token), false);
$$;

revoke all on function public.autopay_token_ok(text) from public, anon, authenticated;
grant execute on function public.autopay_token_ok(text) to service_role;


-- ---------------------------------------------------------------------------
-- Every evening at 04:00 UTC: 11 PM Chicago in summer, 10 PM in winter, so
-- always late on the Chicago calendar day the function checks against.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'lana-autopay',
  '0 4 * * *',
  $cron$
    select net.http_post(
      url     := 'https://dnxuzdylyvurbyeyzfxy.supabase.co/functions/v1/autopay-run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-autopay-token', (select token from lana_private.cron_token)
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
