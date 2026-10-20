-- ============================================================================
-- Lana — migration 039: every AI cost, attributed to SMC / EWSS in one place
--
-- Additive. Run after 038. Safe to re-run.
--
-- Per Ryan 2026-10-20: every cost must be categorized as SMC or EWSS and
-- shown under that category on the Dashboard. An audit of the spend
-- functions found four gaps:
--
--   1. The Medicare scorecard's grading cost (call_scorecards.cost_usd,
--      migration 035) was never counted anywhere. Medicare-only calls are
--      graded by the scorecard alone, so their spend was missing from every
--      tile — org-wide, SMC and EWSS.
--   2. The org-wide Daily and Weekly tiles left out the AI review-summary
--      cost that the SMC/EWSS tiles include, so SMC + EWSS could add up to
--      more than "All". spend_summary() (Scorecard page) left it out too.
--   3. A cost on a call with no Agency Assigned and an agent with no team
--      was counted in the org-wide total but in neither SMC nor EWSS, with
--      nothing on screen saying so. It now has its own Unassigned figures.
--   4. my_metrics() resolved the fallback team through call_scores.agent_id
--      (the agent at scoring time) while everything else uses the call's
--      current agent, call_recordings.agent_id (migration 013). Now one rule.
--
-- THE RULE, now defined once in ai_cost_events and nowhere else:
--   team = the call's Agency Assigned (call_recordings.team_id), else the
--          current agent's own team, else Unassigned.
--   A cost is dated by when it was incurred (scored / summarized / graded).
--   A re-scored or re-graded call counts its latest grade only, the rule
--   migration 031 set for rubric scores.
--
-- Transcription (Deepgram) cost is not recorded per call, so it is still not
-- in any figure.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ai_cost_events: one row per AI cost on a call.
--
-- Not readable by app users directly. A view runs with its owner's rights, so
-- it would bypass RLS on the tables under it; only the security-definer
-- functions below read it, and they apply their own checks.
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
  case when rec.team_name in ('SMC', 'EWSS') then rec.team_name else 'Unassigned' end as cost_category
from events e
join rec on rec.recording_id = e.recording_id;

revoke all on public.ai_cost_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- my_metrics: the Dashboard tiles. Same columns as migration 031 plus three
-- Unassigned ones at the end; every spend figure now reads ai_cost_events.
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
  unassigned_monthly_spend numeric
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

      coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end), 0) as yearly_all
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
    spend.daily_un, spend.weekly_un, spend.monthly_un
  from agg, days, spend;
$$;

grant execute on function public.my_metrics() to authenticated;

-- ---------------------------------------------------------------------------
-- agent_spend_report: the Dashboard's per-agent table. Same columns as 031.
-- team_name stays null for Unassigned, which the table already labels.
-- ---------------------------------------------------------------------------
create or replace function public.agent_spend_report()
returns table (
  agent_id      uuid,
  full_name     text,
  team_name     text,
  daily_spend   numeric,
  weekly_spend  numeric,
  monthly_spend numeric,
  yearly_spend  numeric
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
  )
  select
    e.agent_id,
    coalesce(e.profile_name, e.agent_name) as full_name,
    e.team_name,
    coalesce(sum(e.cost_usd) filter (where e.incurred_on = b.today), 0),
    coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.week_start and b.week_end), 0),
    coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.month_start and b.month_end), 0),
    coalesce(sum(e.cost_usd) filter (where e.incurred_on between b.year_start and b.year_end), 0)
  from public.ai_cost_events e
  cross join bounds b
  where public.is_admin()
  group by e.agent_id, e.agent_name, e.profile_name, e.team_name
  order by full_name;
$$;

grant execute on function public.agent_spend_report() to authenticated;

-- ---------------------------------------------------------------------------
-- spend_summary: the Scorecard page's Spend card. Same columns as 031.
-- calls_scored is now the number of calls with any AI cost in the period,
-- and an 'Unassigned' scope is returned alongside each team.
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
    select name as scope from public.teams where name in ('SMC', 'EWSS')
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

-- ---------------------------------------------------------------------------
-- unassigned_cost_calls: the calls behind the Unassigned figure, so an admin
-- can open each one and set its Agency Assigned. Admin-only.
-- ---------------------------------------------------------------------------
create or replace function public.unassigned_cost_calls()
returns table (
  recording_id uuid,
  title        text,
  call_on      date,
  agent_name   text,
  total_cost   numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select e.recording_id, r.title, r.call_on, coalesce(e.profile_name, e.agent_name), sum(e.cost_usd)
  from public.ai_cost_events e
  join public.call_recordings r on r.id = e.recording_id
  where public.is_admin() and e.cost_category = 'Unassigned'
  group by e.recording_id, r.title, r.call_on, e.profile_name, e.agent_name
  order by r.call_on desc;
$$;

grant execute on function public.unassigned_cost_calls() to authenticated;
