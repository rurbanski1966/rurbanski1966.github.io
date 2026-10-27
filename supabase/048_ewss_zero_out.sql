-- ============================================================================
-- Lana — migration 048: zero out EWSS's balance (owner's own usage)
--
-- Additive. Run after 047. Safe to re-run.
--
-- Per Ryan 2026-10-27: EWSS owns the platform and already pays the AI bill
-- directly (Anthropic API billing), so EWSS's balance is never paid by card.
-- An admin can zero it out from the Billing page instead.
--
--   1. agency_payments.kind — 'stripe' (card payment, from the webhook) or
--      'write_off' (zeroed out by an admin). A write-off has no Stripe
--      session. The charges themselves are untouched: the write-off is a row
--      for the amount cleared, so the history shows what was cleared, when,
--      and by whom, and the Dashboard's EWSS spend still reads true.
--   2. zero_out_agency_balance(team) — admins only, EWSS only. Records a
--      write-off for the current balance and returns the amount (0 when
--      there was nothing to clear). Locked per team so a double click can't
--      clear it twice.
-- ============================================================================

alter table public.agency_payments
  add column if not exists kind text not null default 'stripe';

alter table public.agency_payments
  alter column stripe_session_id drop not null;

alter table public.agency_payments drop constraint if exists agency_payments_kind_check;
alter table public.agency_payments add constraint agency_payments_kind_check check (
  (kind = 'stripe' and stripe_session_id is not null)
  or (kind = 'write_off' and stripe_session_id is null)
);

create or replace function public.zero_out_agency_balance(p_team_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text;
  v_balance numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can zero out a balance.';
  end if;

  select name into v_name from public.teams where id = p_team_id;
  if v_name is distinct from 'EWSS' then
    raise exception 'Only the EWSS balance can be zeroed out.';
  end if;

  perform pg_advisory_xact_lock(hashtext('zero_out_agency_balance:' || p_team_id::text));

  select b.balance_usd into v_balance
  from public.agency_balances() b
  where b.team_id = p_team_id;

  if coalesce(v_balance, 0) <= 0 then
    return 0;
  end if;

  insert into public.agency_payments (team_id, amount_usd, kind, paid_by, paid_by_email)
  values (
    p_team_id,
    v_balance,
    'write_off',
    auth.uid(),
    (select email from public.profiles where id = auth.uid())
  );

  return v_balance;
end;
$$;

revoke all on function public.zero_out_agency_balance(uuid) from public, anon;
grant execute on function public.zero_out_agency_balance(uuid) to authenticated;
