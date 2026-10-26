-- ============================================================================
-- Lana — migration 045: daily spend per agency, for the Dashboard chart
--
-- Additive. Run after 044. Safe to re-run.
--
-- Per Ryan 2026-10-26: the Dashboard gets a chart of spend per agency over a
-- chosen period. This returns one row per day per cost category (SMC, EWSS,
-- SBA, Unassigned) between p_start and p_end, inclusive — every day, zero
-- included, so the chart never has to guess whether a missing day means $0.
--
-- Reads ai_cost_events, so it is the same billed figure as every tile (SBA's
-- 10% markup included, migration 043) and adds up to the same totals.
-- Visible to the same users as my_metrics()'s spend tiles. The range is
-- capped at 400 days.
-- ============================================================================

create or replace function public.agency_spend_daily(p_start date, p_end date)
returns table (
  day        date,
  category   text,
  total_cost numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select d::date as day
    from generate_series(p_start, least(p_end, p_start + 399), interval '1 day') d
  ),
  cats as (
    select unnest(array['SMC', 'EWSS', 'SBA', 'Unassigned']) as category
  ),
  totals as (
    select e.incurred_on, e.cost_category, sum(e.cost_usd) as total_cost
    from public.ai_cost_events e
    where e.incurred_on between p_start and least(p_end, p_start + 399)
    group by e.incurred_on, e.cost_category
  )
  select d.day, c.category, coalesce(t.total_cost, 0)
  from days d
  cross join cats c
  left join totals t on t.incurred_on = d.day and t.cost_category = c.category
  where auth.uid() is not null
  order by d.day, c.category;
$$;

grant execute on function public.agency_spend_daily(date, date) to authenticated;
