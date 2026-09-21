-- ============================================================================
-- Lana — migration 031: a re-scored call no longer counts twice everywhere
--
-- Additive. Run after 030. Safe to re-run.
--
-- Per Ryan 2026-09-21: Joshua Khan's Leaderboard average showed 59 with only
-- two calls (73, 72) visible on Call reviews — 73+72=145, average 72.5, not
-- 59. The math only works with a third number in the mix (73+72+32=177,
-- ÷3=59), and there is no third call.
--
-- Root cause: "Re-score call" (available on any already-scored recording —
-- views-scoring.js's #score button) calls score-call, which does a plain
-- INSERT into call_scores every time (see supabase/functions/score-call/
-- index.ts). call_scores.recording_id has never had a unique constraint, so
-- re-scoring a call doesn't replace its score row — it leaves the old one
-- behind and adds a new one. The call detail page already picks the latest
-- row correctly (db.js's scoreForRecording() orders by created_at desc,
-- limit 1) so nobody looking at one call ever saw a problem. But every SQL
-- aggregate reads call_scores directly with a plain join, with no "latest
-- per recording" filter — so a recording scored twice contributes BOTH its
-- old and new score (and BOTH copies of its AI grading cost) to:
-- scoring_leaderboard() (via call_scores_effective — already fixed by the
-- view change below), calibration_by_dimension()/calibration_summary(),
-- spend_summary(), scoring_spend(), my_metrics() (every spend tile on the
-- Dashboard), agent_spend_report(), and analytics_trend()/analytics_agents().
-- This was silently inflating every cost figure built this month, not just
-- Joshua's leaderboard average.
--
-- The fix is centralized: call_scores_effective (migration 007) now filters
-- to only the most recent call_scores row per recording_id, in addition to
-- its existing override resolution. Every function below that previously
-- read raw public.call_scores now reads public.call_scores_effective
-- instead — same columns (the view carries every call_scores column via
-- s.*, plus the effective_* ones), so this is a pure data-source swap with
-- no logic change beyond "count each recording once."
--
-- This does NOT delete the orphaned old score rows — they stay in the table
-- as history, just excluded from every read. If Joshua's original 32 should
-- also be visible somewhere as "what the call was rescored from," that's a
-- separate feature; this migration only stops it from being silently
-- double-counted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- call_scores_effective: now latest-row-per-recording, not every row.
-- ---------------------------------------------------------------------------
create or replace view public.call_scores_effective as
select
  s.*,
  case when s.is_overridden then s.manual_overall_score     else s.overall_score     end as effective_overall_score,
  case when s.is_overridden then s.manual_dimensions        else s.dimensions        end as effective_dimensions,
  case when s.is_overridden then s.manual_compliance_passed else s.compliance_passed end as effective_compliance_passed,
  case when s.is_overridden then s.manual_findings          else s.findings          end as effective_findings
from public.call_scores s
where s.id = (
  select s2.id
  from public.call_scores s2
  where s2.recording_id = s.recording_id
  order by s2.created_at desc, s2.id desc
  limit 1
);

grant select on public.call_scores_effective to authenticated;

-- ---------------------------------------------------------------------------
-- scoring_spend: admin cost summary (migration 003).
-- ---------------------------------------------------------------------------
create or replace function public.scoring_spend(p_start date, p_end date)
returns table (
  calls_scored      bigint,
  total_cost_usd    numeric,
  avg_cost_usd      numeric,
  input_tokens      bigint,
  output_tokens     bigint,
  cache_read_tokens bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    coalesce(sum(s.cost_usd), 0),
    coalesce(round(avg(s.cost_usd), 5), 0),
    coalesce(sum(s.input_tokens), 0),
    coalesce(sum(s.output_tokens), 0),
    coalesce(sum(s.cache_read_tokens), 0)
  from public.call_scores_effective s
  join public.call_recordings r on r.id = s.recording_id
  where r.call_on between p_start and p_end
    and public.is_admin();
$$;

-- ---------------------------------------------------------------------------
-- calibration_by_dimension / calibration_summary (migration 020).
-- ---------------------------------------------------------------------------
create or replace function public.calibration_by_dimension(p_start date, p_end date)
returns table (
  dimension_key text,
  reviews       bigint,
  model_avg     numeric,
  human_avg     numeric,
  delta         numeric,
  mean_abs_gap  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with paired as (
    select
      d.key                                                as dimension_key,
      (s.dimensions -> d.key ->> 'score')::numeric         as model_score,
      (s.manual_dimensions -> d.key ->> 'score')::numeric  as human_score
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    cross join lateral jsonb_object_keys(s.manual_dimensions) as d(key)
    where s.is_overridden
      and r.call_on between p_start and p_end
      and s.dimensions ? d.key
      and (s.manual_dimensions -> d.key ->> 'score') is not null
  )
  select
    dimension_key,
    count(*)                                       as reviews,
    round(avg(model_score), 1)                     as model_avg,
    round(avg(human_score), 1)                     as human_avg,
    round(avg(model_score - human_score), 1)       as delta,
    round(avg(abs(model_score - human_score)), 1)  as mean_abs_gap
  from paired
  group by dimension_key
  order by abs(avg(model_score - human_score)) desc;
$$;

create or replace function public.calibration_summary(p_start date, p_end date)
returns table (
  reviews             bigint,
  model_avg           numeric,
  human_avg           numeric,
  delta               numeric,
  mean_abs_gap        numeric,
  within_5            bigint,
  within_10           bigint,
  compliance_disputed bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    round(avg(s.overall_score), 1),
    round(avg(s.manual_overall_score), 1),
    round(avg(s.overall_score - s.manual_overall_score), 1),
    round(avg(abs(s.overall_score - s.manual_overall_score)), 1),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 5),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 10),
    count(*) filter (where s.manual_compliance_passed is distinct from s.compliance_passed)
  from public.call_scores_effective s
  join public.call_recordings r on r.id = s.recording_id
  where s.is_overridden
    and r.call_on between p_start and p_end;
$$;

-- ---------------------------------------------------------------------------
-- spend_summary: Scorecard's org/team spend rollup (migration 019).
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
  scored as (
    select
      s.cost_usd,
      (s.created_at at time zone 'America/Chicago')::date as scored_on,
      coalesce(rt.name, pt.name) as team_name
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
    where public.is_admin()
  )
  select 'All'::text, 'day'::text,
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on = b.today), 0),
    count(*) filter (where sc.scored_on = b.today)
  from bounds b left join scored sc on true

  union all
  select 'All', 'week',
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on between b.week_start and b.week_end), 0),
    count(*) filter (where sc.scored_on between b.week_start and b.week_end)
  from bounds b left join scored sc on true

  union all
  select 'All', 'month',
    coalesce(sum(sc.cost_usd) filter (where sc.scored_on between b.month_start and b.month_end), 0),
    count(*) filter (where sc.scored_on between b.month_start and b.month_end)
  from bounds b left join scored sc on true

  union all
  select t.name, 'week',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.scored_on between b.week_start and b.week_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.scored_on between b.week_start and b.week_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.week_start, b.week_end

  union all
  select t.name, 'month',
    coalesce(sum(sc.cost_usd) filter (
      where sc.team_name = t.name and sc.scored_on between b.month_start and b.month_end), 0),
    count(*) filter (
      where sc.team_name = t.name and sc.scored_on between b.month_start and b.month_end)
  from public.teams t cross join bounds b left join scored sc on true
  group by t.name, b.month_start, b.month_end;
