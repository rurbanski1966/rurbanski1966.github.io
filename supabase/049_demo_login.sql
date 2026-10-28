-- ============================================================================
-- Lana — migration 049: demo (test) logins that see every tab but no data
--
-- Additive. Run after 048. Safe to re-run.
--
-- Per Ryan 2026-10-28: a test login that can sign in and click through every
-- tab, with every recording, name, score, sale, cost and manual entry hidden,
-- and no way to change anything. Nothing changes for any other login.
--
--   1. profiles.is_demo — marks the login. Set from Admin → Agents (Role:
--      "Demo"). In the database a demo login is a 'dialer' (the role with the
--      least access, and one no leaderboard or agent roster lists), so it
--      never shows up among real agents.
--   2. demo_guard() — PostgREST's pre-request hook: it runs before EVERY API
--      request. For a demo login it refuses everything except reading its own
--      profile (needed to sign in). This is the real lock: it covers every
--      table, view and function at once, including the leaderboards and spend
--      functions that bypass RLS, and every Edge Function that reads data as
--      the caller (scoring, billing, admin-users). For everyone else it is
--      one primary-key lookup and returns.
--   3. Storage: a restrictive policy so a demo login can't upload or read any
--      file (skipped with a notice if this project doesn't allow policy
--      changes on storage from the SQL Editor; demo logins still can't read
--      anyone's recordings, since those are keyed by uploader).
--
-- The browser side (public/js/db.js) answers every read with an empty result
-- for a demo login, so the tabs render empty instead of erroring.
--
-- To undo the hook entirely:
--   alter role authenticator reset pgrst.db_pre_request;
--   notify pgrst, 'reload config';
-- ============================================================================

alter table public.profiles
  add column if not exists is_demo boolean not null default false;

create or replace function public.is_demo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_demo from public.profiles where id = auth.uid()), false);
$$;

grant execute on function public.is_demo() to anon, authenticated;

create or replace function public.demo_guard()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_demo() then
    return;
  end if;

  -- Signing in reads the caller's own profile (RLS limits a non-admin to
  -- their own row).
  if current_setting('request.method', true) in ('GET', 'HEAD')
     and current_setting('request.path', true) = '/profiles' then
    return;
  end if;

  raise sqlstate 'PT403' using message = 'Demo login: no data is shown and changes are turned off.';
end;
$$;

grant execute on function public.demo_guard() to anon, authenticated;

alter role authenticator set pgrst.db_pre_request = 'public.demo_guard';
notify pgrst, 'reload config';

do $$
begin
  execute 'drop policy if exists demo_no_storage on storage.objects';
  execute 'create policy demo_no_storage on storage.objects as restrictive for all to authenticated
             using (not public.is_demo()) with check (not public.is_demo())';
exception when insufficient_privilege then
  raise notice 'Skipped the storage policy (no permission on storage.objects). Everything else applied.';
end;
$$;
