-- ============================================================================
-- Lana — migration 037: scorecard 8.1 — benefits the plan does not have
--
-- Additive. Run after 036. Safe to re-run.
--
-- Some plans carry no dental (or vision, or hearing) benefit on their Summary
-- of Benefits. 8.1 was failing those calls for "not presenting dental", when
-- there was no dental to present. This adds the rule to 8.1's context: a
-- benefit the plan does not include is an N/A checkpoint, never a miss.
--
-- The grader has no Summary of Benefits, so when the agent skips a benefit
-- without saying the plan lacks it, the model cannot tell "plan has none"
-- from "agent left it out". That case gets the benefit of the doubt (N/A, so
-- the item can pass) but is flagged for review with a pointer to the SOB, so
-- a reviewer's one-click regrade fails it if the plan did have the benefit.
--
-- Published as a new scorecard version rather than an edit in place: every
-- grade is stamped with the version it was graded against, and that stamp
-- should keep meaning the text the model actually saw.
-- ============================================================================

insert into public.scorecards (name, version, is_active, definition)
select
  s.name,
  '2026-10-15.1',
  false,
  jsonb_set(s.definition, '{sections}', (
    select jsonb_agg(
      case when sec->>'section_number' = '8' then
        jsonb_set(sec, '{items}', (
          select jsonb_agg(
            case when item->>'id' = '8.1' then
              jsonb_set(item, '{context}', to_jsonb(
                (item->>'context') || ' ' ||
                $ctx$Not every plan includes all three. If the plan's Summary of Benefits has no dental benefit (or no vision, or no hearing benefit), there is nothing for the agent to present, and that checkpoint is "na", not "missed"; a benefit the plan does not have never fails this item. Mark it "na" when the agent tells the beneficiary the plan does not include it (e.g. "this plan doesn't have dental coverage"), or when the call otherwise makes clear the plan has none. If the agent never mentions a benefit and nothing in the call shows whether the plan includes it, give the benefit of the doubt: mark that checkpoint "na" (so it does not fail the item), set needs_review to true, and say in review_reason which benefit was never discussed and that the reviewer should check the Summary of Benefits: if the plan does include that benefit, the item should fail.$ctx$
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
where s.version = '2026-10-08.1'
  and not exists (select 1 from public.scorecards where version = '2026-10-15.1');

-- Hand the active flag over, but only from the version this replaces: if an
-- admin has since activated some other scorecard, leave their choice alone.
-- Two statements, in this order, because at most one row may be active.
do $$
begin
  if exists (select 1 from public.scorecards where version = '2026-10-08.1' and is_active) then
    update public.scorecards set is_active = false where version = '2026-10-08.1';
    update public.scorecards set is_active = true  where version = '2026-10-15.1';
  end if;
end $$;
