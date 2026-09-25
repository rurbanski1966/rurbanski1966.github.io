-- ============================================================================
-- Lana — migration 033: filter Calibration by call type (Ancillary/Medicare)
--
-- Additive. Run after 032. Safe to re-run.
--
-- Per Ryan 2026-09-25: "has the AI learned enough to grade ancillary sales
-- the way we grade them" — the real answer lives in Calibration (model vs.
-- human agreement on manually-reviewed calls), but calibration_summary()/
-- calibration_by_dimension() only ever filtered by date range, mixing
-- ancillary and medicare calls together. There is no training loop that
-- makes the model "learn" from past overrides (each call is graded fresh
-- against the current rubric text — see score-call/index.ts), so the only
-- way to answer this honestly is to measure current agreement specifically
-- on ancillary calls, not infer it from a number that includes medicare too.
--
-- p_call_type is nullable and defaults to null (both types, matching
-- existing behavior exactly) so this is a pure additive filter, not a
-- breaking change to the two existing call sites.
--
-- Both have to be DROP + CREATE, not CREATE OR REPLACE: adding a third
-- parameter changes the signature, and Postgres would keep the old
-- 2-argument version around as a second overload rather than replacing it —
-- then a call passing only p_start/p_end becomes ambiguous between the two
-- (both become eligible candidates once the new one's third parameter has a
-- default), and errors instead of picking one.
-- ============================================================================

drop function if exists public.calibration_by_dimension(date, date);

create function public.calibration_by_dimension(
  p_start     date,
  p_end       date,
  p_call_type text default null
)
returns table (
  dimension_key text,
  reviews       bigint,
  model_avg     numeric,
  human_avg     numeric,
  delta         numeric,
  mean_abs_gap  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with paired as (
    select
      d.key                                                as dimension_key,
      (s.dimensions -> d.key ->> 'score')::numeric         as model_score,
      (s.manual_dimensions -> d.key ->> 'score')::numeric  as human_score
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    cross join lateral jsonb_object_keys(s.manual_dimensions) as d(key)
    where s.is_overridden
      and r.call_on between p_start and p_end
      and (p_call_type is null or r.call_type = p_call_type)
      and s.dimensions ? d.key
      and (s.manual_dimensions -> d.key ->> 'score') is not null
  )
  select
    dimension_key,
    count(*)                                       as reviews,
    round(avg(model_score), 1)                     as model_avg,
    round(avg(human_score), 1)                     as human_avg,
    round(avg(model_score - human_score), 1)       as delta,
    round(avg(abs(model_score - human_score)), 1)  as mean_abs_gap
  from paired
  group by dimension_key
  order by abs(avg(model_score - human_score)) desc;
$$;

drop function if exists public.calibration_summary(date, date);

create function public.calibration_summary(
  p_start     date,
  p_end       date,
  p_call_type text default null
)
returns table (
  reviews             bigint,
  model_avg           numeric,
  human_avg           numeric,
  delta               numeric,
  mean_abs_gap        numeric,
  within_5            bigint,
  within_10           bigint,
  compliance_disputed bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*),
    round(avg(s.overall_score), 1),
    round(avg(s.manual_overall_score), 1),
    round(avg(s.overall_score - s.manual_overall_score), 1),
    round(avg(abs(s.overall_score - s.manual_overall_score)), 1),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 5),
    count(*) filter (where abs(s.overall_score - s.manual_overall_score) <= 10),
    count(*) filter (where s.manual_compliance_passed is distinct from s.compliance_passed)
  from public.call_scores_effective s
  join public.call_recordings r on r.id = s.recording_id
  where s.is_overridden
    and r.call_on between p_start and p_end
    and (p_call_type is null or r.call_type = p_call_type);
$$;

grant execute on function public.calibration_by_dimension(date, date, text) to authenticated;
grant execute on function public.calibration_summary(date, date, text)      to authenticated;
