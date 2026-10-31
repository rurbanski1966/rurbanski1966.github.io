-- ============================================================================
-- Lana — migration 054: SMC markup 3% -> 3.5%, from now on
--
-- Additive. Run after 053. Safe to re-run.
--
-- Per Ryan 2026-10-31: SMC is billed at 3.5% instead of 3%, moving forward.
-- A new dated row in team_cost_markups (migration 047): SMC calls graded from
-- the moment this runs carry 3.5%; earlier calls keep what they were billed
-- at. Still folded into each call's cost, never shown as a separate line.
-- ============================================================================

insert into public.team_cost_markups (team_id, markup, effective_from)
select t.id, 1.035, now()
from public.teams t
where t.name = 'SMC'
  and not exists (
    select 1 from public.team_cost_markups m where m.team_id = t.id and m.markup = 1.035
  );

update public.teams set cost_markup = 1.035 where name = 'SMC';