$$;

-- ---------------------------------------------------------------------------
-- my_metrics: every Dashboard spend tile (migration 027 was the latest of
-- 015/016/017/018/022/023/024/025/026/027 — same body, call_scores swapped
-- for call_scores_effective everywhere it's read).
-- ---------------------------------------------------------------------------
drop function if exists public.my_metrics();

create function public.my_metrics()
returns table (
  daily_ap           numeric,
  daily_spend        numeric,
  smc_daily_spend    numeric,
  ewss_daily_spend   numeric,
  weekly_spend       numeric,
  smc_weekly_spend   numeric,
  ewss_weekly_spend  numeric,
  monthly_spend      numeric,
  smc_monthly_spend  numeric,
  ewss_monthly_spend numeric,
  yearly_spend       numeric,
  month_ap           numeric,
  pace               numeric,
  target_ap          numeric,
  days_elapsed       integer,
  days_in_month      integer,
  month_count        bigint,
  pending_count      bigint
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
  scored_teamed as (
    select
      cs.cost_usd,
      cs.manual_summary_cost_usd,
      cs.manual_summary_generated_at,
      cs.created_at,
      coalesce(rt.name, pt.name) as team_name
    from public.call_scores_effective cs
    join public.call_recordings r on r.id = cs.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = cs.agent_id
    left join public.teams pt     on pt.id = p.team_id
  )
  select
    agg.daily_ap,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores_effective cs
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
      from public.call_scores_effective cs
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
      from public.call_scores_effective cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores_effective cs
      cross join bounds b
      where cs.manual_summary_generated_at is not null
        and (cs.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as monthly_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and (st.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'SMC'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as smc_monthly_spend,
    coalesce((
      select sum(st.cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and (st.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(st.manual_summary_cost_usd)
      from scored_teamed st
      cross join bounds b
      where st.team_name = 'EWSS'
        and st.manual_summary_generated_at is not null
        and (st.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as ewss_monthly_spend,
    coalesce((
      select sum(cs.cost_usd)
      from public.call_scores_effective cs
      cross join bounds b
      where (cs.created_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0)
    +
    coalesce((
      select sum(cs.manual_summary_cost_usd)
      from public.call_scores_effective cs
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

-- ---------------------------------------------------------------------------
-- agent_spend_report: the Dashboard's per-agent spend table (migration 029).
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
  ),
  scored as (
    select
      r.agent_id,
      r.agent_name,
      p.full_name as profile_name,
      coalesce(rt.name, pt.name) as team_name,
      cs.cost_usd,
      cs.manual_summary_cost_usd,
      cs.manual_summary_generated_at,
      cs.created_at
    from public.call_scores_effective cs
    join public.call_recordings r on r.id = cs.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
  )
  select
    sc.agent_id,
    coalesce(sc.profile_name, sc.agent_name) as full_name,
    sc.team_name,
    coalesce(sum(sc.cost_usd) filter (
      where (sc.created_at at time zone 'America/Chicago')::date = b.today
    ), 0)
    +
    coalesce(sum(sc.manual_summary_cost_usd) filter (
      where sc.manual_summary_generated_at is not null
        and (sc.manual_summary_generated_at at time zone 'America/Chicago')::date = b.today
    ), 0) as daily_spend,
    coalesce(sum(sc.cost_usd) filter (
      where (sc.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0)
    +
    coalesce(sum(sc.manual_summary_cost_usd) filter (
      where sc.manual_summary_generated_at is not null
        and (sc.manual_summary_generated_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as weekly_spend,
    coalesce(sum(sc.cost_usd) filter (
      where (sc.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce(sum(sc.manual_summary_cost_usd) filter (
      where sc.manual_summary_generated_at is not null
        and (sc.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as monthly_spend,
    coalesce(sum(sc.cost_usd) filter (
      where (sc.created_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0)
    +
    coalesce(sum(sc.manual_summary_cost_usd) filter (
      where sc.manual_summary_generated_at is not null
        and (sc.manual_summary_generated_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0) as yearly_spend
  from scored sc
  cross join bounds b
  group by sc.agent_id, sc.agent_name, sc.profile_name, sc.team_name
  order by full_name;
$$;

grant execute on function public.agent_spend_report() to authenticated;

-- ---------------------------------------------------------------------------
-- analytics_trend / analytics_agents: the Analytics tab (migration 030).
-- ---------------------------------------------------------------------------
create or replace function public.analytics_trend(
  p_bucket     text,
  p_agent_id   uuid default null,
  p_agent_name text default null,
  p_team_id    uuid default null
)
returns table (
  bucket_start         date,
  calls_scored         bigint,
  avg_overall_score    numeric,
  dimension_avgs       jsonb,
  compliance_pass_rate numeric,
  findings_by_severity jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      s.effective_overall_score  as overall_score,
      s.effective_dimensions     as dimensions,
      s.effective_compliance_passed as compliance_passed,
      s.effective_findings       as findings,
      date_trunc(p_bucket, r.call_on)::date as bucket_start
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    left join public.profiles p   on p.id = r.agent_id
    where public.is_admin()
      and (p_agent_id is null or r.agent_id = p_agent_id)
      and (p_agent_name is null or (r.agent_id is null and r.agent_name = p_agent_name))
      and (p_team_id is null or coalesce(p.team_id, r.team_id) = p_team_id)
  ),
  dims as (
    select
      sc.bucket_start,
      d.key as dim_key,
      (sc.dimensions -> d.key ->> 'score')::numeric as score
    from scoped sc
    cross join lateral jsonb_object_keys(coalesce(sc.dimensions, '{}'::jsonb)) as d(key)
    where (sc.dimensions -> d.key ->> 'score') is not null
  ),
  dim_agg as (
    select bucket_start, jsonb_object_agg(dim_key, avg_score) as dimension_avgs
    from (
      select bucket_start, dim_key, round(avg(score), 1) as avg_score
      from dims
      group by bucket_start, dim_key
    ) x
    group by bucket_start
  ),
  findings as (
    select sc.bucket_start, f ->> 'severity' as severity
    from scoped sc
    cross join lateral jsonb_array_elements(coalesce(sc.findings, '[]'::jsonb)) as f
    where coalesce((f ->> 'dismissed')::boolean, false) = false
  ),
  find_agg as (
    select bucket_start, jsonb_object_agg(severity, cnt) as findings_by_severity
    from (
      select bucket_start, severity, count(*) as cnt
      from findings
      group by bucket_start, severity
    ) y
    group by bucket_start
  ),
  base as (
    select
      bucket_start,
      count(*) as calls_scored,
      round(avg(overall_score), 1) as avg_overall_score,
      round(avg(case when compliance_passed then 1 else 0 end), 3) as compliance_pass_rate
    from scoped
    group by bucket_start
  )
  select
    b.bucket_start,
    b.calls_scored,
    b.avg_overall_score,
    coalesce(da.dimension_avgs, '{}'::jsonb),
    b.compliance_pass_rate,
    coalesce(fa.findings_by_severity, '{}'::jsonb)
  from base b
  left join dim_agg  da on da.bucket_start = b.bucket_start
  left join find_agg fa on fa.bucket_start = b.bucket_start
  order by b.bucket_start;
$$;

create or replace function public.analytics_agents()
returns table (
  agent_id   uuid,
  agent_name text,
  full_name  text,
  team_id    uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct
    r.agent_id,
    case when r.agent_id is null then r.agent_name else null end as agent_name,
    coalesce(p.full_name, r.agent_name) as full_name,
    coalesce(p.team_id, r.team_id) as team_id
  from public.call_recordings r
  join public.call_scores_effective cs on cs.recording_id = r.id
  left join public.profiles p on p.id = r.agent_id
  where public.is_admin()
  order by full_name;
$$;

grant execute on function public.analytics_trend(text, uuid, text, uuid) to authenticated;
grant execute on function public.analytics_agents()                    to authenticated;
