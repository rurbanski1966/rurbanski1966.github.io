-- ============================================================================
-- Lana — migration 040: SMC and EWSS year-to-date spend
--
-- Additive. Run after 039. Safe to re-run.
--
-- Per Ryan 2026-10-20: the Dashboard gets SMC Yearly and EWSS Yearly spend
-- tiles beside the org-wide Yearly one — every AI cost since January 1
-- (America/Chicago), split by the same rule as every other figure:
-- ai_cost_events.cost_category (migration 039). An Unassigned yearly figure
-- comes along so SMC + EWSS + Unassigned always adds up to the Yearly total.
--
-- my_metrics() is migration 039's, with three columns added at the end.
-- ============================================================================

drop function if exists public.my_metrics();

create function public.my_metrics()
returns table (
  daily_ap                 numeric,
  daily_spend              numeric,
  smc_daily_spend          numeric,
  ewss_daily_spend         numeric,
  weekly_spend             numeric,
  smc_weekly_spend         numeric,
  ewss_weekly_spend        numeric,
  monthly_spend            numeric,
  smc_monthly_spend        numeric,
  ewss_monthly_spend       numeric,
  yearly_spend             numeric,
  month_ap                 numeric,
  pace                     numeric,
  target_ap                numeric,
  days_elapsed             integer,
  days_in_month            integer,
  month_count              bigint,
  pending_count            bigint,
  unassigned_daily_spend   numeric,
  unassigned_weekly_spend  numeric,
  unassigned_monthly_spend numeric,
  smc_yearly_spend         numeric,
  ewss_yearly_spend        numeric,
  unassigned_yearly_spend  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      (now() at time zone 'America/Chicago')::date                          as today,
      date_trunc('week', (now() at time zone 'America/Chicago'))::date      as week_start,
      (date_trunc('week', (now() at time zone 'America/Chicago'))
        + interval '6 days')::date                                         as week_end,
      date_trunc('month', (now() at time zone 'America/Chicago'))::date     as month_start,
      (date_trunc('month', (now() at time zone 'America/Chicago'))
        + interval '1 month - 1 day')::date                                 as month_end,
      date_trunc('year', (now() at time zone 'America/Chicago'))::date      as year_start,
      (date_trunc('year', (now() at time zone 'America/Chicago'))
        + interval '1 year - 1 day')::date                                  as year_end
  ),
  mine as (
    select s.*, b.today, b.month_start, b.month_end
    from public.submissions s
    cross join bounds b
    where s.agent_id = auth.uid()
      and s.status in ('pending', 'approved')
      and s.submitted_on between b.month_start and b.month_end
  ),
  agg as (
    select
      coalesce(sum(ap_amount) filter (where submitted_on = today), 0) as daily_ap,
      coalesce(sum(ap_amount), 0)                                     as month_ap,
      count(*)                                                        as month_count
    from mine
  ),
  days as (
    select
      public.business_days(month_start, least(today, month_end)) as elapsed,
      public.business_days(month_start, month_end)               as total
    from bounds
  ),
  spend as (
    select
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today), 0) as daily_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today and e.cost_category = 'SMC'), 0) as daily_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today and e.cost_category = 'EWSS'), 0) as daily_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today and e.cost_category = 'Unassigned'), 0) as daily_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end), 0) as weekly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'SMC'), 0) as weekly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'EWSS'), 0) as weekly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'Unassigned'), 0) as weekly_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end), 0) as monthly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'SMC'), 0) as monthly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'EWSS'), 0) as monthly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'Unassigned'), 0) as monthly_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end), 0) as yearly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'SMC'), 0) as yearly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'EWSS'), 0) as yearly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'Unassigned'), 0) as yearly_un
    from bounds b
    left join public.ai_cost_events e on true
  )
  select
    agg.daily_ap,
    spend.daily_all, spend.daily_smc, spend.daily_ewss,
    spend.weekly_all, spend.weekly_smc, spend.weekly_ewss,
    spend.monthly_all, spend.monthly_smc, spend.monthly_ewss,
    spend.yearly_all,
    agg.month_ap,
    case when days.elapsed > 0
      then round(agg.month_ap / days.elapsed * days.total, 2)
      else 0
    end as pace,
    coalesce((
      select g.target_ap from public.goals g, bounds b
      where g.agent_id = auth.uid() and g.period = b.month_start
    ), 0) as target_ap,
    days.elapsed,
    days.total,
    agg.month_count,
    (select count(*) from public.submissions
      where agent_id = auth.uid() and status = 'pending') as pending_count,
    spend.daily_un, spend.weekly_un, spend.monthly_un,
    spend.yearly_smc, spend.yearly_ewss, spend.yearly_un
  from agg, days, spend;
$$;

grant execute on function public.my_metrics() to authenticated;
