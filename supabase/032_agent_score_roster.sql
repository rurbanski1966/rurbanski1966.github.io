-- ============================================================================
-- Lana — migration 032: agent score roster for the Analytics redesign
--
-- Additive. Run after 031. Safe to re-run.
--
-- Per Ryan 2026-09-21: the Analytics redesign needs a "bird's-eye" roster —
-- every agent, latest overall score, delta vs the prior period, and a
-- pass/fail flag against the fixed 70 threshold — in one query. Nothing
-- existing does this: agent_spend_report() is dollars, not quality scores,
-- and analytics_trend() only ever returns one agent/team/agency's trend at
-- a time, not every agent side by side.
--
-- Reuses analytics_agents() (migration 030) for identity + team resolution
-- instead of re-deriving it — same real-account-vs-labeled-agent split,
-- same "team" meaning (profile's own team, falling back to a labeled call's
-- tag) as everywhere else in Analytics.
--
-- p_bucket controls what "latest" and "prior" mean (a day, week, month, or
-- quarter) — matches the bucket toggle already on the page. p_team_id
-- optionally scopes the roster to one team, for the "By team" tab.
-- ============================================================================

create or replace function public.agent_score_roster(
  p_bucket  text,
  p_team_id uuid default null
)
returns table (
  agent_id          uuid,
  agent_name        text,
  full_name         text,
  team_id           uuid,
  latest_bucket     date,
  latest_overall    numeric,
  prior_overall     numeric,
  score_delta       numeric,
  latest_calls      bigint,
  latest_critical   bigint,
  latest_high       bigint,
  prior_critical    bigint,
  prior_high        bigint,
  findings_worsened boolean,
  passing           boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      r.agent_id,
      r.agent_name,
      date_trunc(p_bucket, r.call_on)::date as bucket_start,
      s.effective_overall_score as overall_score,
      s.effective_findings as findings
    from public.call_scores_effective s
    join public.call_recordings r on r.id = s.recording_id
    where public.is_admin()
  ),
  findings_flat as (
    select
      coalesce(sc.agent_id::text, 'name:' || sc.agent_name) as identity_key,
      sc.bucket_start,
      f ->> 'severity' as severity
    from scoped sc
    cross join lateral jsonb_array_elements(coalesce(sc.findings, '[]'::jsonb)) as f
    where coalesce((f ->> 'dismissed')::boolean, false) = false
  ),
  per_bucket as (
    select
      coalesce(sc.agent_id::text, 'name:' || sc.agent_name) as identity_key,
      sc.agent_id,
      sc.agent_name,
      sc.bucket_start,
      round(avg(sc.overall_score), 1) as avg_overall,
      count(*) as calls_scored
    from scoped sc
    group by identity_key, sc.agent_id, sc.agent_name, sc.bucket_start
  ),
  find_bucket as (
    select
      identity_key,
      bucket_start,
      count(*) filter (where severity = 'critical') as critical_count,
      count(*) filter (where severity = 'high')     as high_count
    from findings_flat
    group by identity_key, bucket_start
  ),
  ranked as (
    select
      pb.*,
      coalesce(fb.critical_count, 0) as critical_count,
      coalesce(fb.high_count, 0)     as high_count,
      row_number() over (partition by pb.identity_key order by pb.bucket_start desc) as rn
    from per_bucket pb
    left join find_bucket fb
      on fb.identity_key = pb.identity_key and fb.bucket_start = pb.bucket_start
  ),
  latest as (select * from ranked where rn = 1),
  prior  as (select * from ranked where rn = 2)
  select
    a.agent_id,
    a.agent_name,
    a.full_name,
    a.team_id,
    l.bucket_start as latest_bucket,
    l.avg_overall  as latest_overall,
    p.avg_overall  as prior_overall,
    case when p.avg_overall is not null then round(l.avg_overall - p.avg_overall, 1) end as score_delta,
    l.calls_scored     as latest_calls,
    l.critical_count   as latest_critical,
    l.high_count        as latest_high,
    coalesce(p.critical_count, 0) as prior_critical,
    coalesce(p.high_count, 0)     as prior_high,
    (p.identity_key is not null and (l.critical_count > p.critical_count or l.high_count > p.high_count)) as findings_worsened,
    (l.avg_overall >= 70) as passing
  from public.analytics_agents() a
  join latest l
    on l.identity_key = coalesce(a.agent_id::text, 'name:' || a.full_name)
  left join prior p
    on p.identity_key = l.identity_key
  where (p_team_id is null or a.team_id = p_team_id)
  order by a.full_name;
$$;

grant execute on function public.agent_score_roster(text, uuid) to authenticated;
