-- =====================================================================
-- 賭讀 / StudyBet — 04_cron_cleanup.sql
-- * Nightly purge at 03:30 Asia/Taipei (= 19:30 UTC; pg_cron runs in UTC)
-- * Hourly expiry of 7-day-old settlement proposals
-- * Proof-expiry hand-off for Part C's Edge Function `tick`:
--     1. rpc('list_expired_proofs')            → [{task_id, proof_path}]
--     2. storage.from('proofs').remove(paths)   (with SUPABASE_SERVICE_ROLE_KEY)
--     3. rpc('mark_proofs_expired', {p_task_ids})
--   SQL never deletes storage files itself: Supabase blocks direct deletes from
--   storage.objects because they would orphan the file.
-- Run after 03_storage.sql. Safe to re-run.
-- =====================================================================

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'pg_cron could not be enabled (%). Use the Cloudflare fallback in README-backend.md.', sqlerrm;
end $$;

-- Earlier versions of this file stored a service role key here. Never again.
delete from public.app_config where key in ('project_url', 'service_role_key');

-- ---------------------------------------------------------------------
-- Proof expiry (service_role only)
-- ---------------------------------------------------------------------

-- Proof files older than p_older_than that still have to be deleted:
--   * tasks whose proof_path is set and not yet flagged proof_expired
--     (age = completed_at, or created_at if never completed), and
--   * stray files in the bucket older than p_older_than with no such task row
--     (uploaded but never used, or the task/room is gone). task_id is parsed
--     from the file name and may no longer exist.
-- Refuses intervals under 1 day so a typo can't wipe fresh proofs.
create or replace function public.list_expired_proofs(p_older_than interval default '30 days')
returns table (task_id uuid, proof_path text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'BAD_INTERVAL';
  end if;

  return query
    select t.id, t.proof_path
    from public.tasks t
    where t.proof_path is not null and not t.proof_expired
      and coalesce(t.completed_at, t.created_at) < now() - p_older_than;

  if to_regclass('storage.objects') is not null then
    return query execute $q$
      select split_part(split_part(o.name, '/', 2), '.', 1)::uuid, o.name
      from storage.objects o
      where o.bucket_id = 'proofs'
        and o.created_at < now() - $1
        and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
        and not exists (select 1 from public.tasks t
                        where t.proof_path = o.name and not t.proof_expired)
        and not exists (select 1 from public.tasks t      -- never touch an active task's upload
                        where t.id::text = split_part(split_part(o.name, '/', 2), '.', 1)   -- text compare: no cast before the regex filter
                          and t.status = 'active' and t.deleted_at is null)
    $q$ using p_older_than;
  end if;
end $$;

-- Call after the files were removed. Flags the tasks; unknown ids are ignored.
-- proof_path is kept so history can say "proof expired". Returns rows flagged.
create or replace function public.mark_proofs_expired(p_task_ids uuid[])
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v int;
begin
  update public.tasks
     set proof_expired = true
   where id = any(coalesce(p_task_ids, '{}'))
     and proof_path is not null and not proof_expired;
  get diagnostics v = row_count;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Nightly purge (pg_cron)
-- ---------------------------------------------------------------------
-- Old notification and bookkeeping rows only; storage files are Part C's job (above).
create or replace function public.nightly_cleanup()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_outbox int;
  v_expired int;
begin
  delete from public.notification_outbox where sent_at is not null and sent_at < now() - interval '14 days';
  get diagnostics v_outbox = row_count;

  delete from public.pairing_attempts   where attempted_at < now() - interval '1 day';
  delete from public.daily_reminder_log where local_date   < current_date - 60;
  v_expired := public.expire_stale_settlements(null);

  return jsonb_build_object('outbox_purged', v_outbox, 'settlements_expired', v_expired, 'ran_at', now());
end $$;

-- ---------------------------------------------------------------------
-- Privileges: service_role only
-- ---------------------------------------------------------------------
revoke all on function public.list_expired_proofs(interval) from public, anon, authenticated;
revoke all on function public.mark_proofs_expired(uuid[])    from public, anon, authenticated;
revoke all on function public.nightly_cleanup()              from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.list_expired_proofs(interval),
                              public.mark_proofs_expired(uuid[]),
                              public.nightly_cleanup()            -- for the Cloudflare fallback
      to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Schedules (re-runnable: old jobs with the same name are removed first)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regnamespace('cron') is null then
    raise warning 'pg_cron not available: jobs NOT scheduled. See README-backend.md "Fallbacks".';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job
   where jobname in ('studybet-nightly-cleanup', 'studybet-expire-settlements');

  perform cron.schedule('studybet-nightly-cleanup',    '30 19 * * *', 'select public.nightly_cleanup()');
  perform cron.schedule('studybet-expire-settlements', '7 * * * *',   'select public.expire_stale_settlements(null)');
end $$;
