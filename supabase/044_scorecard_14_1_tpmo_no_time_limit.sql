-- ============================================================================
-- Lana — migration 044: scorecard 14.1 — TPMO disclaimer, no time limit
--
-- Additive. Run after 043. Safe to re-run.
--
-- Per Ryan 2026-10-26: the TPMO disclaimer is still required, but the rule
-- that it be read within the first minute (60 seconds) of the call no longer
-- applies. Reading it at any point in the call passes.
--
-- 14.1's context is replaced rather than extended (the old text ended "Mark
-- NON-COMPLIANT if the TPMO disclaimer was not said within the first
-- minute"), and its "Was read during the first minute of the call"
-- checkpoint is removed — an item passes only if every checkpoint is met, so
-- leaving it would still fail late disclaimers.
--
-- Same pattern as 037/041: a new scorecard version, copied from 2026-10-22.1
-- with 14.1 changed, and the active flag handed over. Calls already graded
-- keep their grade; re-grade one to apply the new rule to it.
-- ============================================================================

insert into public.scorecards (name, version, is_active, definition)
select
  s.name,
  '2026-10-26.1',
  false,
  jsonb_set(s.definition, '{sections}', (
    select jsonb_agg(
      case when sec->>'section_number' = '14' then
        jsonb_set(sec, '{items}', (
          select jsonb_agg(
            case when item->>'id' = '14.1' then
              jsonb_set(
                jsonb_set(item, '{context}', to_jsonb(
                  $ctx$The TPMO disclaimer must be said during the call. There is no time limit: it does NOT have to be said in the first minute (60 seconds) of the call, and saying it at any point in the call meets this item. The agent must state the summary of benefits and star rating availability, and that they do not offer every plan available in the area with the specific number of organizations and products. If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted. Mark NON-COMPLIANT only if the TPMO disclaimer was not said at all, or was said without these required parts. Never mark it non-compliant, or flag it for review, because of when in the call it was said.$ctx$::text
                )),
                '{checkpoints}', '["TPMO disclaimer"]'::jsonb
              )
            else item end
            order by item_ord)
          from jsonb_array_elements(sec->'items') with ordinality as i(item, item_ord)
        ))
      else sec end
      order by sec_ord)
    from jsonb_array_elements(s.definition->'sections') with ordinality as x(sec, sec_ord)
  ))
from public.scorecards s
where s.version = '2026-10-22.1'
  and not exists (select 1 from public.scorecards where version = '2026-10-26.1');

-- Hand the active flag over, but only from the version this replaces.
do $$
begin
  if exists (select 1 from public.scorecards where version = '2026-10-22.1' and is_active) then
    update public.scorecards set is_active = false where version = '2026-10-22.1';
    update public.scorecards set is_active = true  where version = '2026-10-26.1';
  end if;
end $$;
