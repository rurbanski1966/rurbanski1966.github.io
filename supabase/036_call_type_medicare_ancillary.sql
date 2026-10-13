-- ============================================================================
-- Lana — migration 036: Medicare + Ancillary call type
--
-- Additive. Run after 035. Safe to re-run.
--
-- A third call type for a call that sells both on one recording. On such a
-- call the Medicare scorecard grades the Medicare portion and the coaching
-- rubric (By dimension) grades the ancillary portion. A Medicare-only call
-- is graded by the scorecard alone.
-- ============================================================================

alter table public.call_recordings drop constraint if exists call_recordings_call_type_check;

alter table public.call_recordings
  add constraint call_recordings_call_type_check
  check (call_type is null or call_type in ('ancillary', 'medicare', 'medicare_ancillary'));

-- ----------------------------------------------------------------------------
-- Detecting the ancillary sale. A Medicare plan is not paid for by bank draft
-- on the call; an ancillary product is. So a Medicare call on which a routing
-- number and an account number come up is a Medicare + Ancillary call.
--
-- Runs only when the transcript itself arrives or changes, so an admin who
-- sets the call type by hand afterwards is not overruled. It only ever moves
-- 'medicare' to 'medicare_ancillary': an Ancillary or untagged call is left
-- alone. BEFORE, so the webhook that starts grading already sees the type.
-- ----------------------------------------------------------------------------
create or replace function public.transcript_has_bank_draft(p_transcript text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    p_transcript ~* '\mrouting\M' and p_transcript ~* '\m(account|checking|savings)\M',
    false);
$$;

create or replace function public.call_recordings_detect_ancillary()
returns trigger
language plpgsql
as $$
begin
  if new.call_type = 'medicare'
     and (tg_op = 'INSERT' or new.transcript is distinct from old.transcript)
     and public.transcript_has_bank_draft(new.transcript) then
    new.call_type := 'medicare_ancillary';
  end if;
  return new;
end;
$$;

drop trigger if exists call_recordings_detect_ancillary on public.call_recordings;
create trigger call_recordings_detect_ancillary
  before insert or update on public.call_recordings
  for each row execute function public.call_recordings_detect_ancillary();

-- Medicare calls already transcribed before this migration.
update public.call_recordings
   set call_type = 'medicare_ancillary'
 where call_type = 'medicare'
   and public.transcript_has_bank_draft(transcript);
