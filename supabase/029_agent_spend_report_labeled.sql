-- ============================================================================
-- Lana — migration 029: agent_spend_report() includes label-only agents
--
-- Additive. Run after 028. Safe to re-run.
--
-- Per Ryan 2026-09-20: "Agent" on this report means the same thing it means
-- in the Agent column on Call reviews (views-scoring.js) — a real account's
-- full_name when the call has one, otherwise the free-text agent_name a
-- label-only call (migration 006, someone without a Lana login yet) carries.
-- 028 only looked at public.profiles, so a labeled agent's cost never
-- showed up here even though it shows up everywhere else (scoring_leaderboard
-- and spend_summary, both migration 019, already split into real_agents vs.
-- labeled the same way).
--
-- Grouped by (agent_id/agent_name, team_name) — the same grouping
-- scoring_leaderboard() uses — so an agent whose calls span two different
-- resolved teams shows as two rows rather than silently picking one. team_name
-- is coalesce(call's team_id override, agent's own profile team), matching
-- spend_summary()/scoring_leaderboard(), not the per-call-only value the Call
-- reviews list shows in its Agent column subtext.
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
      r.agent_id,
      r.agent_name,
      p.full_name as profile_name,
      coalesce(rt.name, pt.name) as team_name,
      cs.cost_usd,
      cs.manual_summary_cost_usd,
      cs.manual_summary_generated_at,
      cs.created_at
    from public.call_scores cs
    join public.call_recordings r on r.id = cs.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
    where public.is_admin()
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
