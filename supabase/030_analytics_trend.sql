-- ============================================================================
-- Lana — migration 030: Analytics tab data layer
--
-- Additive. Run after 029. Safe to re-run.
--
-- Per Ryan 2026-09-21: a new Analytics tab (separate from Leaderboard) that
-- tracks the PROGRESSION of grading over time — overall score, each rubric
-- dimension, and compliance findings — at three rollup levels: the whole
-- agency (no filter), one team, or one agent. No schema change needed:
-- dimensions already live in call_scores.dimensions as jsonb (rubric-defined,
-- not fixed columns — see migration 004's comment on why), and there is no
-- chargeback/retention tracking in this app to build around (confirmed with
-- Ryan: Lana has no chargebacks, and retention isn't tracked here at all).
--
-- Reads through call_scores_effective (migration 007), so an admin's manual
-- override moves the trend the same way it already moves the leaderboard and
-- calibration — a re-graded call should count as re-graded, not as whatever
-- the model said first.
--
-- "Agent" identity matches the rest of the app (scoring_leaderboard,
-- agent_spend_report): a real account when call_recordings.agent_id is set,
-- otherwise the free-text agent_name a label-only call (migration 006)
-- carries — pass p_agent_id for the former, p_agent_name for the latter,
-- never both.
--
-- Team resolution is intentionally NOT the same as spend_summary()'s
-- coalesce(call's team_id override, agent's profile team). This tool tracks
-- who is improving, not which team's ledger a call's cost hit — an agent's
-- coaching history belongs to their own assigned team consistently, not to
-- whichever team a specific call happened to be tagged to. A label-only
-- agent has no profile team at all, so their calls fall back to the call's
-- own team_id tag — the only team information that exists for them.
--
-- p_bucket is 'month' or 'quarter', passed straight to date_trunc (Postgres
-- validates it and raises on anything else — no extra checking needed here).
-- ============================================================================

create or replace function public.analytics_trend(
  p_bucket     text,
  p_agent_id   uuid default null,
  p_agent_name text default null,
  p_team_id    uuid default null
)
returns table (
  bucket_start         date,
  calls_scored         bigint,
  avg_overall_score    numeric,
  dimension_avgs       jsonb,
  compliance_pass_rate numeric,
  findings_by_severity jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      s.effective_overall_score  as overall_score,
      s.effective_dimensions     as dimensions,
      s.effective_compliance_passed as compliance_passed,
      s.effective_findings       as findings,
      date_trunc(p_bucket, r.call_on)::date as bucket_start
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    left join public.profiles p   on p.id = r.agent_id
    where public.is_admin()
      and (p_agent_id is null or r.agent_id = p_agent_id)
      and (p_agent_name is null or (r.agent_id is null and r.agent_name = p_agent_name))
      and (p_team_id is null or coalesce(p.team_id, r.team_id) = p_team_id)
  ),
  dims as (
    select
      sc.bucket_start,
      d.key as dim_key,
      (sc.dimensions -> d.key ->> 'score')::numeric as score
    from scoped sc
    cross join lateral jsonb_object_keys(coalesce(sc.dimensions, '{}'::jsonb)) as d(key)
    where (sc.dimensions -> d.key ->> 'score') is not null
  ),
  dim_agg as (
    select bucket_start, jsonb_object_agg(dim_key, avg_score) as dimension_avgs
    from (
      select bucket_start, dim_key, round(avg(score), 1) as avg_score
      from dims
      group by bucket_start, dim_key
    ) x
    group by bucket_start
  ),
  findings as (
    select sc.bucket_start, f ->> 'severity' as severity
    from scoped sc
    cross join lateral jsonb_array_elements(coalesce(sc.findings, '[]'::jsonb)) as f
    where coalesce((f ->> 'dismissed')::boolean, false) = false
  ),
  find_agg as (
    select bucket_start, jsonb_object_agg(severity, cnt) as findings_by_severity
    from (
      select bucket_start, severity, count(*) as cnt
      from findings
      group by bucket_start, severity
    ) y
    group by bucket_start
  ),
  base as (
    select
      bucket_start,
      count(*) as calls_scored,
      round(avg(overall_score), 1) as avg_overall_score,
      round(avg(case when compliance_passed then 1 else 0 end), 3) as compliance_pass_rate
    from scoped
    group by bucket_start
  )
  select
    b.bucket_start,
    b.calls_scored,
    b.avg_overall_score,
    coalesce(da.dimension_avgs, '{}'::jsonb),
    b.compliance_pass_rate,
    coalesce(fa.findings_by_severity, '{}'::jsonb)
  from base b
  left join dim_agg  da on da.bucket_start = b.bucket_start
  left join find_agg fa on fa.bucket_start = b.bucket_start
  order by b.bucket_start;
$$;

-- Picker data: every identity (real account or label) with at least one
-- scored call, plus its resolved team for the Team dropdown. Same
-- real-vs-labeled split as scoring_leaderboard() and agent_spend_report().
create or replace function public.analytics_agents()
returns table (
  agent_id   uuid,
  agent_name text,
  full_name  text,
  team_id    uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct
    r.agent_id,
    case when r.agent_id is null then r.agent_name else null end as agent_name,
    coalesce(p.full_name, r.agent_name) as full_name,
    coalesce(p.team_id, r.team_id) as team_id
  from public.call_recordings r
  join public.call_scores cs on cs.recording_id = r.id
  left join public.profiles p on p.id = r.agent_id
  where public.is_admin()
  order by full_name;
$$;

grant execute on function public.analytics_trend(text, uuid, text, uuid) to authenticated;
grant execute on function public.analytics_agents()                    to authenticated;
