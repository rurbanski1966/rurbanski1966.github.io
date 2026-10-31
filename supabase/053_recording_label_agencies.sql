-- ============================================================================
-- Lana — migration 053: which agency each typed-in agent name belongs to
--
-- Additive. Run after 052. Safe to re-run.
--
-- Per Ryan 2026-10-30: Call reviews gets an Agency filter, and picking an
-- agency narrows the Agent dropdown to that agency's agents. Accounts carry
-- their agency on their profile; agents typed in by name (no login) don't,
-- so they belong to whichever agencies their calls were assigned to. This
-- returns those (name, agency) pairs, distinct. Admin-only, like
-- recording_agent_names().
-- ============================================================================

create or replace function public.recording_label_agencies()
returns table (agent_name text, team_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct r.agent_name, r.team_id
  from public.call_recordings r
  where r.agent_id is null
    and r.agent_name is not null
    and r.team_id is not null
    and public.is_admin();
$$;

grant execute on function public.recording_label_agencies() to authenticated;
