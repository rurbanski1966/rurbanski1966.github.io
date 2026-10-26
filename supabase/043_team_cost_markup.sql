-- ============================================================================
-- Lana — migration 043: per-team cost markup (SBA billed at +10%)
--
-- Additive. Run after 042. Safe to re-run.
--
-- Per Ryan 2026-10-26: every SBA call's AI cost carries a 10% upcharge,
-- folded into the call's own cost rather than shown as a separate line.
--
--   1. teams.cost_markup — the multiplier a team's call costs are billed at.
--      1 for every team except SBA, which is 1.10. Change it here (or with an
--      update on teams) and every figure follows.
--   2. ai_cost_events.cost_usd is now the billed cost: the raw AI cost times
--      the markup of the call's resolved team (Agency Assigned, else the
--      agent's own team — the same rule cost_category uses). raw_cost_usd
--      keeps the actual AI charge. Every Dashboard tile, the per-agent table,
--      the Unassigned list and spend_summary() read this view, so they all
--      include the upcharge with no change of their own.
--   3. scoring_spend() (Scorecard page's "Scoring spend" tile) doesn't read
--      the view, so it applies the same markup itself.
--
-- The stored costs (call_scores.cost_usd, call_scorecards.cost_usd, …) stay
-- the real AI charge. The markup applies to every SBA call, past and future.
-- ============================================================================

alter table public.teams
  add column if not exists cost_markup numeric not null default 1
  check (cost_markup > 0);

update public.teams set cost_markup = 1.10 where name = 'SBA';

-- ---------------------------------------------------------------------------
-- ai_cost_events: migration 042's, with cost_usd marked up. raw_cost_usd is
-- added at the end (a view can only gain columns at the end).
-- ---------------------------------------------------------------------------
create or replace view public.ai_cost_events as
with rec as (
  select
    r.id                        as recording_id,
    r.agent_id,
    r.agent_name,
    p.full_name                 as profile_name,
    coalesce(rt.name, pt.name)  as team_name,
    coalesce(rt.cost_markup, pt.cost_markup, 1) as cost_markup
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
  e.cost_usd * rec.cost_markup as cost_usd,
  e.incurred_at,
  (e.incurred_at at time zone 'America/Chicago')::date as incurred_on,
  rec.agent_id,
  rec.agent_name,
  rec.profile_name,
  rec.team_name,
  case when rec.team_name in ('SMC', 'EWSS', 'SBA') then rec.team_name else 'Unassigned' end as cost_category,
  e.cost_usd as raw_cost_usd
from events e
join rec on rec.recording_id = e.recording_id;

revoke all on public.ai_cost_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- scoring_spend: migration 031's, with each call's rubric cost marked up by
-- its resolved team.
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
    coalesce(sum(s.cost_usd * coalesce(rt.cost_markup, pt.cost_markup, 1)), 0),
    coalesce(round(avg(s.cost_usd * coalesce(rt.cost_markup, pt.cost_markup, 1)), 5), 0),
    coalesce(sum(s.input_tokens), 0),
    coalesce(sum(s.output_tokens), 0),
    coalesce(sum(s.cache_read_tokens), 0)
  from public.call_scores_effective s
  join public.call_recordings r on r.id = s.recording_id
  left join public.teams rt   on rt.id = r.team_id
  left join public.profiles p on p.id = r.agent_id
  left join public.teams pt   on pt.id = p.team_id
  where r.call_on between p_start and p_end
    and public.is_admin();
$$;

grant execute on function public.scoring_spend(date, date) to authenticated;
