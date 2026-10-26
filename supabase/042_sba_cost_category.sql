-- ============================================================================
-- Lana — migration 042: SBA as a third cost category
--
-- Additive. Run after 041. Safe to re-run.
--
-- Per Ryan 2026-10-26: the Dashboard gets SBA Daily / Weekly / Monthly /
-- Yearly spend tiles beside SMC's and EWSS's, split by the same rule as every
-- other figure (migration 039): the call's Agency Assigned, else the current
-- agent's own team, else Unassigned.
--
--   1. An SBA team is created if there isn't one, so it can be picked as a
--      call's Agency Assigned and as an agent's team.
--   2. ai_cost_events.cost_category now accepts 'SBA'. Before this, an SBA
--      call would have fallen into Unassigned.
--   3. my_metrics() is migration 040's, with four sba_* columns added at the
--      end, so SMC + EWSS + SBA + Unassigned adds up to each All figure.
--   4. spend_summary() (Scorecard page) returns an SBA scope alongside SMC
--      and EWSS.
-- ============================================================================

insert into public.teams (name) values ('SBA')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- ai_cost_events: migration 039's, with SBA added to the category list.
-- ---------------------------------------------------------------------------
create or replace view public.ai_cost_events as
with rec as (
  select
    r.id                        as recording_id,
    r.agent_id,
    r.agent_name,
    p.full_name                 as profile_name,
    coalesce(rt.name, pt.name)  as team_name
  from public.call_recordings r
  left join public.teams rt   on rt.id = r.team_id
  left join public.profiles p on p.id = r.agent_id
  left join public.teams pt   on pt.id = p.team_id
),
events as (
  select 'rubric'::text as source, cs.recording_id, cs.cost_usd, cs.created_at as incurred_at
  from public.call_scores_effective cs
  where cs.cost_usd is not null

  union all
  select 'review_summary', cs.recording_id, cs.manual_summary_cost_usd, cs.manual_summary_generated_at
  from public.call_scores_effective cs
  where cs.manual_summary_cost_usd is not null
    and cs.manual_summary_generated_at is not null

  union all
  select 'scorecard', g.recording_id, g.cost_usd, g.created_at
  from public.call_scorecards g
  where g.cost_usd is not null
    and g.id = (
      select g2.id from public.call_scorecards g2
      where g2.recording_id = g.recording_id
      order by g2.created_at desc, g2.id desc
      limit 1
    )
)
select
  e.source,
  e.recording_id,
  e.cost_usd,
  e.incurred_at,
  (e.incurred_at at time zone 'America/Chicago')::date as incurred_on,
  rec.agent_id,
  rec.agent_name,
  rec.profile_name,
  rec.team_name,
  case when rec.team_name in ('SMC', 'EWSS', 'SBA') then rec.team_name else 'Unassigned' end as cost_category
from events e
join rec on rec.recording_id = e.recording_id;

revoke all on public.ai_cost_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- my_metrics: migration 040's, with four SBA columns at the end.
-- ---------------------------------------------------------------------------
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
  unassigned_yearly_spend  numeric,
  sba_daily_spend          numeric,
  sba_weekly_spend         numeric,
  sba_monthly_spend        numeric,
  sba_yearly_spend         numeric
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
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today and e.cost_category = 'SBA'), 0) as daily_sba,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today and e.cost_category = 'Unassigned'), 0) as daily_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end), 0) as weekly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'SMC'), 0) as weekly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'EWSS'), 0) as weekly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'SBA'), 0) as weekly_sba,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end and e.cost_category = 'Unassigned'), 0) as weekly_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end), 0) as monthly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'SMC'), 0) as monthly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'EWSS'), 0) as monthly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'SBA'), 0) as monthly_sba,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end and e.cost_category = 'Unassigned'), 0) as monthly_un,

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end), 0) as yearly_all,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'SMC'), 0) as yearly_smc,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'EWSS'), 0) as yearly_ewss,
      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end and e.cost_category = 'SBA'), 0) as yearly_sba,
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
    spend.yearly_smc, spend.yearly_ewss, spend.yearly_un,
    spend.daily_sba, spend.weekly_sba, spend.monthly_sba, spend.yearly_sba
  from agg, days, spend;
$$;

grant execute on function public.my_metrics() to authenticated;

-- ---------------------------------------------------------------------------
-- spend_summary: migration 039's, with SBA added to the team scopes.
-- ---------------------------------------------------------------------------
create or replace function public.spend_summary()
returns table (
  scope        text,
  period       text,
  total_cost   numeric,
  calls_scored bigint
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
        + interval '1 month - 1 day')::date                                 as month_end
  ),
  ev as (
    select e.* from public.ai_cost_events e where public.is_admin()
  ),
  scopes as (
    select name as scope from public.teams where name in ('SMC', 'EWSS', 'SBA')
    union select 'Unassigned'
  )
  select 'All'::text, 'day'::text,
    coalesce(sum(ev.cost_usd) filter (where ev.incurred_on = b.today), 0),
    count(distinct ev.recording_id) filter (where ev.incurred_on = b.today)
  from bounds b left join ev on true

  union all
  select 'All', 'week',
    coalesce(sum(ev.cost_usd) filter (where ev.incurred_on between b.week_start and b.week_end), 0),
    count(distinct ev.recording_id) filter (where ev.incurred_on between b.week_start and b.week_end)
  from bounds b left join ev on true

  union all
  select 'All', 'month',
    coalesce(sum(ev.cost_usd) filter (where ev.incurred_on between b.month_start and b.month_end), 0),
    count(distinct ev.recording_id) filter (where ev.incurred_on between b.month_start and b.month_end)
  from bounds b left join ev on true

  union all
  select s.scope, 'week',
    coalesce(sum(ev.cost_usd) filter (
      where ev.cost_category = s.scope and ev.incurred_on between b.week_start and b.week_end), 0),
    count(distinct ev.recording_id) filter (
      where ev.cost_category = s.scope and ev.incurred_on between b.week_start and b.week_end)
  from scopes s cross join bounds b left join ev on true
  group by s.scope, b.week_start, b.week_end

  union all
  select s.scope, 'month',
    coalesce(sum(ev.cost_usd) filter (
      where ev.cost_category = s.scope and ev.incurred_on between b.month_start and b.month_end), 0),
    count(distinct ev.recording_id) filter (
      where ev.cost_category = s.scope and ev.incurred_on between b.month_start and b.month_end)
  from scopes s cross join bounds b left join ev on true
  group by s.scope, b.month_start, b.month_end;
$$;

grant execute on function public.spend_summary() to authenticated;
