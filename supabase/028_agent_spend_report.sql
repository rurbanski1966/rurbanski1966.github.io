-- ============================================================================
-- Lana — migration 028: per-agent spend report for the Dashboard
--
-- Additive. Run after 027. Safe to re-run.
--
-- Per Ryan 2026-09-20: a breakdown of the same daily/weekly/monthly/yearly
-- spend figures already on the Dashboard (024-027), one row per agent
-- instead of org-wide or per-team, so an admin can drill into which agent
-- is driving a team's number. Same two cost sources as everywhere else —
-- AI grading (call_scores.cost_usd) and AI review/manual-summary
-- (call_scores.manual_summary_cost_usd) — same no-transcription-cost
-- caveat (still nothing tracked anywhere in the schema).
--
-- team_name here is the agent's own profiles.team_id, not the per-call
-- team_id override that 019/024-027 resolve for team-wide totals — this
-- report groups by agent, and a call's cost belongs to whichever agent was
-- actually on it (call_scores.agent_id) regardless of which team's totals
-- that particular call was tagged to count toward.
--
-- Includes every agent with at least one call_scores row ever, active or
-- not — an agent's historical cost shouldn't disappear because they were
-- later deactivated. Admin-only: mirrors spend_summary()'s pattern
-- (migration 014/019) of gating the dollar figures behind is_admin()
-- rather than raising, so a non-admin caller gets rows with zeroed spend
-- instead of an error. The Dashboard only renders this table for admins.
-- ============================================================================

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
      cs.agent_id,
      cs.cost_usd,
      cs.manual_summary_cost_usd,
      cs.manual_summary_generated_at,
      cs.created_at
    from public.call_scores cs
    where public.is_admin()
  )
  select
    p.id as agent_id,
    p.full_name,
    t.name as team_name,
    coalesce((
      select sum(s.cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id and (s.created_at at time zone 'America/Chicago')::date = b.today
    ), 0)
    +
    coalesce((
      select sum(s.manual_summary_cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id and s.manual_summary_generated_at is not null
        and (s.manual_summary_generated_at at time zone 'America/Chicago')::date = b.today
    ), 0) as daily_spend,
    coalesce((
      select sum(s.cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id
        and (s.created_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0)
    +
    coalesce((
      select sum(s.manual_summary_cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id and s.manual_summary_generated_at is not null
        and (s.manual_summary_generated_at at time zone 'America/Chicago')::date between b.week_start and b.week_end
    ), 0) as weekly_spend,
    coalesce((
      select sum(s.cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id
        and (s.created_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0)
    +
    coalesce((
      select sum(s.manual_summary_cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id and s.manual_summary_generated_at is not null
        and (s.manual_summary_generated_at at time zone 'America/Chicago')::date between b.month_start and b.month_end
    ), 0) as monthly_spend,
    coalesce((
      select sum(s.cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id
        and (s.created_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0)
    +
    coalesce((
      select sum(s.manual_summary_cost_usd) from scored s cross join bounds b
      where s.agent_id = p.id and s.manual_summary_generated_at is not null
        and (s.manual_summary_generated_at at time zone 'America/Chicago')::date between b.year_start and b.year_end
    ), 0) as yearly_spend
  from public.profiles p
  left join public.teams t on t.id = p.team_id
  where exists (select 1 from public.call_scores cs where cs.agent_id = p.id)
  order by p.full_name;
$$;

grant execute on function public.agent_spend_report() to authenticated;
