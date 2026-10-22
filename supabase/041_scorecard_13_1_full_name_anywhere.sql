-- ============================================================================
-- Lana — migration 041: scorecard 13.1 — full name confirmed anywhere
--
-- Additive. Run after 040. Safe to re-run.
--
-- Per Ryan 2026-10-22: 13.1's "Full Name" checkpoint passes if the agent
-- verifies the beneficiary's full name at any point in the call. Agents often
-- confirm the name during the opening or HIPAA verification rather than again
-- at the application step, and that was being marked missed.
--
-- Same pattern as 037: a new scorecard version, copied from 2026-10-15.1 with
-- 13.1's context extended, and the active flag handed over.
-- ============================================================================

insert into public.scorecards (name, version, is_active, definition)
select
  s.name,
  '2026-10-22.1',
  false,
  jsonb_set(s.definition, '{sections}', (
    select jsonb_agg(
      case when sec->>'section_number' = '13' then
        jsonb_set(sec, '{items}', (
          select jsonb_agg(
            case when item->>'id' = '13.1' then
              jsonb_set(item, '{context}', to_jsonb(
                (item->>'context') || ' ' ||
                $ctx$The "Full Name" checkpoint is met if the agent verifies or confirms the beneficiary's full (first and last) name at ANY point in the call: the opening, HIPAA verification, the application, or anywhere else. It does not have to be repeated during the application section. Either the beneficiary stating their full name to the agent, or the agent reciting it and the beneficiary confirming it, counts. Never mark "Full Name" missed because of where in the call it happened.$ctx$
              ))
            else item end
            order by item_ord)
          from jsonb_array_elements(sec->'items') with ordinality as i(item, item_ord)
        ))
      else sec end
      order by sec_ord)
    from jsonb_array_elements(s.definition->'sections') with ordinality as x(sec, sec_ord)
  ))
from public.scorecards s
where s.version = '2026-10-15.1'
  and not exists (select 1 from public.scorecards where version = '2026-10-22.1');

-- Hand the active flag over, but only from the version this replaces.
do $$
begin
  if exists (select 1 from public.scorecards where version = '2026-10-15.1' and is_active) then
    update public.scorecards set is_active = false where version = '2026-10-15.1';
    update public.scorecards set is_active = true  where version = '2026-10-22.1';
  end if;
end $$;
