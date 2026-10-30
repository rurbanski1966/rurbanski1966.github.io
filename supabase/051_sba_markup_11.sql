-- ============================================================================
-- Lana — migration 051: SBA markup 10% -> 11%, from now on
--
-- Additive. Run after 050. Safe to re-run.
--
-- Per Ryan 2026-10-30: SBA is billed at 11% instead of 10%. A new dated row
-- in team_cost_markups (migration 047), so SBA calls graded from the moment
-- this runs carry 11%; calls graded before it keep 10%, and nothing already
-- billed or paid moves. Still folded into each call's cost, never a separate
-- line. teams.cost_markup is the current markup, for reference.
-- ============================================================================

insert into public.team_cost_markups (team_id, markup, effective_from)
select t.id, 1.11, now()
from public.teams t
where t.name = 'SBA'
  and not exists (
    select 1 from public.team_cost_markups m where m.team_id = t.id and m.markup = 1.11
  );

update public.teams set cost_markup = 1.11 where name = 'SBA';
