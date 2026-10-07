-- =====================================================================
-- 賭讀 / StudyBet — 99_enable_notification_cron.sql
-- Calls Part C's Edge Function `tick` every minute (pg_cron + pg_net).
--
-- RUN THIS ONLY AFTER Part C is deployed (tick + send-push exist) and
-- app_config has edge_function_base_url and function_secret (README step 6).
-- Safe to re-run.
--
-- To stop it later:
--   select cron.unschedule('studybet-tick');
-- =====================================================================

create or replace function public.call_tick()
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_base   text;
  v_secret text;
begin
  select value into v_base   from public.app_config where key = 'edge_function_base_url';
  select value into v_secret from public.app_config where key = 'function_secret';
  if coalesce(btrim(v_base), '') = '' or coalesce(btrim(v_secret), '') = '' then
    raise warning 'call_tick: app_config is missing edge_function_base_url or function_secret';
    return null;
  end if;
  return net.http_post(
    url     := rtrim(btrim(v_base), '/') || '/tick',
    body    := jsonb_build_object('source', 'pg_cron', 'at', now()),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_secret,
                                  'x-function-secret', v_secret),
    timeout_milliseconds := 10000);
end $$;

revoke all on function public.call_tick() from public, anon, authenticated;

do $$
begin
  if to_regnamespace('cron') is null then
    raise exception 'pg_cron is not enabled. Run 04_cron_cleanup.sql first, or use the Cloudflare fallback (README-backend.md).';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'net' and p.proname = 'http_post') then
    raise exception 'pg_net is not enabled. Enable it (Database → Extensions → pg_net) or use the Cloudflare fallback.';
  end if;
  if not exists (select 1 from public.app_config where key = 'edge_function_base_url')
     or not exists (select 1 from public.app_config where key = 'function_secret') then
    raise exception 'Fill app_config first (README step 6).';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'studybet-tick';
  perform cron.schedule('studybet-tick', '* * * * *', 'select public.call_tick()');
end $$;

-- Success: this returns one row with schedule '* * * * *' and active = true.
select jobname, schedule, active from cron.job where jobname = 'studybet-tick';
