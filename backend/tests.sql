-- =====================================================================
-- 賭讀 / StudyBet — tests.sql
-- Run in the Supabase SQL Editor AFTER 01–06. No extensions needed.
-- Simulates two (and more) anonymous users by switching to role
-- "authenticated" and setting request.jwt.claims, exactly like PostgREST.
--
-- Output: one row per test (PASS / FAIL) and a final SUMMARY row whose
-- detail says "failures: 0" when everything passed.
-- The test room and its data are deleted at the end; pushes are not sent
-- (studybet.disable_push = on) and other rooms are never touched.
-- Leaves a tiny schema "studybet_test" behind; remove it any time with:
--   drop schema studybet_test cascade;
-- =====================================================================

drop schema if exists studybet_test cascade;   -- rebuilt every run
create schema studybet_test;
create table studybet_test.results (
  n      serial primary key,
  name   text not null,
  ok     boolean not null,
  detail text
);

-- Run p_sql as user p_uid with role p_role ('authenticated' = signed-in app
-- user, 'anon' = no session). Returns 'OK:<result>' or 'ERR:<message>'.
create or replace function studybet_test.run_as(p_uid uuid, p_sql text, p_role text default 'authenticated')
returns text
language plpgsql
as $$
declare
  v_res text;
begin
  if p_role not in ('authenticated', 'anon') then
    raise exception 'run_as: bad role %', p_role;
  end if;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid, 'role', p_role, 'is_anonymous', true)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_res;
    v_res := 'OK:' || coalesce(v_res, '');
  exception when others then
    v_res := 'ERR:' || sqlerrm;
  end;
  reset role;
  return v_res;
end $$;

-- Error code of a run_as result: raised message, or the soft-error body
-- that join_room / create_room return (HTTP 400 through PostgREST).
create or replace function studybet_test.err(r text)
returns text
language plpgsql
as $$
declare
  j jsonb;
begin
  if r like 'ERR:%' then
    return substr(r, 5);
  end if;
  if r like 'OK:{%' then
    j := substr(r, 4)::jsonb;
    if j ->> 'code' = 'P0001' and j ? 'message' then
      return j ->> 'message';
    end if;
  end if;
  return null;
end $$;

create or replace function studybet_test.j(r text)
returns jsonb
language sql
as $$
  select case when r like 'OK:{%' or r like 'OK:[%' then substr(r, 4)::jsonb end
$$;

create or replace function studybet_test.chk(p_name text, p_ok boolean, p_detail text default null)
returns void
language sql
as $$
  insert into studybet_test.results(name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail)
$$;

create or replace function studybet_test.new_task(p_uid uuid, p_title text, p_value int,
                                                 p_in interval default '1 day', p_proof bool default false)
returns uuid
language plpgsql
as $$
declare
  r text;
begin
  r := studybet_test.run_as(p_uid, format(
         'select to_jsonb(public.create_task(%L, %s, %L::timestamptz, %L))::text',
         p_title, p_value, now() + p_in, p_proof));
  if r not like 'OK:%' then
    raise exception 'new_task(%) failed: %', p_title, r;
  end if;
  return (substr(r, 4)::jsonb ->> 'id')::uuid;
end $$;

create or replace function studybet_test.state(p_uid uuid)
returns jsonb
language sql
as $$
  select studybet_test.j(studybet_test.run_as(p_uid, 'select public.get_state()::text'))
$$;

-- ---------------------------------------------------------------------
do $$
declare
  u1 uuid := gen_random_uuid();   -- "Ming", slot 1
  u2 uuid := gen_random_uuid();   -- "Hua", slot 2
  u3 uuid := gen_random_uuid();   -- third user / reclaimer
  u4 uuid := gen_random_uuid();   -- rate-limit victim
  v_code text := 'test-' || substr(md5(random()::text), 1, 12);
  v_room uuid;
  r text;
  j jsonb;
  i int;
  t_a uuid; t_b uuid; t_c uuid; t_ab uuid; t_od uuid; t_late uuid; t_proof uuid; t_del uuid; t_soon uuid;
  t_fresh uuid; t_old_proof uuid;
  u5 uuid := gen_random_uuid();   -- batch 2 room: "Ann", slot 1
  u6 uuid := gen_random_uuid();   -- batch 2 room: "Bo", slot 2
  v_room2 uuid;
  x1 uuid; x2 uuid; x3 uuid; x4 uuid;
  v_fn text;
  v_sid uuid;
  v_conf timestamptz;
  v_n int;
