-- ============================================================================
-- Lana — migration 046: agency balances and Stripe payments
--
-- Additive. Run after 045. Safe to re-run.
--
-- Per Ryan 2026-10-26: each agency (SMC, EWSS, SBA) owes its AI grading cost,
-- and any user in that agency can sign in and pay the balance by card
-- through Stripe.
--
--   1. agency_payments — one row per completed Stripe Checkout payment.
--      Written ONLY by the stripe-webhook Edge Function (service role), after
--      Stripe has confirmed the money moved. There is no insert/update policy,
--      so nobody can mark their own agency paid from the browser.
--   2. teams.billing_starts_on — optional. Costs incurred before this date are
--      not billed. Null (the default) bills every cost on record.
--   3. agency_balances() — per agency: charges (billed AI cost from
--      ai_cost_events, so SBA's 10% markup is included), payments, and the
--      balance due. Admins see every agency; everyone else sees only their
--      own. A negative balance is a credit (e.g. two people paid at once).
--
-- Unassigned costs belong to no agency and are not billed to anyone.
-- ============================================================================

alter table public.teams
  add column if not exists billing_starts_on date;

create table if not exists public.agency_payments (
  id                    uuid primary key default gen_random_uuid(),
  team_id               uuid not null references public.teams (id) on delete restrict,
  amount_usd            numeric(12, 2) not null check (amount_usd > 0),
  stripe_session_id     text not null unique,
  stripe_payment_intent text,
  paid_by               uuid references public.profiles (id) on delete set null,
  paid_by_email         text,
  paid_at               timestamptz not null default now()
);

create index if not exists agency_payments_team_idx on public.agency_payments (team_id, paid_at desc);

alter table public.agency_payments enable row level security;

-- Same reason as is_admin(): reading the caller's team through a definer
-- function keeps a policy that consults profiles from recursing.
create or replace function public.my_team_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id from public.profiles where id = auth.uid() and active;
$$;

grant execute on function public.my_team_id() to authenticated;

drop policy if exists agency_payments_select on public.agency_payments;
create policy agency_payments_select on public.agency_payments
  for select using (public.is_admin() or team_id = public.my_team_id());

-- ---------------------------------------------------------------------------
-- agency_balances
-- ---------------------------------------------------------------------------
create or replace function public.agency_balances()
returns table (
  team_id         uuid,
  team_name       text,
  charges_usd     numeric,
  paid_usd        numeric,
  balance_usd     numeric,
  last_paid_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with charges as (
    select t.id as team_id, sum(e.cost_usd) as total
    from public.ai_cost_events e
    join public.teams t on t.name = e.cost_category
    where t.billing_starts_on is null or e.incurred_on >= t.billing_starts_on
    group by t.id
  ),
  paid as (
    select p.team_id, sum(p.amount_usd) as total, max(p.paid_at) as last_paid_at
    from public.agency_payments p
    group by p.team_id
  )
  select
    t.id,
    t.name,
    round(coalesce(c.total, 0), 2),
    coalesce(p.total, 0),
    round(coalesce(c.total, 0), 2) - coalesce(p.total, 0),
    p.last_paid_at
  from public.teams t
  left join charges c on c.team_id = t.id
  left join paid p    on p.team_id = t.id
  where t.name in ('SMC', 'EWSS', 'SBA')
    and (public.is_admin() or t.id = public.my_team_id())
  order by array_position(array['SMC', 'EWSS', 'SBA'], t.name);
$$;

grant execute on function public.agency_balances() to authenticated;
