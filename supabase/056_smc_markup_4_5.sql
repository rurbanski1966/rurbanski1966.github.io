-- ============================================================================
-- Lana — migration 056: SMC markup 3.5% -> 4.5%, from now on
--
-- Additive. Run after 055. Safe to re-run.
--
-- Per Ryan 2026-11-02: SMC is billed at 4.5% instead of 3.5%, moving forward.
-- A new dated row in team_cost_markups (migration 047): SMC calls graded from
-- the moment this runs carry 4.5%; earlier calls keep what they were billed
-- at. Still folded into each call's cost, never shown as a separate line.
-- ============================================================================

insert into public.team_cost_markups (team_id, markup, effective_from)
select t.id, 1.045, now()
from public.teams t
where t.name = 'SMC'
  and not exists (
    select 1 from public.team_cost_markups m where m.team_id = t.id and m.markup = 1.045
  );

update public.teams set cost_markup = 1.045 where name = 'SMC';
