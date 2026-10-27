-- ============================================================================
-- Lana — migration 047: dated cost markups (SMC +2.5% from now on)
--
-- Additive. Run after 046. Safe to re-run.
--
-- Per Ryan 2026-10-26: SMC is billed at a 2.5% markup on all call grading
-- MOVING FORWARD, folded into each call's cost like SBA's (never shown as a
-- separate line). Migration 043's teams.cost_markup applies to every call
-- ever made, so a markup now needs a start time:
--
--   1. team_cost_markups — (team, markup, effective_from). A cost is billed at
--      the markup in effect when it was incurred (the grade's created_at);
--      before a team's first row, 1. Change a markup by inserting a new row,
--      never by editing an old one, or past bills change.
--   2. SBA's 1.10 is carried over from 2000-01-01, so it still covers all of
--      SBA's calls, past and future — no change to any SBA figure.
--   3. SMC 1.025 starts at the moment this migration runs. Earlier SMC calls
--      keep their old cost.
--   4. ai_cost_events and scoring_spend() use cost_markup_at(), so every
--      Dashboard figure, the spend chart and Billing balances follow.
--      teams.cost_markup stays as the CURRENT markup, for reference.
-- ============================================================================

create table if not exists public.team_cost_markups (
  team_id        uuid not null references public.teams (id) on delete cascade,
  markup         numeric not null check (markup > 0),
  effective_from timestamptz not null,
  primary key (team_id, effective_from)
);

alter table public.team_cost_markups enable row level security;

-- Same visibility as teams.cost_markup: the browser needs it to show a
-- call's billed cost. Writes are SQL-editor only.
drop policy if exists team_cost_markups_read on public.team_cost_markups;
create policy team_cost_markups_read on public.team_cost_markups
  for select using (auth.uid() is not null);

-- Carry every existing markup (SBA 1.10) over as always-in-effect.
insert into public.team_cost_markups (team_id, markup, effective_from)
select id, cost_markup, '2000-01-01'::timestamptz
from public.teams
where cost_markup <> 1
on conflict do nothing;

-- SMC +2.5% from now. Skipped on a re-run so the start time doesn't move.
insert into public.team_cost_markups (team_id, markup, effective_from)
select t.id, 1.025, now()
from public.teams t
where t.name = 'SMC'
  and not exists (
    select 1 from public.team_cost_markups m where m.team_id = t.id and m.markup = 1.025
  );

update public.teams set cost_markup = 1.025 where name = 'SMC';

create or replace function public.cost_markup_at(p_team uuid, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.markup
    from public.team_cost_markups m
    where m.team_id = p_team and m.effective_from <= p_at
    order by m.effective_from desc
    limit 1
  ), 1);
$$;

grant execute on function public.cost_markup_at(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- ai_cost_events: migration 043's, with the markup looked up by time.
-- Same columns, same order.
-- ---------------------------------------------------------------------------
create or replace view public.ai_cost_events as
with rec as (
  select
    r.id                        as recording_id,
    r.agent_id,
    r.agent_name,
    p.full_name                 as profile_name,
    coalesce(rt.name, pt.name)  as team_name,
    coalesce(rt.id, pt.id)      as team_id
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
  e.cost_usd * public.cost_markup_at(rec.team_id, e.incurred_at) as cost_usd,
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
-- scoring_spend: migration 043's, markup by the score's time.
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
    coalesce(sum(s.cost_usd * public.cost_markup_at(coalesce(rt.id, pt.id), s.created_at)), 0),
    coalesce(round(avg(s.cost_usd * public.cost_markup_at(coalesce(rt.id, pt.id), s.created_at)), 5), 0),
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
