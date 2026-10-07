-- =====================================================================
-- 賭讀 / StudyBet — 02_rls_and_rpc.sql
-- Row Level Security, scoring, RPC functions, notification triggers,
-- claim_due_notifications(), privileges.
-- Run after 01_schema.sql. Safe to re-run.
--
-- Rules enforced here:
--   * Clients can only SELECT rows of their own room. Every write goes through
--     a SECURITY DEFINER function below (set search_path = public, checks auth.uid()).
--   * Every deadline / week / settlement decision uses the server clock.
--   * Errors are raised as short stable codes (see README-backend.md, "Error codes").
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------

-- Current user id or NOT_AUTHENTICATED.
create or replace function public._uid()
returns uuid
language plpgsql stable
set search_path = public
as $$
declare
  v uuid := auth.uid();
begin
  if v is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  return v;
end $$;

-- The caller's members row or NOT_IN_ROOM.
create or replace function public._me()
returns public.members
language plpgsql stable security definer
set search_path = public
as $$
declare
  v public.members;
begin
  select * into v from public.members where id = public._uid();
  if not found then
    raise exception 'NOT_IN_ROOM';
  end if;
  return v;
end $$;

-- Room of the caller (null if none). Used by RLS policies.
create or replace function public.my_room_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select room_id from public.members where id = auth.uid()
$$;

-- The other member of a room (null if not joined yet).
create or replace function public._partner_of(p_room uuid, p_member uuid)
returns public.members
language sql stable security definer
set search_path = public
as $$
  select * from public.members where room_id = p_room and id <> p_member limit 1
$$;

-- "Strictly before the deadline". Kept separate so tests can check the exact edge.
create or replace function public.task_deadline_ok(p_due timestamptz, p_at timestamptz)
returns boolean
language sql immutable
as $$
  select p_at < p_due
$$;

-- Error answer that does NOT roll back the transaction (used where a failed
-- attempt must be recorded: pairing). PostgREST turns this into HTTP 400 with
-- the same JSON shape as a raised exception, so supabase-js gives
-- error.message = '<CODE>' exactly like the other RPCs.
create or replace function public._soft_error(p_code text)
returns jsonb
language plpgsql volatile
as $$
begin
  perform set_config('response.status', '400', true);
  return jsonb_build_object('code', 'P0001', 'message', p_code, 'details', null, 'hint', null);
end $$;

create or replace function public._member_json(m public.members)
returns jsonb
language sql immutable
as $$
  select case when m.id is null then null
         else jsonb_build_object('id', m.id, 'slot', m.slot, 'display_name', m.display_name,
                                 'room_id', m.room_id, 'created_at', m.created_at) end
$$;

create or replace function public._room_json(r public.rooms)
returns jsonb
language sql immutable
as $$
  select jsonb_build_object('id', r.id, 'timezone', r.timezone,
                            'daily_reminder_time', to_char(r.daily_reminder_time, 'HH24:MI'),
                            'created_at', r.created_at)
$$;

-- ---------------------------------------------------------------------
-- 1. Scoring (all in SQL; p_now parameters exist only so tests can pin time)
-- ---------------------------------------------------------------------

-- Monday 00:00 (room timezone) of the week containing p_now.
create or replace function public.week_start_for(p_room uuid, p_now timestamptz default now())
returns timestamptz
language sql stable
set search_path = public
as $$
  select date_trunc('week', p_now at time zone r.timezone) at time zone r.timezone
  from public.rooms r where r.id = p_room
$$;

-- Slot-1 net for the week containing p_now: [Mon 00:00, next Mon 00:00) in room tz.
create or replace function public.week_net_slot1(p_room uuid, p_now timestamptz default now())
returns int
language sql stable
set search_path = public
as $$
  with w as (
    select date_trunc('week', p_now at time zone r.timezone) at time zone r.timezone as ws,
           (date_trunc('week', p_now at time zone r.timezone) + interval '7 days') at time zone r.timezone as we
    from public.rooms r where r.id = p_room
  )
  select coalesce(sum(case m.slot when 1 then t.value else -t.value end), 0)::int
  from w, public.tasks t
  join public.members m on m.id = t.owner_id
  where t.room_id = p_room
    and t.status = 'done' and t.deleted_at is null
    and t.completed_at >= w.ws and t.completed_at < w.we
$$;

-- confirmed_at of the latest confirmed (= not undone) settlement, or null.
create or replace function public.settlement_boundary(p_room uuid)
returns timestamptz
language sql stable
set search_path = public
as $$
  select max(confirmed_at) from public.settlements
  where room_id = p_room and status = 'confirmed'
$$;

-- Slot-1 net since the boundary (tasks completed AT the boundary are excluded).
create or replace function public.total_net_slot1(p_room uuid)
returns int
language sql stable
set search_path = public
as $$
  with b as (select public.settlement_boundary(p_room) as at)
  select coalesce(sum(case m.slot when 1 then t.value else -t.value end), 0)::int
  from b, public.tasks t
  join public.members m on m.id = t.owner_id
  where t.room_id = p_room
    and t.status = 'done' and t.deleted_at is null
    and (b.at is null or t.completed_at > b.at)
