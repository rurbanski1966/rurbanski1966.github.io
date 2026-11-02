-- ============================================================================
-- Lana — migration 057: EWSS markup 0% -> 4.5%, from now on
--
-- Additive. Run after 056. Safe to re-run.
--
-- Per Ryan 2026-11-02: EWSS is billed at 4.5%, moving forward. Until now EWSS
-- had no row in team_cost_markups, so cost_markup_at() fell back to 1 (at
-- cost). A new dated row: EWSS calls graded from the moment this runs carry
-- 4.5%; earlier calls stay at cost. Folded into each call's cost like SBA and
-- SMC, never shown as a separate line.
-- ============================================================================

insert into public.team_cost_markups (team_id, markup, effective_from)
select t.id, 1.045, now()
from public.teams t
where t.name = 'EWSS'
  and not exists (
    select 1 from public.team_cost_markups m where m.team_id = t.id and m.markup = 1.045
  );

update public.teams set cost_markup = 1.045 where name = 'EWSS';