begin
  perform set_config('studybet.disable_push', 'on', true);

  begin
    -- ================= Pairing =================
    r := studybet_test.run_as(u1, format('select public.create_room(%L, %L)::text', 'short', 'Ming'));
    perform studybet_test.chk('pairing: code shorter than 8 rejected', studybet_test.err(r) = 'CODE_TOO_SHORT', r);

    r := studybet_test.run_as(u1, format('select public.create_room(%L, %L)::text', v_code, 'Ming'));
    j := studybet_test.j(r);
    v_room := (j -> 'room' ->> 'id')::uuid;
    perform studybet_test.chk('pairing: create_room makes caller slot 1',
      v_room is not null and (j -> 'member' ->> 'slot')::int = 1, r);

    perform studybet_test.chk('pairing: code stored as bcrypt hash, not plain text',
      (select code_hash like '$2%' and code_hash <> v_code from public.rooms where id = v_room), null);

    r := studybet_test.run_as(u1, format('select public.create_room(%L, %L)::text', v_code || 'x', 'Ming'));
    perform studybet_test.chk('pairing: second room for same user rejected', studybet_test.err(r) = 'ALREADY_IN_ROOM', r);

    r := studybet_test.run_as(u2, format('select public.join_room(%L, %L)::text', v_code || '-wrong', 'Hua'));
    perform studybet_test.chk('pairing: wrong code → BAD_CODE', studybet_test.err(r) = 'BAD_CODE', r);

    r := studybet_test.run_as(u2, format('select public.join_room(%L, %L)::text', v_code, 'Hua'));
    j := studybet_test.j(r);
    perform studybet_test.chk('pairing: join_room fills slot 2',
      (j ->> 'slot')::int = 2 and (j ->> 'id')::uuid = u2, r);

    r := studybet_test.run_as(u2, format('select public.join_room(%L, %L)::text', v_code, '七個字的名字啊'));
    perform studybet_test.chk('pairing: display name over 6 chars rejected', studybet_test.err(r) = 'BAD_NAME', r);

    r := studybet_test.run_as(u3, format('select public.join_room(%L, %L)::text', v_code, 'Intru'));
    perform studybet_test.chk('pairing: third user on full room → same BAD_CODE as wrong code',
      studybet_test.err(r) = 'BAD_CODE', r);
    perform studybet_test.chk('pairing: room still has exactly 2 members',
      (select count(*) from public.members where room_id = v_room) = 2, null);

    r := studybet_test.run_as(u3, format('select public.create_room(%L, %L)::text', v_code, 'Intru'));
    perform studybet_test.chk('pairing: create_room with an existing code → CODE_TAKEN', studybet_test.err(r) = 'CODE_TAKEN', r);

    for i in 1..5 loop
      r := studybet_test.run_as(u4, format('select public.join_room(%L, %L)::text', 'nope-nope-' || i, 'Bot'));
    end loop;
    perform studybet_test.chk('pairing: failed attempts are recorded (not rolled back)',
      (select count(*) from public.pairing_attempts where user_id = u4) = 5, r);
    r := studybet_test.run_as(u4, format('select public.join_room(%L, %L)::text', v_code, 'Bot'));
    perform studybet_test.chk('pairing: 6th attempt within 10 min → RATE_LIMITED (even with right code)',
      studybet_test.err(r) = 'RATE_LIMITED', r);

    -- ================= Task validation =================
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 51, %L::timestamptz))::text', 'x', now() + interval '1 day'));
    perform studybet_test.chk('task: value 51 rejected', studybet_test.err(r) = 'BAD_VALUE', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 0, %L::timestamptz))::text', 'x', now() + interval '1 day'));
    perform studybet_test.chk('task: value 0 rejected', studybet_test.err(r) = 'BAD_VALUE', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 10, %L::timestamptz))::text', 'x', now() - interval '1 minute'));
    perform studybet_test.chk('task: due_at in the past rejected', studybet_test.err(r) = 'BAD_DUE', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 10, %L::timestamptz))::text', 'x', now() + interval '2 minutes'));
    perform studybet_test.chk('task: due_at under 5 minutes rejected', studybet_test.err(r) = 'BAD_DUE', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 10, %L::timestamptz))::text', 'x', now() + interval '8 days'));
    perform studybet_test.chk('task: due_at over 7 days rejected', studybet_test.err(r) = 'BAD_DUE', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.create_task(%L, 10, %L::timestamptz))::text', repeat('長', 41), now() + interval '1 day'));
    perform studybet_test.chk('task: title over 40 chars rejected', studybet_test.err(r) = 'BAD_TITLE', r);
    r := studybet_test.run_as(u4, format('select to_jsonb(public.create_task(%L, 10, %L::timestamptz))::text', 'x', now() + interval '1 day'));
    perform studybet_test.chk('task: non-member cannot create tasks', studybet_test.err(r) = 'NOT_IN_ROOM', r);

    -- complete after the deadline
    t_late := studybet_test.new_task(u1, 'late', 9);
    update public.tasks set due_at = now() - interval '1 second', created_at = now() - interval '1 hour' where id = t_late;
    r := studybet_test.run_as(u1, format('select to_jsonb(public.complete_task(%L))::text', t_late));
    perform studybet_test.chk('task: complete after due_at rejected', studybet_test.err(r) = 'TASK_OVERDUE', r);
    perform studybet_test.chk('task: deadline is strict (completing exactly at due_at is rejected)',
      not public.task_deadline_ok('2026-01-01 12:00+08', '2026-01-01 12:00+08')
      and public.task_deadline_ok('2026-01-01 12:00+08', '2026-01-01 11:59:59.999999+08'), null);

    -- proof required
    t_proof := studybet_test.new_task(u1, 'proof', 5, '1 day', true);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.complete_task(%L))::text', t_proof));
    perform studybet_test.chk('task: proof-required without path rejected', studybet_test.err(r) = 'PROOF_REQUIRED', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.complete_task(%L, %L))::text', t_proof, 'elsewhere/x.jpg'));
    perform studybet_test.chk('task: proof with a foreign path rejected', studybet_test.err(r) = 'BAD_PROOF_PATH', r);

    -- delete window
    t_del := studybet_test.new_task(u1, 'del-old', 5);
    update public.tasks set created_at = now() - interval '6 minutes' where id = t_del;
    r := studybet_test.run_as(u1, format('select to_jsonb(public.delete_task(%L))::text', t_del));
    perform studybet_test.chk('task: delete after 5 minutes rejected', studybet_test.err(r) = 'DELETE_WINDOW_PASSED', r);
    t_del := studybet_test.new_task(u1, 'del-new', 5);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.delete_task(%L))::text', t_del));
    perform studybet_test.chk('task: delete by the other member rejected', studybet_test.err(r) = 'NOT_OWNER', r);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.delete_task(%L))::text', t_del));
    perform studybet_test.chk('task: delete within 5 minutes is a soft delete',
      r like 'OK:%' and (select deleted_at is not null from public.tasks where id = t_del), r);

    -- ================= Scoring =================
    t_a := studybet_test.new_task(u1, 'A', 30);
    t_b := studybet_test.new_task(u1, 'B', 20);
    t_c := studybet_test.new_task(u2, 'C', 10);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.complete_task(%L))::text', t_a));
    perform studybet_test.chk('task: only the owner can complete', studybet_test.err(r) = 'NOT_OWNER', r);
    perform studybet_test.run_as(u1, format('select to_jsonb(public.complete_task(%L))::text', t_a));
    perform studybet_test.run_as(u1, format('select to_jsonb(public.complete_task(%L))::text', t_b));
    r := studybet_test.run_as(u2, format('select to_jsonb(public.complete_task(%L))::text', t_c));
    perform studybet_test.chk('task: complete sets status done and completed_at',
      (studybet_test.j(r) ->> 'status') = 'done' and (studybet_test.j(r) ->> 'completed_at') is not null, r);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.complete_task(%L))::text', t_c));
    perform studybet_test.chk('task: completing twice rejected', studybet_test.err(r) = 'TASK_NOT_ACTIVE', r);

    perform studybet_test.chk('score: total net symmetry (+40 for slot 1, −40 for slot 2)',
      (studybet_test.state(u1) ->> 'total_net_me')::int = 40 and (studybet_test.state(u2) ->> 'total_net_me')::int = -40,
      (studybet_test.state(u1) ->> 'total_net_me') || ' / ' || (studybet_test.state(u2) ->> 'total_net_me'));
    perform studybet_test.chk('score: week net symmetry (+40 / −40)',
      (studybet_test.state(u1) ->> 'week_net_me')::int = 40 and (studybet_test.state(u2) ->> 'week_net_me')::int = -40, null);

    t_ab := studybet_test.new_task(u2, 'abandon me', 25);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.abandon_task(%L))::text', t_ab));
    t_od := studybet_test.new_task(u2, 'overdue', 15);
    update public.tasks set due_at = now() - interval '1 minute', created_at = now() - interval '1 hour' where id = t_od;
    perform studybet_test.chk('score: abandoned and overdue tasks never change the net',
      r like 'OK:%' and (studybet_test.state(u1) ->> 'total_net_me')::int = 40
                    and (studybet_test.state(u2) ->> 'week_net_me')::int = -40, r);
    perform studybet_test.chk('state: active_task_count excludes overdue/abandoned/done/deleted',
      (studybet_test.state(u2) ->> 'active_task_count')::int = 0
      and (studybet_test.state(u1) ->> 'active_task_count')::int = 2,   -- 'proof' + 'del-old'
      studybet_test.state(u1) ->> 'active_task_count');

    -- dispute
    r := studybet_test.run_as(u1, format('select to_jsonb(public.dispute_task(%L, true))::text', t_a));
    perform studybet_test.chk('dispute: owner cannot dispute own task', studybet_test.err(r) = 'NOT_ALLOWED', r);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.dispute_task(%L, true))::text', t_late));
    perform studybet_test.chk('dispute: only done tasks', studybet_test.err(r) = 'TASK_NOT_DONE', r);
    -- (06) a disputed task pauses its money until the disputer clears it
    j := studybet_test.state(u1);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.dispute_task(%L, true))::text', t_a));
    perform studybet_test.chk('dispute: other member can dispute; its NT$ 30 is paused (total and week 40 → 10)',
      (studybet_test.j(r) ->> 'disputed')::bool
      and (studybet_test.state(u1) ->> 'total_net_me')::int = 10 and (studybet_test.state(u1) ->> 'week_net_me')::int = 10
      and (studybet_test.state(u2) ->> 'total_net_me')::int = -10, r);
    perform studybet_test.chk('dispute: done_counts and streaks unchanged while disputed',
      studybet_test.state(u1) -> 'done_counts' = j -> 'done_counts' and studybet_test.state(u1) -> 'streaks' = j -> 'streaks',
      (studybet_test.state(u1) -> 'done_counts')::text);
    perform studybet_test.chk('dispute: get_state reports the paused amount (disputed_pending)',
      studybet_test.state(u1) -> 'disputed_pending' = '{"count": 1, "amount_me": 30}'::jsonb
      and studybet_test.state(u2) -> 'disputed_pending' = '{"count": 1, "amount_me": -30}'::jsonb,
      (studybet_test.state(u1) -> 'disputed_pending')::text);
    perform studybet_test.chk('notify: partner_dispute queued for the owner, body says 暫不計分',
      exists (select 1 from public.notification_outbox where recipient_id = u1 and kind = 'partner_dispute'
              and payload ->> 'body' = '「A」，暫不計分'), null);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.dispute_task(%L, false))::text', t_a));
    perform studybet_test.chk('dispute: owner cannot clear the dispute',
      studybet_test.err(r) = 'NOT_ALLOWED' and (select disputed from public.tasks where id = t_a), r);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.dispute_task(%L, false))::text', t_a));
    perform studybet_test.chk('dispute: disputer clears → NT$ 30 counts again (40 / −40)',
      not (studybet_test.j(r) ->> 'disputed')::bool and (studybet_test.j(r) ->> 'disputed_at') is null
      and (studybet_test.state(u1) ->> 'total_net_me')::int = 40 and (studybet_test.state(u1) ->> 'week_net_me')::int = 40
      and (studybet_test.state(u2) ->> 'total_net_me')::int = -40, r);
    perform studybet_test.chk('notify: dispute_cleared queued for the owner ("Hua 取消質疑" / "「A」+30 已加回")',
      exists (select 1 from public.notification_outbox where recipient_id = u1 and kind = 'dispute_cleared'
              and payload ->> 'title' = 'Hua 取消質疑' and payload ->> 'body' = '「A」+30 已加回'
              and (payload ->> 'counted')::bool and payload ->> 'task_id' = t_a::text)
      and not exists (select 1 from public.notification_outbox where recipient_id = u2 and kind = 'dispute_cleared'), null);
    perform studybet_test.chk('notify: partner_done queued for the other member',
      (select count(*) from public.notification_outbox where recipient_id = u2 and kind = 'partner_done') = 2
      and exists (select 1 from public.notification_outbox where recipient_id = u1 and kind = 'partner_done'
                  and payload ? 'title' and payload ? 'body' and payload ? 'url' and payload ? 'badge'), null);

    -- direct writes / reads blocked
    r := studybet_test.run_as(u1, format('update public.tasks set value = 50 where id = %L returning id::text', t_a));
    perform studybet_test.chk('security: direct UPDATE on tasks denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u1, format(
      'insert into public.tasks(room_id, owner_id, title, value, due_at) values (%L, %L, %L, 50, now() + interval ''1 day'') returning id::text',
      v_room, u1, 'cheat'));
    perform studybet_test.chk('security: direct INSERT on tasks denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u2, 'delete from public.settlements returning id::text');
    perform studybet_test.chk('security: direct DELETE on settlements denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u1, 'select code_hash from public.rooms limit 1');
    perform studybet_test.chk('security: rooms.code_hash not readable', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u1, 'select public.claim_due_notifications()::text');
    perform studybet_test.chk('security: clients cannot call claim_due_notifications', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u4, format('select count(*)::text from public.tasks where room_id = %L', v_room));
    perform studybet_test.chk('security: outsiders see no tasks (RLS)', r = 'OK:0', r);
    r := studybet_test.run_as(u2, format('select count(*)::text from public.tasks where room_id = %L', v_room));
    perform studybet_test.chk('security: members see their room''s tasks (RLS)', r <> 'OK:0' and r like 'OK:%', r);

    -- ================= Security audit: server-only functions =================
    foreach v_fn in array array[
      'select public.claim_due_notifications()::text',
      format('select public.claim_due_notifications(%L::uuid)::text', v_room),
      format('select public.badge_count(%L::uuid)::text', u1),
      'select public.expire_stale_settlements(null)::text',
      'select count(*)::text from public.list_expired_proofs()',
      format('select public.mark_proofs_expired(array[%L::uuid])::text', t_a),
      'select public.nightly_cleanup()::text'
    ] loop
      r := studybet_test.run_as(u1, v_fn);
      perform studybet_test.chk('security: authenticated cannot run ' || substring(v_fn from 'public\.([a-z_]+)'),
        r like 'ERR:permission denied%', r);
      r := studybet_test.run_as(null, v_fn, 'anon');
      perform studybet_test.chk('security: anon cannot run ' || substring(v_fn from 'public\.([a-z_]+)'),
        r like 'ERR:permission denied%', r);
    end loop;

    perform studybet_test.chk('security: no public function is executable by PUBLIC or anon',
      not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')   -- skip extension members
          and (p.proacl is null                                                                -- null ACL = PUBLIC may execute
               or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               or has_function_privilege('anon', p.oid, 'EXECUTE'))),
      (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')));

    perform studybet_test.chk('security: authenticated can execute exactly the contract RPCs + 2 RLS helpers',
      (select array_agg(p.proname::text order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      = (select array_agg(x order by x) from unnest(array[
          'abandon_task', 'complete_task', 'create_room', 'create_task', 'delete_task', 'dispute_task',
          'get_state', 'join_room', 'list_history', 'my_room_id', 'propose_settlement',
          'remove_push_subscription', 'respond_settlement', 'save_push_subscription', 'undo_settlement',
          'update_settings', 'proof_object_allowed']) x),
      (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')));

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      perform studybet_test.chk('security: service_role can execute the server-only functions',
        has_function_privilege('service_role', 'public.claim_due_notifications(uuid)', 'EXECUTE')
        and has_function_privilege('service_role', 'public.badge_count(uuid)', 'EXECUTE')
        and has_function_privilege('service_role', 'public.list_expired_proofs(interval)', 'EXECUTE')
        and has_function_privilege('service_role', 'public.mark_proofs_expired(uuid[])', 'EXECUTE')
        and has_function_privilege('service_role', 'public.nightly_cleanup()', 'EXECUTE'), null);
    end if;

    -- app_config: RLS on, no policies, no grants → PostgREST cannot read or write it
    perform studybet_test.chk('security: app_config has RLS enabled and no policies',
      (select relrowsecurity from pg_class where oid = 'public.app_config'::regclass)
      and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_config'), null);
    perform studybet_test.chk('security: app_config has no table grants for anon/authenticated',
      not exists (select 1 from information_schema.role_table_grants
                  where table_schema = 'public' and table_name = 'app_config'
                    and grantee in ('anon', 'authenticated', 'PUBLIC'))
      and not has_table_privilege('anon', 'public.app_config', 'SELECT')
      and not has_table_privilege('authenticated', 'public.app_config', 'SELECT, INSERT, UPDATE, DELETE'), null);
    r := studybet_test.run_as(u1, 'select count(*)::text from public.app_config');
    perform studybet_test.chk('security: authenticated SELECT on app_config denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(null, 'select count(*)::text from public.app_config', 'anon');
    perform studybet_test.chk('security: anon SELECT on app_config denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u1, $q$insert into public.app_config(key, value) values ('x', 'y') returning key$q$);
    perform studybet_test.chk('security: authenticated INSERT on app_config denied', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u1, 'select count(*)::text from public.notification_outbox');
    perform studybet_test.chk('security: authenticated SELECT on notification_outbox denied', r like 'ERR:permission denied%', r);
    perform studybet_test.chk('security: no secret other than the two documented keys in app_config',
      not exists (select 1 from public.app_config where key not in ('edge_function_base_url', 'function_secret')), null);

    -- ================= Proof expiry hand-off (server side) =================
    insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at, requires_proof, proof_path)
    values (v_room, u1, 'old proof', 4, now() - interval '31 days', 'done', now() - interval '33 days', now() - interval '32 days',
            true, 'placeholder')
    returning id into t_old_proof;
    update public.tasks set proof_path = v_room || '/' || t_old_proof || '.jpg' where id = t_old_proof;
    perform studybet_test.chk('proofs: list_expired_proofs returns proofs older than 30 days only',
      exists (select 1 from public.list_expired_proofs() e where e.task_id = t_old_proof
                and e.proof_path = v_room || '/' || t_old_proof || '.jpg')
      and not exists (select 1 from public.list_expired_proofs() e
                      where e.task_id in (select id from public.tasks where room_id = v_room and id <> t_old_proof)), null);
    v_n := public.mark_proofs_expired(array[t_old_proof, gen_random_uuid()]);   -- unknown id is ignored
    perform studybet_test.chk('proofs: mark_proofs_expired flags the task and keeps proof_path',
      v_n = 1 and (select proof_expired and proof_path is not null from public.tasks where id = t_old_proof), v_n::text);
    perform studybet_test.chk('proofs: flagged proofs are no longer listed',
      not exists (select 1 from public.list_expired_proofs() e where e.task_id = t_old_proof), null);
    begin
      perform public.list_expired_proofs('1 hour');
      perform studybet_test.chk('proofs: interval under 1 day refused', false, 'no error');
    exception when others then
      perform studybet_test.chk('proofs: interval under 1 day refused', sqlerrm = 'BAD_INTERVAL', sqlerrm);
    end;
    delete from public.tasks where id = t_old_proof;

    -- week boundary (fixed past dates; 2024-03-03 is a Sunday)
    insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at) values
      (v_room, u1, 'wk-sun', 11, '2024-03-04 01:00+08', 'done', '2024-03-03 20:00+08', '2024-03-03 23:59:59.9+08'),
      (v_room, u1, 'wk-mon', 13, '2024-03-04 01:00+08', 'done', '2024-03-03 20:00+08', '2024-03-04 00:00:00.1+08');
    perform studybet_test.chk('week: Sunday 23:59:59.9 Taipei counts in that week',
      public.week_net_slot1(v_room, '2024-03-03 23:59:59.95+08') = 11,
      public.week_net_slot1(v_room, '2024-03-03 23:59:59.95+08')::text);
    perform studybet_test.chk('week: Monday 00:00:00.1 Taipei counts in the next week',
      public.week_net_slot1(v_room, '2024-03-04 12:00+08') = 13,
      public.week_net_slot1(v_room, '2024-03-04 12:00+08')::text);
    perform studybet_test.chk('week: week starts Monday 00:00 Taipei',
      public.week_start_for(v_room, '2024-03-04 00:00:00.1+08') = '2024-03-04 00:00+08'::timestamptz
      and public.week_start_for(v_room, '2024-03-03 23:59:59.9+08') = '2024-02-26 00:00+08'::timestamptz, null);
    delete from public.tasks where room_id = v_room and title in ('wk-sun', 'wk-mon');

    -- streak (fixed past dates)
    insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at)
    select v_room, u2, 'streak', 1, d + interval '13 hours', 'done', d, d + interval '12 hours'
    from unnest(array['2024-05-10 00:00+08', '2024-05-11 00:00+08', '2024-05-12 00:00+08', '2024-05-08 00:00+08']::timestamptz[]) d;
    perform studybet_test.chk('streak: 3 consecutive days ending today',
      public.member_streak(u2, '2024-05-12 20:00+08') = 3, public.member_streak(u2, '2024-05-12 20:00+08')::text);
    perform studybet_test.chk('streak: still 3 the next morning (ends yesterday)',
      public.member_streak(u2, '2024-05-13 09:00+08') = 3, null);
    perform studybet_test.chk('streak: broken after a full empty day',
      public.member_streak(u2, '2024-05-14 09:00+08') = 0, null);
    delete from public.tasks where room_id = v_room and title = 'streak';

    -- ================= Settlements =================
    r := studybet_test.run_as(u1, 'select to_jsonb(public.propose_settlement())::text');
    v_sid := (studybet_test.j(r) ->> 'id')::uuid;
    perform studybet_test.chk('settle: propose creates a pending row', (studybet_test.j(r) ->> 'status') = 'pending', r);
    r := studybet_test.run_as(u2, 'select to_jsonb(public.propose_settlement())::text');
    perform studybet_test.chk('settle: only one pending at a time', studybet_test.err(r) = 'SETTLEMENT_PENDING', r);
    perform studybet_test.chk('notify: settlement_request queued for the other member',
      exists (select 1 from public.notification_outbox where recipient_id = u2 and kind = 'settlement_request'), null);
    r := studybet_test.run_as(u1, format('select to_jsonb(public.respond_settlement(%L, true))::text', v_sid));
    perform studybet_test.chk('settle: proposer cannot accept own proposal', studybet_test.err(r) = 'NOT_ALLOWED', r);
    r := studybet_test.run_as(u2, format('select to_jsonb(public.respond_settlement(%L, true))::text', v_sid));
    j := studybet_test.j(r);
    v_conf := (j ->> 'confirmed_at')::timestamptz;
    perform studybet_test.chk('settle: accept freezes slot-1 net (40)',
      (j ->> 'status') = 'confirmed' and (j ->> 'amount_slot1_net')::int = 40 and v_conf is not null, r);
    perform studybet_test.chk('settle: total resets to 0 for both, week net unchanged',
      (studybet_test.state(u1) ->> 'total_net_me')::int = 0 and (studybet_test.state(u2) ->> 'total_net_me')::int = 0
      and (studybet_test.state(u1) ->> 'week_net_me')::int = 40, null);
    perform studybet_test.chk('notify: settlement_result queued for the proposer',
      exists (select 1 from public.notification_outbox where recipient_id = u1 and kind = 'settlement_result'), null);
    r := studybet_test.run_as(u1, 'select to_jsonb(public.propose_settlement())::text');
    perform studybet_test.chk('settle: blocked when total net is 0', studybet_test.err(r) = 'NOTHING_TO_SETTLE', r);

    -- boundary: completed exactly at confirmed_at → excluded; 1 ms later → included
    insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at) values
      (v_room, u1, 'at-boundary',    7, v_conf + interval '1 hour', 'done', v_conf - interval '1 hour', v_conf),
      (v_room, u1, 'after-boundary', 5, v_conf + interval '1 hour', 'done', v_conf - interval '1 hour', v_conf + interval '1 millisecond');
    perform studybet_test.chk('settle: task completed AT confirmed_at excluded, after it included (total 5)',
      (studybet_test.state(u1) ->> 'total_net_me')::int = 5, studybet_test.state(u1) ->> 'total_net_me');

    r := studybet_test.run_as(u1, format('select to_jsonb(public.undo_settlement(%L))::text', v_sid));
    perform studybet_test.chk('settle: either member can undo the latest within 24 h',
      (studybet_test.j(r) ->> 'status') = 'undone', r);
    perform studybet_test.chk('settle: undo restores the total (40 + 7 + 5 = 52 / −52)',
      (studybet_test.state(u1) ->> 'total_net_me')::int = 52 and (studybet_test.state(u2) ->> 'total_net_me')::int = -52,
      studybet_test.state(u1) ->> 'total_net_me');
    r := studybet_test.run_as(u2, format('select to_jsonb(public.undo_settlement(%L))::text', v_sid));
    perform studybet_test.chk('settle: cannot undo twice', studybet_test.err(r) = 'SETTLEMENT_NOT_CONFIRMED', r);

    r := studybet_test.run_as(u2, 'select to_jsonb(public.propose_settlement())::text');
    v_sid := (studybet_test.j(r) ->> 'id')::uuid;
    r := studybet_test.run_as(u1, format('select to_jsonb(public.respond_settlement(%L, false))::text', v_sid));
    perform studybet_test.chk('settle: reject leaves the total untouched',
      (studybet_test.j(r) ->> 'status') = 'rejected' and (studybet_test.state(u1) ->> 'total_net_me')::int = 52, r);

    r := studybet_test.run_as(u1, 'select to_jsonb(public.propose_settlement())::text');
    v_sid := (studybet_test.j(r) ->> 'id')::uuid;
    update public.settlements set proposed_at = now() - interval '8 days' where id = v_sid;
    perform studybet_test.chk('settle: pending older than 7 days is hidden from get_state',
      studybet_test.state(u2) -> 'pending_settlement' = 'null'::jsonb, null);
    perform public.expire_stale_settlements(v_room);
    perform studybet_test.chk('settle: pending older than 7 days auto-rejected',
      (select status from public.settlements where id = v_sid) = 'rejected', null);

    r := studybet_test.run_as(u2, 'select to_jsonb(public.propose_settlement())::text');
    v_sid := (studybet_test.j(r) ->> 'id')::uuid;
    perform studybet_test.run_as(u1, format('select to_jsonb(public.respond_settlement(%L, true))::text', v_sid));
    update public.settlements set confirmed_at = confirmed_at - interval '25 hours' where id = v_sid;
    r := studybet_test.run_as(u1, format('select to_jsonb(public.undo_settlement(%L))::text', v_sid));
    perform studybet_test.chk('settle: undo after 24 h rejected', studybet_test.err(r) = 'UNDO_WINDOW_PASSED', r);

    -- ================= History =================
    r := studybet_test.run_as(u1, 'select public.list_history(null, 3)::text');
    j := studybet_test.j(r);
    -- a page may be longer than p_limit only to keep items with the same timestamp together
    perform studybet_test.chk('history: newest first, page size respected (ties kept together)',
      jsonb_array_length(j) >= 3
      and (j -> 0 ->> 'at')::timestamptz >= (j -> 2 ->> 'at')::timestamptz
      and (j -> -1 ->> 'at')::timestamptz = (j -> 2 ->> 'at')::timestamptz, r);
    r := studybet_test.run_as(u1, format('select public.list_history(%L, 100)::text', j -> -1 ->> 'at'));
    perform studybet_test.chk('history: next page continues strictly before the cursor',
      not exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e
                  where (e ->> 'at')::timestamptz >= (j -> -1 ->> 'at')::timestamptz), r);
    r := studybet_test.run_as(u1, 'select public.list_history(null, 100)::text');
    perform studybet_test.chk('history: contains overdue, abandoned, done, settlements; no deleted/active',
      exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e where e ->> 'status' = 'overdue')
      and exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e where e ->> 'status' = 'abandoned')
      and exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e where e ->> 'status' = 'done')
      and exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e where e ->> 'type' = 'settlement')
      and not exists (select 1 from jsonb_array_elements(studybet_test.j(r)) e where (e ->> 'id')::uuid in (t_del, t_proof)),
      left(r, 300));

    -- ================= Timed reminders =================
    t_soon  := studybet_test.new_task(u1, 'soon', 3, '30 minutes');    -- due_1h window
    t_fresh := studybet_test.new_task(u2, 'fresh', 3, '10 minutes');   -- due_15m window
    v_n := public.claim_due_notifications(v_room);
    perform studybet_test.chk('reminders: no due_1h / due_15m for tasks created < 15 min ago',
      not exists (select 1 from public.notification_outbox
                  where kind in ('due_1h', 'due_15m') and (payload ->> 'task_id')::uuid in (t_soon, t_fresh))
      and not exists (select 1 from public.notification_log where task_id in (t_soon, t_fresh)), v_n::text);
    -- the same tasks once they are 16 minutes old
    update public.tasks set created_at = now() - interval '16 minutes' where id in (t_soon, t_fresh);
    v_n := public.claim_due_notifications(v_room);
    perform studybet_test.chk('reminders: due_15m fires once the task is 15+ min old',
      (select count(*) from public.notification_outbox where kind = 'due_15m' and (payload ->> 'task_id')::uuid = t_fresh) = 1
      and exists (select 1 from public.notification_outbox where kind = 'due_15m' and recipient_id = u2), v_n::text);
    perform studybet_test.chk('reminders: due_1h claimed once',
      (select count(*) from public.notification_outbox where kind = 'due_1h' and (payload ->> 'task_id')::uuid = t_soon) = 1, v_n::text);
    perform public.claim_due_notifications(v_room);
    perform studybet_test.chk('reminders: second run does not duplicate',
      (select count(*) from public.notification_outbox where kind = 'due_1h' and (payload ->> 'task_id')::uuid = t_soon) = 1
      and (select count(*) from public.notification_outbox where kind = 'overdue' and recipient_id = u2) = 1, null);
    perform studybet_test.chk('reminders: overdue goes to the owner only',
      exists (select 1 from public.notification_outbox where kind = 'overdue' and (payload ->> 'task_id')::uuid = t_od and recipient_id = u2)
      and not exists (select 1 from public.notification_outbox where kind = 'overdue' and (payload ->> 'task_id')::uuid = t_od and recipient_id = u1), null);
    perform studybet_test.chk('notify: outbox rows stay unsent when push is disabled / not configured',
      not exists (select 1 from public.notification_outbox o join public.members m on m.id = o.recipient_id
                  where m.room_id = v_room and o.sent_at is not null), null);

    -- ================= Slot reclaim (iOS storage cleared) =================
    v_n := (select count(*) from public.tasks where owner_id = u2);
    r := studybet_test.run_as(u3, format('select public.join_room(%L, %L, 2::smallint)::text', v_code, 'Hua2'));
    perform studybet_test.chk('reclaim: full room + p_slot → caller takes over that slot',
      (studybet_test.j(r) ->> 'id')::uuid = u3 and (studybet_test.j(r) ->> 'slot')::int = 2
      and not exists (select 1 from public.members where id = u2), r);
    perform studybet_test.chk('reclaim: tasks and score follow the slot',
      (select count(*) from public.tasks where owner_id = u3) = v_n
      and (studybet_test.state(u3) ->> 'total_net_me')::int = -52, null);
    r := studybet_test.run_as(u2, format('select public.join_room(%L, %L, 2::smallint)::text', v_code, 'Hua'));
    perform studybet_test.chk('reclaim: original device can reclaim back', (studybet_test.j(r) ->> 'id')::uuid = u2, r);

    -- ================= Batch 2 (06): disputes pause money, per-member daily reminder =================
    -- A second, clean room: u5 "Ann" (slot 1), u6 "Bo" (slot 2).
    r := studybet_test.run_as(u5, format('select public.create_room(%L, %L)::text', v_code || '-b2', 'Ann'));
    v_room2 := (studybet_test.j(r) -> 'room' ->> 'id')::uuid;
    r := studybet_test.run_as(u6, format('select public.join_room(%L, %L)::text', v_code || '-b2', 'Bo'));
    x1 := studybet_test.new_task(u5, 'X1', 20);
    x2 := studybet_test.new_task(u6, 'X2', 5);
    perform studybet_test.run_as(u5, format('select to_jsonb(public.complete_task(%L))::text', x1));
    perform studybet_test.run_as(u6, format('select to_jsonb(public.complete_task(%L))::text', x2));
    j := studybet_test.state(u5);
    perform studybet_test.chk('b2: setup total and week +15 / −15',
      (j ->> 'total_net_me')::int = 15 and (j ->> 'week_net_me')::int = 15
      and (studybet_test.state(u6) ->> 'total_net_me')::int = -15, (j ->> 'total_net_me'));

    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, true))::text', x1));
    perform studybet_test.chk('b2: dispute excludes the money from week AND total (+15 → −5)',
      (studybet_test.state(u5) ->> 'total_net_me')::int = -5 and (studybet_test.state(u5) ->> 'week_net_me')::int = -5
      and (studybet_test.state(u6) ->> 'total_net_me')::int = 5 and (studybet_test.state(u6) ->> 'week_net_me')::int = 5,
      (studybet_test.state(u5) ->> 'total_net_me') || ' / ' || (studybet_test.state(u5) ->> 'week_net_me'));
    perform studybet_test.chk('b2: done_counts and streaks unchanged by the dispute',
      studybet_test.state(u5) -> 'done_counts' = j -> 'done_counts' and studybet_test.state(u5) -> 'streaks' = j -> 'streaks'
      and (studybet_test.state(u5) -> 'done_counts' -> 'me' ->> 'week')::int = 1
      -- get_state uses now() = transaction start; tasks here are completed at clock_timestamp(), so ask at that time
      and public.member_streak(u5, clock_timestamp()) = 1, public.member_streak(u5, clock_timestamp())::text);
    perform studybet_test.chk('b2: week_net_slot1 / total_net_slot1 exclude it directly too',
      public.week_net_slot1(v_room2) = -5 and public.total_net_slot1(v_room2) = -5, null);
    r := studybet_test.run_as(u5, format('select to_jsonb(public.dispute_task(%L, false))::text', x1));
    perform studybet_test.chk('b2: owner cannot clear the dispute (still −5)',
      studybet_test.err(r) = 'NOT_ALLOWED' and (studybet_test.state(u5) ->> 'total_net_me')::int = -5, r);
    r := studybet_test.run_as(u6, 'select to_jsonb(public.propose_settlement())::text');
    perform studybet_test.chk('b2: settlement can be proposed on the remaining gap (−5)', studybet_test.j(r) ->> 'status' = 'pending', r);
    perform studybet_test.run_as(u5, format('select to_jsonb(public.respond_settlement(%L, false))::text', (studybet_test.j(r) ->> 'id')));
    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, false))::text', x1));
    perform studybet_test.chk('b2: clearing adds it back to week and total (+15)',
      (studybet_test.state(u5) ->> 'total_net_me')::int = 15 and (studybet_test.state(u5) ->> 'week_net_me')::int = 15, null);

    -- dispute across the week boundary (fixed past dates; 2024-03-03 is a Sunday)
    insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at, disputed, disputed_at) values
      (v_room2, u5, 'wk-prev', 7, '2024-03-04 01:00+08', 'done', '2024-03-03 20:00+08', '2024-03-03 23:00+08', true, '2024-03-04 09:00+08'),
      (v_room2, u5, 'wk-next', 9, '2024-03-04 23:00+08', 'done', '2024-03-04 08:00+08', '2024-03-04 10:00+08', false, null);
    select id into x4 from public.tasks where room_id = v_room2 and title = 'wk-prev';
    perform studybet_test.chk('b2: week boundary — disputed Sunday task excluded from its own week, Monday unaffected',
      public.week_net_slot1(v_room2, '2024-03-03 23:30+08') = 0 and public.week_net_slot1(v_room2, '2024-03-04 12:00+08') = 9,
      public.week_net_slot1(v_room2, '2024-03-03 23:30+08') || ' / ' || public.week_net_slot1(v_room2, '2024-03-04 12:00+08'));
    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, false))::text', x4));
    perform studybet_test.chk('b2: week boundary — cleared on Monday, it counts in the week of its completed_at (Sunday), not Monday''s',
      public.week_net_slot1(v_room2, '2024-03-03 23:30+08') = 7 and public.week_net_slot1(v_room2, '2024-03-04 12:00+08') = 9, null);
    delete from public.tasks where room_id = v_room2 and title in ('wk-prev', 'wk-next');

    -- a task still disputed when a settlement is confirmed stays excluded afterwards
    x3 := studybet_test.new_task(u5, 'X3', 10);
    perform studybet_test.run_as(u5, format('select to_jsonb(public.complete_task(%L))::text', x3));
    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, true))::text', x3));
    r := studybet_test.run_as(u5, 'select to_jsonb(public.propose_settlement())::text');
    v_sid := (studybet_test.j(r) ->> 'id')::uuid;
    r := studybet_test.run_as(u6, format('select to_jsonb(public.respond_settlement(%L, true))::text', v_sid));
    perform studybet_test.chk('b2: frozen settlement amount excludes the disputed task (15, not 25)',
      (studybet_test.j(r) ->> 'amount_slot1_net')::int = 15 and (studybet_test.state(u5) ->> 'total_net_me')::int = 0, r);
    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, false))::text', x3));
    perform studybet_test.chk('b2: disputed at settlement time → stays excluded from the new total after clearing (0)',
      (studybet_test.state(u5) ->> 'total_net_me')::int = 0 and (studybet_test.state(u6) ->> 'total_net_me')::int = 0,
      studybet_test.state(u5) ->> 'total_net_me');
    perform studybet_test.chk('b2: …but it counts in the week again (week 15 → 25)',
      (studybet_test.state(u5) ->> 'week_net_me')::int = 25, studybet_test.state(u5) ->> 'week_net_me');
    perform studybet_test.chk('b2: dispute_cleared for a pre-settlement task says it no longer counts',
      exists (select 1 from public.notification_outbox where recipient_id = u5 and kind = 'dispute_cleared'
              and payload ->> 'task_id' = x3::text and not (payload ->> 'counted')::bool
              and payload ->> 'body' = '「X3」在上次結算前完成，不再計分'), null);
    r := studybet_test.run_as(u5, format('select to_jsonb(public.undo_settlement(%L))::text', v_sid));
    perform studybet_test.chk('b2: undo settlement restores the full total incl. the now-cleared task (25 / −25)',
      studybet_test.j(r) ->> 'status' = 'undone'
      and (studybet_test.state(u5) ->> 'total_net_me')::int = 25 and (studybet_test.state(u6) ->> 'total_net_me')::int = -25,
      studybet_test.state(u5) ->> 'total_net_me');
    perform studybet_test.run_as(u6, format('select to_jsonb(public.dispute_task(%L, true))::text', x3));
    perform studybet_test.chk('b2: re-disputed after the undo → paused again (15)',
      (studybet_test.state(u5) ->> 'total_net_me')::int = 15, studybet_test.state(u5) ->> 'total_net_me');

    -- per-member daily reminder
    perform studybet_test.chk('b2: daily_reminder_enabled defaults to true, shown on me only',
      (studybet_test.state(u5) -> 'me' ->> 'daily_reminder_enabled')::bool
      and not (studybet_test.state(u5) -> 'partner') ? 'daily_reminder_enabled', (studybet_test.state(u5) -> 'partner')::text);
    r := studybet_test.run_as(u5, 'select public.update_settings(null, null, false)::text');
    perform studybet_test.chk('b2: update_settings(p_daily_reminder_enabled => false) turns it off for the caller only',
      not (studybet_test.j(r) -> 'me' ->> 'daily_reminder_enabled')::bool
      and (studybet_test.state(u6) -> 'me' ->> 'daily_reminder_enabled')::bool, r);
    r := studybet_test.run_as(u5, 'select public.update_settings(null, null, null)::text');
    perform studybet_test.chk('b2: update_settings with null keeps the value (still off)',
      not (studybet_test.j(r) -> 'me' ->> 'daily_reminder_enabled')::bool, r);
    r := studybet_test.run_as(u5, $q$select public.update_settings(p_display_name => 'Ann2')::text$q$);
    perform studybet_test.chk('b2: old-style named call (name only) still works and keeps the switch',
      studybet_test.j(r) -> 'me' ->> 'display_name' = 'Ann2' and not (studybet_test.j(r) -> 'me' ->> 'daily_reminder_enabled')::bool, r);
    perform studybet_test.chk('b2: the 2-argument update_settings is gone (no ambiguous overload)',
      to_regprocedure('public.update_settings(text, time)') is null
      and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'update_settings') = 1, null);
    r := studybet_test.run_as(u6, 'select string_agg(daily_reminder_enabled::text, '','') from public.members');
    perform studybet_test.chk('b2: partner cannot read members.daily_reminder_enabled', r like 'ERR:permission denied%', r);
    r := studybet_test.run_as(u6, 'select count(display_name)::text from public.members');
    perform studybet_test.chk('b2: other members columns stay readable (2 rows)', r = 'OK:2', r);
    -- both have an active task; reminder time = this very minute (Taipei)
    perform studybet_test.new_task(u5, 'today-a', 3);
    perform studybet_test.new_task(u6, 'today-b', 3);
    update public.rooms set daily_reminder_time = date_trunc('minute', now() at time zone timezone)::time where id = v_room2;
    perform public.claim_due_notifications(v_room2);
    perform studybet_test.chk('b2: daily reminder created only for the member who has it on',
      exists (select 1 from public.notification_outbox where recipient_id = u6 and kind = 'daily')
      and not exists (select 1 from public.notification_outbox where recipient_id = u5 and kind = 'daily')
      and not exists (select 1 from public.daily_reminder_log where member_id = u5), null);
    perform studybet_test.run_as(u5, 'select public.update_settings(null, null, true)::text');
    perform public.claim_due_notifications(v_room2);
    perform studybet_test.chk('b2: turned back on → daily reminder created (time stays shared)',
      exists (select 1 from public.notification_outbox where recipient_id = u5 and kind = 'daily')
      and (select count(*) from public.notification_outbox where recipient_id = u6 and kind = 'daily') = 1, null);

    -- ================= Cleanup =================
    delete from public.rooms where id = v_room;
    delete from public.rooms where id = v_room2;
    delete from public.pairing_attempts where user_id in (u1, u2, u3, u4, u5, u6);
  exception when others then
    -- everything above was rolled back; record the crash as a failure
    insert into studybet_test.results(name, ok, detail)
    values ('UNEXPECTED ERROR — all tests rolled back', false, sqlerrm);
  end;
end $$;

select n,
       case when ok then 'PASS' else 'FAIL' end as result,
       name,
       case when ok then null else detail end as detail
from studybet_test.results
union all
select 9999, 'SUMMARY', count(*) || ' tests', 'failures: ' || count(*) filter (where not ok)
from studybet_test.results
order by n;