$$;

-- Consecutive room-tz calendar days with >= 1 done task, ending today
-- (or yesterday if today has none yet).
create or replace function public.member_streak(p_member uuid, p_now timestamptz default now())
returns int
language sql stable
set search_path = public
as $$
  with m as (
    select mb.id, r.timezone as tz, (p_now at time zone r.timezone)::date as today
    from public.members mb join public.rooms r on r.id = mb.room_id
    where mb.id = p_member
  ),
  days as (
    select distinct (t.completed_at at time zone m.tz)::date as d
    from m join public.tasks t on t.owner_id = m.id
    where t.status = 'done' and t.deleted_at is null and t.completed_at <= p_now
  ),
  anchor as (
    select case
             when exists (select 1 from days, m where days.d = m.today)     then (select today from m)
             when exists (select 1 from days, m where days.d = m.today - 1) then (select today from m) - 1
           end as a
  ),
  ranked as (
    select d, row_number() over (order by d desc) as rn
    from days, anchor where anchor.a is not null and days.d <= anchor.a
  )
  select count(*)::int from ranked, anchor where ranked.d = anchor.a - (ranked.rn - 1)::int
$$;

-- Badge: recipient's active, non-overdue, non-deleted tasks (evaluated when called).
create or replace function public.badge_count(p_member uuid)
returns int
language sql stable
set search_path = public
as $$
  select count(*)::int from public.tasks
  where owner_id = p_member and status = 'active' and deleted_at is null and due_at > now()
$$;

-- Pending proposals older than 7 days become 'rejected' (responded_by stays null).
create or replace function public.expire_stale_settlements(p_room uuid default null)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v int;
begin
  update public.settlements
     set status = 'rejected'
   where status = 'pending'
     and proposed_at <= now() - interval '7 days'
     and (p_room is null or room_id = p_room);
  get diagnostics v = row_count;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 2. Pairing
-- ---------------------------------------------------------------------

create or replace function public._find_room_by_code(p_code text)
returns uuid
language sql stable security definer
set search_path = public
as $$
  -- bcrypt hashes are salted, so this compares against every room.
  -- Fine for a private deployment (a handful of rooms).
  select id from public.rooms
  where code_hash = extensions.crypt(p_code, code_hash)
  order by created_at
  limit 1
$$;

