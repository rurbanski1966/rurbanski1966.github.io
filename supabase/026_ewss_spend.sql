-- ============================================================================
-- Lana — migration 026: EWSS Daily and Weekly spend on the Dashboard
--
-- Additive. Run after 025. Safe to re-run.
--
-- Per Ryan 2026-09-20: the EWSS counterparts to 024's smc_daily_spend and
-- 025's smc_weekly_spend — same two cost sources (AI grading, AI
-- review/manual-summary), same team resolution (call's own team_id
-- override, else the agent's profile team), same no-transcription-cost
-- caveat (still nothing tracked anywhere in the schema), just filtered to
-- 'EWSS' instead of 'SMC'.
--
-- New return columns, so this has to DROP the function first — CREATE OR
-- REPLACE can't change a function's return signature (same reason
-- migrations 015, 018, 022, 023, 024 and 025 needed it).
-- ============================================================================

drop function if exists public.my_metrics();

create function public.my_metrics()
returns table (
  daily_ap          numeric,
  daily_spend       numeric,
  smc_daily_spend   numeric,
  ewss_daily_spend  numeric,
  weekly_spend      numeric,
  smc_weekly_spend  numeric,
  ewss_weekly_spend numeric,
  monthly_spend     numeric,
  yearly_spend      numeric,
  month_ap          numeric,
  pace              numeric,
  target_ap         numeric,
  days_elapsed      integer,
  days_in_month     integer,
  month_count       bigint,
  pending_count     bigint
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
  -- Every call_scores row with its resolved team name, so the SMC/EWSS tiles
  -- below are plain filters on this instead of repeating the two joins per
  -- query.
  scored_teamed as (
    select
      cs.cost_usd,
      cs.manual_summary_cost_usd,
      cs.manual_summary_generated_at,
      cs.created_at,
      coalesce(rt.name, pt.name) as team_name
    from public.call_scores cs
    join public.call_recordings r on r.id = cs.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = cs.agent_id
    left join public.teams pt     on pt.id = p.team_id
  )
  select
    agg.daily_ap,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date = b.today
    ), 0) as daily_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and (st.created_at at time zone 'America/Chicago')::date = b.today
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date = b.today
    ), 0) as smc_daily_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and (st.created_at at time zone 'America/Chicago')::date = b.today
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date = b.today
    ), 0) as ewss_daily_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as weekly_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and (st.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as smc_weekly_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and (st.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as ewss_weekly_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores cs
      cross join bounds b
      where cs.manual_summary_generated_at is not null
        and (cs.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as monthly_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores cs
      cross join bounds b
      where cs.manual_summary_generated_at is not null
        and (cs.manual_summary_generated_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0) as yearly_spend,
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
      where agent_id = auth.uid() and status = 'pending') as pending_count
  from agg, days;
$$;

grant execute on function public.my_metrics() to authenticated;