create or replace function public._check_rate_limit(p_uid uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if (select count(*) from public.pairing_attempts
      where user_id = p_uid and attempted_at > now() - interval '10 minutes') >= 5 then
    raise exception 'RATE_LIMITED';
  end if;
end $$;

create or replace function public._record_failed_attempt(p_uid uuid)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.pairing_attempts(user_id) values (p_uid)
$$;

-- create_room(p_code, p_display_name) → {room, member} (caller becomes slot 1)
create or replace function public.create_room(p_code text, p_display_name text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := public._uid();
  v_code   text := btrim(coalesce(p_code, ''));
  v_name   text := btrim(coalesce(p_display_name, ''));
  v_room   public.rooms;
  v_member public.members;
begin
  -- serialize pairing so two rooms can never share a code and slots can't race
  perform pg_advisory_xact_lock(hashtext('studybet.pairing'));

  if exists (select 1 from public.members where id = v_uid) then
    raise exception 'ALREADY_IN_ROOM';
  end if;
  perform public._check_rate_limit(v_uid);
  if char_length(v_code) < 8 then
    raise exception 'CODE_TOO_SHORT';
  end if;
  if char_length(v_code) > 64 then
    raise exception 'CODE_TOO_LONG';
  end if;
  if char_length(v_name) not between 1 and 6 then
    raise exception 'BAD_NAME';
  end if;
  if public._find_room_by_code(v_code) is not null then
    -- counts as a failed attempt so create_room can't be used to probe codes
    perform public._record_failed_attempt(v_uid);
    return public._soft_error('CODE_TAKEN');
  end if;

  insert into public.rooms(code_hash)
  values (extensions.crypt(v_code, extensions.gen_salt('bf', 8)))
  returning * into v_room;

  insert into public.members(id, room_id, slot, display_name)
  values (v_uid, v_room.id, 1, v_name)
  returning * into v_member;

  return jsonb_build_object('room', public._room_json(v_room), 'member', public._member_json(v_member));
end $$;

-- join_room(p_code, p_display_name, p_slot) → member
--   * fills a free slot (p_slot preferred if it is free)
--   * room full + p_slot given → the caller takes over that slot (reclaim after
--     iOS storage was cleared); all tasks/settlements follow via ON UPDATE CASCADE
--   * wrong code, or room full without p_slot → BAD_CODE (same answer either way)
create or replace function public.join_room(p_code text, p_display_name text, p_slot smallint default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid      uuid := public._uid();
  v_code     text := btrim(coalesce(p_code, ''));
  v_name     text := btrim(coalesce(p_display_name, ''));
  v_room_id  uuid;
  v_existing public.members;
  v_slot     smallint;
  v_member   public.members;
begin
  perform pg_advisory_xact_lock(hashtext('studybet.pairing'));

  perform public._check_rate_limit(v_uid);
  if char_length(v_name) not between 1 and 6 then
    raise exception 'BAD_NAME';
  end if;
  if p_slot is not null and p_slot not in (1, 2) then
    raise exception 'BAD_SLOT';
  end if;

  if char_length(v_code) between 8 and 64 then
    v_room_id := public._find_room_by_code(v_code);
  end if;
  if v_room_id is null then
    perform public._record_failed_attempt(v_uid);
    return public._soft_error('BAD_CODE');
  end if;

  select * into v_existing from public.members where id = v_uid;
  if found then
    if v_existing.room_id <> v_room_id then
      raise exception 'ALREADY_IN_ROOM';
    end if;
    -- already a member of this room: just refresh the name
    update public.members set display_name = v_name where id = v_uid returning * into v_member;
    return public._member_json(v_member);
  end if;

  -- free slot? prefer the requested one
  select s into v_slot
  from (values (1::smallint), (2::smallint)) as x(s)
  where not exists (select 1 from public.members where room_id = v_room_id and slot = x.s)
  order by (x.s = p_slot) desc nulls last, x.s
  limit 1;

  if v_slot is not null then
    insert into public.members(id, room_id, slot, display_name)
    values (v_uid, v_room_id, v_slot, v_name)
    returning * into v_member;
    return public._member_json(v_member);
  end if;

  -- room is full
  if p_slot is null then
    perform public._record_failed_attempt(v_uid);
    return public._soft_error('BAD_CODE');
  end if;

  update public.members
     set id = v_uid, display_name = v_name
   where room_id = v_room_id and slot = p_slot
  returning * into v_member;
  return public._member_json(v_member);
end $$;

-- ---------------------------------------------------------------------
-- 3. Tasks
-- ---------------------------------------------------------------------

create or replace function public.create_task(p_title text, p_value int, p_due_at timestamptz,
                                              p_requires_proof bool default false)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me    public.members := public._me();
  v_title text := btrim(coalesce(p_title, ''));
  v_task  public.tasks;
begin
  if char_length(v_title) not between 1 and 40 then
    raise exception 'BAD_TITLE';
  end if;
  if p_value is null or p_value not between 1 and 50 then
    raise exception 'BAD_VALUE';
  end if;
  if p_due_at is null
     or p_due_at < now() + interval '5 minutes'
     or p_due_at > now() + interval '7 days' then
    raise exception 'BAD_DUE';
  end if;

  insert into public.tasks(room_id, owner_id, title, value, due_at, requires_proof)
  values (v_me.room_id, v_me.id, v_title, p_value, p_due_at, coalesce(p_requires_proof, false))
  returning * into v_task;
  return v_task;
end $$;

-- Loads a task of the caller's room, locked. TASK_NOT_FOUND otherwise (also for deleted).
create or replace function public._task_for_update(p_room uuid, p_task uuid)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v public.tasks;
begin
  select * into v from public.tasks
   where id = p_task and room_id = p_room and deleted_at is null
   for update;
  if not found then
    raise exception 'TASK_NOT_FOUND';
  end if;
  return v;
end $$;

create or replace function public.complete_task(p_task_id uuid, p_proof_path text default null)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_task public.tasks;
  v_now  timestamptz;
  v_ok   boolean;
begin
  -- Room lock serializes completion with settlement confirmation, so a task can
  -- never fall between a frozen settlement amount and the new total window.
  perform 1 from public.rooms where id = v_me.room_id for update;
  v_now := clock_timestamp();   -- server clock, read after the lock

  v_task := public._task_for_update(v_me.room_id, p_task_id);
  if v_task.owner_id <> v_me.id then
    raise exception 'NOT_OWNER';
  end if;
  if v_task.status <> 'active' then
    raise exception 'TASK_NOT_ACTIVE';
  end if;
  if not public.task_deadline_ok(v_task.due_at, v_now) then
    raise exception 'TASK_OVERDUE';
  end if;

  if p_proof_path is null then
    if v_task.requires_proof then
      raise exception 'PROOF_REQUIRED';
    end if;
  else
    if p_proof_path <> (v_task.room_id::text || '/' || v_task.id::text || '.jpg') then
      raise exception 'BAD_PROOF_PATH';
    end if;
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
        into v_ok using 'proofs', p_proof_path;
      if not v_ok then
        raise exception 'PROOF_MISSING';
      end if;
    end if;
  end if;

  update public.tasks
     set status = 'done', completed_at = v_now, proof_path = p_proof_path
   where id = v_task.id
  returning * into v_task;
  return v_task;
end $$;

create or replace function public.abandon_task(p_task_id uuid)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_task public.tasks;
begin
  v_task := public._task_for_update(v_me.room_id, p_task_id);
  if v_task.owner_id <> v_me.id then
    raise exception 'NOT_OWNER';
  end if;
  if v_task.status <> 'active' then
    raise exception 'TASK_NOT_ACTIVE';
  end if;
  if v_task.due_at <= now() then
    raise exception 'TASK_OVERDUE';
  end if;
  update public.tasks set status = 'abandoned', abandoned_at = now()
   where id = v_task.id returning * into v_task;
  return v_task;
end $$;

-- Soft delete: owner, active, within 5 minutes of creation.
create or replace function public.delete_task(p_task_id uuid)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_task public.tasks;
begin
  v_task := public._task_for_update(v_me.room_id, p_task_id);
  if v_task.owner_id <> v_me.id then
    raise exception 'NOT_OWNER';
  end if;
  if v_task.status <> 'active' then
    raise exception 'TASK_NOT_ACTIVE';
  end if;
  if now() > v_task.created_at + interval '5 minutes' then
    raise exception 'DELETE_WINDOW_PASSED';
  end if;
  update public.tasks set deleted_at = now()
   where id = v_task.id returning * into v_task;
  return v_task;
end $$;

-- Only the OTHER member; badge flag only, never touches scores.
create or replace function public.dispute_task(p_task_id uuid, p_disputed bool)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_task public.tasks;
begin
  v_task := public._task_for_update(v_me.room_id, p_task_id);
  if v_task.owner_id = v_me.id then
    raise exception 'NOT_ALLOWED';
  end if;
  if v_task.status <> 'done' then
    raise exception 'TASK_NOT_DONE';
  end if;
  update public.tasks
     set disputed    = coalesce(p_disputed, false),
         disputed_at = case when coalesce(p_disputed, false) then coalesce(disputed_at, now()) end
   where id = v_task.id
  returning * into v_task;
  return v_task;
end $$;

-- ---------------------------------------------------------------------
-- 4. Settlements
-- ---------------------------------------------------------------------

create or replace function public.propose_settlement()
returns public.settlements
language plpgsql security definer
set search_path = public
as $$
declare
  v_me public.members := public._me();
  v_s  public.settlements;
begin
  perform 1 from public.rooms where id = v_me.room_id for update;
  perform public.expire_stale_settlements(v_me.room_id);

  if (public._partner_of(v_me.room_id, v_me.id)).id is null then
    raise exception 'NO_PARTNER';
  end if;
  if exists (select 1 from public.settlements where room_id = v_me.room_id and status = 'pending') then
    raise exception 'SETTLEMENT_PENDING';
  end if;
  if public.total_net_slot1(v_me.room_id) = 0 then
    raise exception 'NOTHING_TO_SETTLE';
  end if;

  insert into public.settlements(room_id, proposed_by)
  values (v_me.room_id, v_me.id)
  returning * into v_s;
  return v_s;
end $$;

create or replace function public.respond_settlement(p_id uuid, p_accept bool)
returns public.settlements
language plpgsql security definer
set search_path = public
as $$
declare
  v_me  public.members := public._me();
  v_s   public.settlements;
  v_now timestamptz;
begin
  perform 1 from public.rooms where id = v_me.room_id for update;
  v_now := clock_timestamp();   -- read after the lock, see complete_task
  perform public.expire_stale_settlements(v_me.room_id);

  select * into v_s from public.settlements
   where id = p_id and room_id = v_me.room_id for update;
  if not found then
    raise exception 'SETTLEMENT_NOT_FOUND';
  end if;
  if v_s.status <> 'pending' then
    raise exception 'SETTLEMENT_NOT_PENDING';
  end if;
  if v_s.proposed_by = v_me.id then
    raise exception 'NOT_ALLOWED';
  end if;

  if coalesce(p_accept, false) then
    update public.settlements
       set status = 'confirmed',
           amount_slot1_net = public.total_net_slot1(v_me.room_id),
           confirmed_at = v_now,
           responded_by = v_me.id
     where id = v_s.id
    returning * into v_s;
  else
    update public.settlements
       set status = 'rejected', responded_by = v_me.id
     where id = v_s.id
    returning * into v_s;
  end if;
  return v_s;
end $$;

-- Either member; only the most recent confirmed one; within 24 h of confirmation.
create or replace function public.undo_settlement(p_id uuid)
returns public.settlements
language plpgsql security definer
set search_path = public
as $$
declare
  v_me public.members := public._me();
  v_s  public.settlements;
begin
  perform 1 from public.rooms where id = v_me.room_id for update;

  select * into v_s from public.settlements
   where id = p_id and room_id = v_me.room_id for update;
  if not found then
    raise exception 'SETTLEMENT_NOT_FOUND';
  end if;
  if v_s.status <> 'confirmed' then
    raise exception 'SETTLEMENT_NOT_CONFIRMED';
  end if;
  if exists (select 1 from public.settlements
             where room_id = v_s.room_id and status = 'confirmed' and confirmed_at > v_s.confirmed_at) then
    raise exception 'NOT_LATEST_SETTLEMENT';
  end if;
  if now() > v_s.confirmed_at + interval '24 hours' then
    raise exception 'UNDO_WINDOW_PASSED';
  end if;

  update public.settlements set status = 'undone', undone_at = now()
   where id = v_s.id returning * into v_s;
  return v_s;
end $$;

-- ---------------------------------------------------------------------
-- 5. Settings & push subscriptions
-- ---------------------------------------------------------------------

-- Both parameters optional (null = keep). Returns the fresh get_state().
create or replace function public.update_settings(p_display_name text default null,
                                                  p_daily_reminder_time time default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_name text := btrim(p_display_name);
begin
  if p_display_name is not null then
    if char_length(v_name) not between 1 and 6 then
      raise exception 'BAD_NAME';
    end if;
    update public.members set display_name = v_name where id = v_me.id;
  end if;
  if p_daily_reminder_time is not null then
    update public.rooms
       set daily_reminder_time = make_time(extract(hour from p_daily_reminder_time)::int,
                                           extract(minute from p_daily_reminder_time)::int, 0)
     where id = v_me.room_id;
  end if;
  return public.get_state();
end $$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text,
                                                         p_user_agent text default null)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_me public.members := public._me();
  v_id uuid;
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'BAD_SUBSCRIPTION';
  end if;
  -- same endpoint = same browser; it moves to whoever saved it last
  insert into public.push_subscriptions(member_id, endpoint, p256dh, auth, user_agent)
  values (v_me.id, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, disabled_at = null
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_me public.members := public._me();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and member_id = v_me.id;
end $$;

-- ---------------------------------------------------------------------
-- 6. Reads: get_state(), list_history()
-- ---------------------------------------------------------------------

create or replace function public.get_state()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me      public.members := public._me();
  v_partner public.members;
  v_room    public.rooms;
  v_sign    int;
  v_ws      timestamptz;
  v_bound   timestamptz;
  v_pending public.settlements;
  v_last    public.settlements;
  v_counts  jsonb;
begin
  select * into v_room from public.rooms where id = v_me.room_id;
  v_partner := public._partner_of(v_me.room_id, v_me.id);
  v_sign    := case when v_me.slot = 1 then 1 else -1 end;
  v_ws      := public.week_start_for(v_room.id);
  v_bound   := public.settlement_boundary(v_room.id);

  select jsonb_object_agg(case when owner_id = v_me.id then 'me' else 'partner' end,
                          jsonb_build_object('week', week, 'total', total))
    into v_counts
  from (
    select t.owner_id,
           count(*) filter (where t.completed_at >= v_ws)::int as week,
           count(*) filter (where v_bound is null or t.completed_at > v_bound)::int as total
    from public.tasks t
    where t.room_id = v_room.id and t.status = 'done' and t.deleted_at is null
    group by t.owner_id
  ) c;

  -- a pending proposal older than 7 days is treated as expired even before the cron runs
  select * into v_pending from public.settlements
   where room_id = v_room.id and status = 'pending' and proposed_at > now() - interval '7 days';
  select * into v_last from public.settlements
   where room_id = v_room.id and status = 'confirmed'
   order by confirmed_at desc limit 1;

  return jsonb_build_object(
    'server_now',  now(),
    'room',        public._room_json(v_room),
    'me',          public._member_json(v_me),
    'partner',     public._member_json(v_partner),
    'week_start',  v_ws,
    'week_end',    (date_trunc('week', now() at time zone v_room.timezone) + interval '7 days') at time zone v_room.timezone,
    'week_net_me', v_sign * public.week_net_slot1(v_room.id),
    'total_net_me', v_sign * public.total_net_slot1(v_room.id),
    'done_counts', jsonb_build_object(
                     'me',      coalesce(v_counts -> 'me',      '{"week":0,"total":0}'::jsonb),
                     'partner', coalesce(v_counts -> 'partner', '{"week":0,"total":0}'::jsonb)),
    'streaks',     jsonb_build_object(
                     'me',      public.member_streak(v_me.id),
                     'partner', case when v_partner.id is null then 0 else public.member_streak(v_partner.id) end),
    'active_task_count', public.badge_count(v_me.id),
    'pending_settlement', case when v_pending.id is null then null else jsonb_build_object(
                     'id', v_pending.id,
                     'proposed_by', v_pending.proposed_by,
                     'proposed_by_me', v_pending.proposed_by = v_me.id,
                     'proposed_at', v_pending.proposed_at,
                     'expires_at', v_pending.proposed_at + interval '7 days') end,
    'last_confirmed_settlement', case when v_last.id is null then null else jsonb_build_object(
                     'id', v_last.id,
                     'amount_slot1_net', v_last.amount_slot1_net,
                     'amount_me', v_sign * v_last.amount_slot1_net,
                     'confirmed_at', v_last.confirmed_at,
                     'proposed_by', v_last.proposed_by,
                     'responded_by', v_last.responded_by,
                     'can_undo', now() <= v_last.confirmed_at + interval '24 hours',
                     'undo_until', v_last.confirmed_at + interval '24 hours') end
  );
end $$;

-- Done / abandoned / overdue tasks of both members plus non-pending settlements,
-- newest first. Keyset pagination: pass the last item's "at" as p_before for the
-- next page. Items sharing the boundary timestamp are always returned together,
-- so a page can be slightly longer than p_limit but nothing is ever skipped.
create or replace function public.list_history(p_before timestamptz default null, p_limit int default 30)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me     public.members := public._me();
  v_before timestamptz := coalesce(p_before, 'infinity'::timestamptz);
  v_limit  int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_sign   int := case when v_me.slot = 1 then 1 else -1 end;
  v_result jsonb;
begin
  with items as (
  select 'task' as type, t.id,
         case t.status when 'done' then t.completed_at when 'abandoned' then t.abandoned_at else t.due_at end as at,
         jsonb_build_object(
           'type', 'task', 'id', t.id,
           'status', case when t.status = 'active' then 'overdue' else t.status end,
           'owner_id', t.owner_id, 'owner_slot', m.slot, 'mine', t.owner_id = v_me.id,
           'title', t.title, 'value', t.value, 'due_at', t.due_at, 'created_at', t.created_at,
           'completed_at', t.completed_at, 'abandoned_at', t.abandoned_at,
           'requires_proof', t.requires_proof, 'proof_path', t.proof_path, 'proof_expired', t.proof_expired,
           'disputed', t.disputed, 'disputed_at', t.disputed_at) as data
  from public.tasks t join public.members m on m.id = t.owner_id
  where t.room_id = v_me.room_id and t.deleted_at is null
    and (t.status in ('done', 'abandoned') or t.due_at <= now())
    and case t.status when 'done' then t.completed_at when 'abandoned' then t.abandoned_at else t.due_at end < v_before
  union all
  select 'settlement', s.id, coalesce(s.undone_at, s.confirmed_at, s.proposed_at),
         jsonb_build_object(
           'type', 'settlement', 'id', s.id, 'status', s.status,
           'proposed_by', s.proposed_by, 'responded_by', s.responded_by,
           'amount_slot1_net', s.amount_slot1_net, 'amount_me', v_sign * s.amount_slot1_net,
           'proposed_at', s.proposed_at, 'confirmed_at', s.confirmed_at, 'undone_at', s.undone_at)
  from public.settlements s
  where s.room_id = v_me.room_id
    and (s.status <> 'pending' or s.proposed_at <= now() - interval '7 days')
    and coalesce(s.undone_at, s.confirmed_at, s.proposed_at) < v_before
  ),
  page as (select at from items order by at desc limit v_limit)
  select coalesce(jsonb_agg(i.data || jsonb_build_object('at', i.at) order by i.at desc, i.type, i.id), '[]'::jsonb)
    into v_result
  from items i
  where i.at >= (select min(at) from page);
  return v_result;
end $$;

-- Convenience view: tasks with a server-computed overdue flag. security_invoker
-- means the caller's RLS applies (own room only).
create or replace view public.task_states with (security_invoker = true) as
  select t.*,
         (t.status = 'active' and t.due_at <= now()) as is_overdue,
         case when t.status = 'active' and t.due_at <= now() then 'overdue' else t.status end as display_status
  from public.tasks t
  where t.deleted_at is null;

-- ---------------------------------------------------------------------
-- 7. Notifications
-- ---------------------------------------------------------------------

-- Insert one outbox row. payload always carries title/body/url/badge.
-- (badge is filled now; send-push may recompute with public.badge_count() at send time)
create or replace function public._enqueue(p_recipient uuid, p_kind text, p_title text, p_body text,
                                           p_extra jsonb default '{}'::jsonb)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.notification_outbox(recipient_id, kind, payload)
  select p_recipient, p_kind,
         jsonb_build_object('title', p_title, 'body', p_body, 'url', './',
                            'badge', public.badge_count(p_recipient), 'kind', p_kind) || coalesce(p_extra, '{}'::jsonb)
  where p_recipient is not null
$$;

-- tasks: partner_done, partner_dispute
create or replace function public._tasks_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner   public.members;
  v_partner public.members;
begin
  select * into v_owner from public.members where id = new.owner_id;
  v_partner := public._partner_of(new.room_id, new.owner_id);

  if new.status = 'done' and old.status <> 'done' then
    perform public._enqueue(v_partner.id, 'partner_done',
      v_owner.display_name || ' 完成了任務',
      '「' || new.title || '」+NT$ ' || new.value,
      jsonb_build_object('task_id', new.id, 'tag', 'partner_done:' || new.id, 'url', './#history'));
  end if;

  if new.disputed and not old.disputed then
    perform public._enqueue(new.owner_id, 'partner_dispute',
      coalesce(v_partner.display_name, '對方') || ' 對你的任務有疑問',
      '「' || new.title || '」',
      jsonb_build_object('task_id', new.id, 'tag', 'partner_dispute:' || new.id, 'url', './#history'));
  end if;
  return null;
end $$;

drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify
  after update of status, disputed on public.tasks
  for each row execute function public._tasks_notify();

-- settlements: settlement_request, settlement_result
create or replace function public._settlements_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_proposer public.members;
  v_other    public.members;
  v_amount   int;
  v_actor    uuid := auth.uid();
  m          public.members;
begin
  select * into v_proposer from public.members where id = new.proposed_by;
  v_other := public._partner_of(new.room_id, new.proposed_by);

  if tg_op = 'INSERT' then
    v_amount := public.total_net_slot1(new.room_id) * case when v_other.slot = 1 then 1 else -1 end;
    perform public._enqueue(v_other.id, 'settlement_request',
      v_proposer.display_name || ' 想要結算',
      case when v_amount > 0 then '你領先 NT$ ' || v_amount
           when v_amount < 0 then v_proposer.display_name || ' 領先 NT$ ' || abs(v_amount)
           else '目前平手' end || '，點開確認',
      jsonb_build_object('settlement_id', new.id, 'tag', 'settlement:' || new.id));
    return null;
  end if;

  if old.status = 'pending' and new.status = 'confirmed' then
    perform public._enqueue(new.proposed_by, 'settlement_result',
      '結算已確認', coalesce(v_other.display_name, '對方') || ' 同意了結算，總差距歸零',
      jsonb_build_object('settlement_id', new.id, 'tag', 'settlement:' || new.id, 'result', 'confirmed'));
  elsif old.status = 'pending' and new.status = 'rejected' then
    perform public._enqueue(new.proposed_by, 'settlement_result',
      '結算未成立',
      case when new.responded_by is null then '7 天內沒有回應，結算已自動取消'
           else coalesce(v_other.display_name, '對方') || ' 拒絕了結算' end,
      jsonb_build_object('settlement_id', new.id, 'tag', 'settlement:' || new.id,
                         'result', case when new.responded_by is null then 'expired' else 'rejected' end));
  elsif old.status = 'confirmed' and new.status = 'undone' then
    -- tell everyone in the room except whoever pressed undo
    for m in select * from public.members where room_id = new.room_id
                                            and (v_actor is null or id <> v_actor) loop
      perform public._enqueue(m.id, 'settlement_result',
        '結算已撤銷', '上一次結算被撤銷，總差距已恢復',
        jsonb_build_object('settlement_id', new.id, 'tag', 'settlement:' || new.id, 'result', 'undone'));
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists settlements_notify on public.settlements;
create trigger settlements_notify
  after insert or update of status on public.settlements
  for each row execute function public._settlements_notify();

-- notification_outbox: POST {outbox_id} to the Edge Function send-push via pg_net.
-- Does nothing (row stays unsent) when app_config is empty, pg_net is missing,
-- or the GUC studybet.disable_push = 'on' (tests, seed). Never blocks the caller.
create or replace function public._outbox_dispatch()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_base   text;
  v_secret text;
begin
  if coalesce(current_setting('studybet.disable_push', true), '') = 'on' then
    return null;
  end if;
  select value into v_base   from public.app_config where key = 'edge_function_base_url';
  select value into v_secret from public.app_config where key = 'function_secret';
  if coalesce(btrim(v_base), '') = '' or coalesce(btrim(v_secret), '') = '' then
    return null;
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'net' and p.proname = 'http_post') then
    return null;
  end if;

  begin
    perform net.http_post(
      url     := rtrim(btrim(v_base), '/') || '/send-push',
      body    := jsonb_build_object('outbox_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_secret,
                                    'x-function-secret', v_secret),
      timeout_milliseconds := 5000);
  exception when others then
    raise warning 'send-push dispatch failed for outbox %: %', new.id, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists notification_outbox_dispatch on public.notification_outbox;
create trigger notification_outbox_dispatch
  after insert on public.notification_outbox
  for each row execute function public._outbox_dispatch();

-- Timed reminders. Called every minute by Part C's Edge Function `tick`
-- (or by pg_cron through it). Each (task, kind) fires once thanks to
-- notification_log; daily fires once per (member, local date). Concurrent
-- calls are safe: the dedupe inserts use ON CONFLICT DO NOTHING, so only the
-- caller that wins the insert creates the outbox row.
-- Returns the number of outbox rows created.
-- p_only_room limits the run to one room (tests use it); tick calls it with no argument.
-- Tasks created less than 15 minutes ago get no due_1h / due_15m (the user
-- just set the deadline; no need to remind them). overdue is not affected.
-- Executable by service_role only (see privileges at the end of this file).
drop function if exists public.claim_due_notifications();   -- an older zero-argument version, if any
create or replace function public.claim_due_notifications(p_only_room uuid default null)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_tasks int;
  v_daily int;
begin
  perform public.expire_stale_settlements(p_only_room);

  with cand as (
    select t.id, t.owner_id, t.title, t.value, t.due_at, r.timezone as tz,
           case when t.due_at <= v_now                         then 'overdue'
                when t.due_at <= v_now + interval '15 minutes' then 'due_15m'
                else 'due_1h' end as kind
    from public.tasks t join public.rooms r on r.id = t.room_id
    where t.status = 'active' and t.deleted_at is null
      and (p_only_room is null or t.room_id = p_only_room)
      and t.due_at >  v_now - interval '1 hour'      -- "just became overdue"
      and t.due_at <= v_now + interval '60 minutes'
      and (t.due_at <= v_now                                     -- overdue: always
           or t.created_at <= v_now - interval '15 minutes')     -- due_1h / due_15m: not for fresh tasks
  ),
  logged as (
    insert into public.notification_log(task_id, kind)
    select id, kind from cand
    on conflict (task_id, kind) do nothing
    returning task_id, kind
  ),
  ins as (
    insert into public.notification_outbox(recipient_id, kind, payload)
    select c.owner_id, c.kind,
           jsonb_build_object(
             'title', case c.kind when 'due_1h'  then '還剩 1 小時'
                                  when 'due_15m' then '只剩 15 分鐘！'
                                  else '任務已逾期' end,
             'body',  case c.kind when 'overdue' then '「' || c.title || '」已過截止時間，不計分'
                                  else '「' || c.title || '」NT$ ' || c.value || '，'
                                       || to_char(c.due_at at time zone c.tz, 'HH24:MI') || ' 截止' end,
             'url',   './',
             'badge', public.badge_count(c.owner_id),
             'kind',  c.kind,
             'task_id', c.id,
             'tag',   c.kind || ':' || c.id)
    from logged l join cand c on c.id = l.task_id and c.kind = l.kind
    returning 1
  )
  select count(*) into v_tasks from ins;

  with cand as (
    select m.id as member_id, (v_now at time zone r.timezone)::date as local_date,
           public.badge_count(m.id) as n
    from public.members m join public.rooms r on r.id = m.room_id
    where (p_only_room is null or m.room_id = p_only_room)
      and ((v_now at time zone r.timezone)::time - r.daily_reminder_time)
            between interval '0' and interval '59 minutes 59 seconds'
  ),
  logged as (
    insert into public.daily_reminder_log(member_id, local_date)
    select member_id, local_date from cand where n >= 1
    on conflict (member_id, local_date) do nothing
    returning member_id
  ),
  ins as (
    insert into public.notification_outbox(recipient_id, kind, payload)
    select c.member_id, 'daily',
           jsonb_build_object('title', '今天的任務',
                              'body',  '你還有 ' || c.n || ' 個任務在進行中',
                              'url',   './', 'badge', c.n, 'kind', 'daily',
                              'tag',   'daily:' || c.local_date)
    from logged l join cand c on c.member_id = l.member_id
    returning 1
  )
  select count(*) into v_daily from ins;

  return v_tasks + v_daily;
end $$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security (read-only for room members)
-- ---------------------------------------------------------------------
alter table public.rooms               enable row level security;
alter table public.members             enable row level security;
alter table public.tasks               enable row level security;
alter table public.settlements         enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_log    enable row level security;
alter table public.app_config          enable row level security;
alter table public.pairing_attempts    enable row level security;
alter table public.daily_reminder_log  enable row level security;

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms
  for select to authenticated using (id = (select public.my_room_id()));

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (room_id = (select public.my_room_id()));

-- deleted tasks stay visible (with deleted_at set) so the Realtime UPDATE that
-- soft-deletes a task still reaches both clients; filter deleted_at in the UI.
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated using (room_id = (select public.my_room_id()));

drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements
  for select to authenticated using (room_id = (select public.my_room_id()));

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated using (member_id = (select auth.uid()));
-- notification_outbox, notification_log, app_config, pairing_attempts,
-- daily_reminder_log: no policies → invisible to clients.

-- ---------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------
-- Tables: no direct writes for anyone but the owner / service_role.
revoke all on public.rooms, public.members, public.tasks, public.settlements,
              public.push_subscriptions, public.notification_outbox, public.notification_log,
              public.app_config, public.pairing_attempts, public.daily_reminder_log
  from public, anon, authenticated;
grant select (id, timezone, daily_reminder_time, created_at) on public.rooms to authenticated;  -- never code_hash
grant select on public.members, public.tasks, public.settlements, public.push_subscriptions to authenticated;
grant select on public.task_states to authenticated;
revoke all on public.task_states from anon;
revoke all on all sequences in schema public from anon, authenticated;

-- Functions: Supabase grants EXECUTE on new functions to anon/authenticated by
-- default. Take it all away, then hand back only the public RPCs.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function
  public.create_room(text, text),
  public.join_room(text, text, smallint),
  public.create_task(text, int, timestamptz, bool),
  public.complete_task(uuid, text),
  public.abandon_task(uuid),
  public.delete_task(uuid),
  public.dispute_task(uuid, bool),
  public.propose_settlement(),
  public.respond_settlement(uuid, bool),
  public.undo_settlement(uuid),
  public.update_settings(text, time),
  public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text),
  public.get_state(),
  public.list_history(timestamptz, int),
  public.my_room_id()                    -- used inside RLS policies
to authenticated;

-- 03_storage.sql's policy helper, when 02 is re-run after 03
do $$
begin
  if to_regprocedure('public.proof_object_allowed(text, boolean)') is not null then
    grant execute on function public.proof_object_allowed(text, boolean) to authenticated;
  end if;
end $$;

-- Server-side only: Part C's tick / send-push call these with the service role key.
-- Revoked from PUBLIC/anon/authenticated above; granted to service_role only.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_due_notifications(uuid), public.badge_count(uuid),
                              public.expire_stale_settlements(uuid)
      to service_role;
  end if;
end $$;
