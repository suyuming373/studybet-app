-- =====================================================================
-- 賭讀 / StudyBet — 06_dispute_and_daily.sql   (batch 2, app v1.2.0)
-- A. A disputed task pauses its money until the disputer clears the dispute.
-- B. Daily reminder on/off per member (the time stays shared per room).
--
-- Run ONCE after 01–05. Idempotent and additive: safe to re-run any number
-- of times. Files 01–05 are not edited; the functions below replace their
-- earlier versions in place (same names, same signatures) except
-- update_settings, which gains one optional parameter.
--
-- !! If you ever re-run 02_rls_and_rpc.sql, re-run this file afterwards.
--    02 would otherwise bring back the old function bodies, the old
--    2-argument update_settings and the full SELECT grant on members.
--
-- Contract changes are documented in CONTRACT.md → "ADDENDUM A8".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------

alter table public.members
  add column if not exists daily_reminder_enabled boolean not null default true;
comment on column public.members.daily_reminder_enabled is
  'per member: false = no daily reminder for this member. Only get_state().me exposes it; the partner cannot read it.';

-- Outbox kinds: + dispute_cleared. The original check constraint is unnamed in
-- 01, so drop whichever check on "kind" exists and add a named one.
do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.notification_outbox'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%kind%'
  loop
    execute format('alter table public.notification_outbox drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in (
    'due_1h', 'due_15m', 'partner_done', 'partner_dispute', 'dispute_cleared',
    'overdue', 'daily', 'settlement_request', 'settlement_result'));

-- The partner must not see my daily_reminder_enabled: members becomes
-- readable column by column (Realtime only delivers columns the subscriber
-- may SELECT). Every column except the new one stays readable.
revoke select on public.members from authenticated;
grant select (id, room_id, slot, display_name, created_at) on public.members to authenticated;

-- ---------------------------------------------------------------------
-- 2. Scoring: disputed done tasks count for nobody while disputed
-- ---------------------------------------------------------------------
-- A task counts in the window of its ORIGINAL completed_at once undisputed.
-- A task completed before the latest confirmed settlement stays outside the
-- total window even when its dispute is cleared later (see ADDENDUM A8).
-- done_counts and streaks are deliberately NOT affected by disputes.

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
    and not t.disputed
    and t.completed_at >= w.ws and t.completed_at < w.we
$$;

-- Used by get_state, propose_settlement (NOTHING_TO_SETTLE) and
-- respond_settlement (the frozen amount), so all three exclude disputed tasks.
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
    and not t.disputed
    and (b.at is null or t.completed_at > b.at)
$$;

-- ---------------------------------------------------------------------
-- 3. dispute_task: same signature; now serialized with settlements
-- ---------------------------------------------------------------------
-- Only the OTHER member (the disputer) may set or clear the flag; the owner
-- gets NOT_ALLOWED for both. The room lock (same as complete_task and
-- respond_settlement) makes "disputed at confirmation time" well defined.
create or replace function public.dispute_task(p_task_id uuid, p_disputed bool)
returns public.tasks
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   public.members := public._me();
  v_task public.tasks;
begin
  perform 1 from public.rooms where id = v_me.room_id for update;
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
-- 4. Settlements: propose / respond unchanged in shape, re-stated here so the
--    dispute rule is visible next to them. Both read total_net_slot1().
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
  -- disputed tasks are excluded: a gap made only of disputed tasks is 0
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
    -- Frozen amount excludes tasks disputed right now. Such a task was completed
    -- before confirmed_at, so it also stays out of the new total window after
    -- its dispute is cleared (it is excluded permanently, unless this
    -- settlement is undone).
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

-- ---------------------------------------------------------------------
-- 5. update_settings: + p_daily_reminder_enabled (null = keep)
-- ---------------------------------------------------------------------
-- The 2-argument version must go: with both present, a call naming only
-- p_display_name would match two functions and PostgREST would refuse it.
-- Callers that pass 1 or 2 arguments (by name or position) keep working.
drop function if exists public.update_settings(text, time);

create or replace function public.update_settings(p_display_name text default null,
                                                  p_daily_reminder_time time default null,
                                                  p_daily_reminder_enabled boolean default null)
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
    -- shared by both members of the room
    update public.rooms
       set daily_reminder_time = make_time(extract(hour from p_daily_reminder_time)::int,
                                           extract(minute from p_daily_reminder_time)::int, 0)
     where id = v_me.room_id;
  end if;
  if p_daily_reminder_enabled is not null then
    -- only the caller's own row
    update public.members set daily_reminder_enabled = p_daily_reminder_enabled where id = v_me.id;
  end if;
  return public.get_state();
end $$;

-- ---------------------------------------------------------------------
-- 6. get_state: me.daily_reminder_enabled (never the partner's) + disputed_pending
-- ---------------------------------------------------------------------
create or replace function public.get_state()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_me       public.members := public._me();
  v_partner  public.members;
  v_room     public.rooms;
  v_sign     int;
  v_ws       timestamptz;
  v_bound    timestamptz;
  v_pending  public.settlements;
  v_last     public.settlements;
  v_counts   jsonb;
  v_disputed jsonb;
begin
  select * into v_room from public.rooms where id = v_me.room_id;
  v_partner := public._partner_of(v_me.room_id, v_me.id);
  v_sign    := case when v_me.slot = 1 then 1 else -1 end;
  v_ws      := public.week_start_for(v_room.id);
  v_bound   := public.settlement_boundary(v_room.id);

  -- done counts include disputed tasks (disputes pause money, not counts)
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

  -- disputed tasks inside the current total window: what would come back if cleared
  select jsonb_build_object('count', count(*)::int,
                            'amount_me', coalesce(sum(case when t.owner_id = v_me.id then t.value else -t.value end), 0)::int)
    into v_disputed
  from public.tasks t
  where t.room_id = v_room.id and t.status = 'done' and t.deleted_at is null and t.disputed
    and (v_bound is null or t.completed_at > v_bound);

  -- a pending proposal older than 7 days is treated as expired even before the cron runs
  select * into v_pending from public.settlements
   where room_id = v_room.id and status = 'pending' and proposed_at > now() - interval '7 days';
  select * into v_last from public.settlements
   where room_id = v_room.id and status = 'confirmed'
   order by confirmed_at desc limit 1;

  return jsonb_build_object(
    'server_now',  now(),
    'room',        public._room_json(v_room),
    'me',          public._member_json(v_me) || jsonb_build_object('daily_reminder_enabled', v_me.daily_reminder_enabled),
    'partner',     public._member_json(v_partner),   -- no daily_reminder_enabled here, on purpose
    'week_start',  v_ws,
    'week_end',    (date_trunc('week', now() at time zone v_room.timezone) + interval '7 days') at time zone v_room.timezone,
    'week_net_me', v_sign * public.week_net_slot1(v_room.id),
    'total_net_me', v_sign * public.total_net_slot1(v_room.id),
    'disputed_pending', v_disputed,
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

-- ---------------------------------------------------------------------
-- 7. Notifications: partner_dispute says "暫不計分"; new dispute_cleared
-- ---------------------------------------------------------------------
create or replace function public._tasks_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner   public.members;
  v_partner public.members;
  v_bound   timestamptz;
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
      '「' || new.title || '」，暫不計分',
      jsonb_build_object('task_id', new.id, 'tag', 'partner_dispute:' || new.id, 'url', './#history'));
  end if;

  if old.disputed and not new.disputed then
    -- counted = false: completed before the latest settlement, so it does not come back
    v_bound := public.settlement_boundary(new.room_id);
    perform public._enqueue(new.owner_id, 'dispute_cleared',
      coalesce(v_partner.display_name, '對方') || ' 取消質疑',
      case when v_bound is null or new.completed_at > v_bound
           then '「' || new.title || '」+' || new.value || ' 已加回'
           else '「' || new.title || '」在上次結算前完成，不再計分' end,
      jsonb_build_object('task_id', new.id, 'tag', 'partner_dispute:' || new.id, 'url', './#history',
                         'counted', v_bound is null or new.completed_at > v_bound));
  end if;
  return null;
end $$;
-- (trigger tasks_notify from 02 already fires on "update of status, disputed")

-- ---------------------------------------------------------------------
-- 8. claim_due_notifications: daily only for members with it enabled
-- ---------------------------------------------------------------------
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
      and m.daily_reminder_enabled                                  -- batch 2: per-member switch
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
-- 9. Privileges (same audit as 02: clients get the contract RPCs only)
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE keeps existing grants; the new update_settings signature
-- is a new object and Supabase would hand it to anon by default.
revoke all on function public.update_settings(text, time, boolean)  from public, anon, authenticated;
grant execute on function public.update_settings(text, time, boolean) to authenticated;

-- Re-assert the rest so a re-run on any state ends identical.
revoke all on function public.week_net_slot1(uuid, timestamptz)     from public, anon, authenticated;
revoke all on function public.total_net_slot1(uuid)                 from public, anon, authenticated;
revoke all on function public._tasks_notify()                       from public, anon, authenticated;
revoke all on function public.claim_due_notifications(uuid)         from public, anon, authenticated;
revoke all on function public.dispute_task(uuid, bool)              from public, anon;
revoke all on function public.propose_settlement()                  from public, anon;
revoke all on function public.respond_settlement(uuid, bool)        from public, anon;
revoke all on function public.get_state()                           from public, anon;
grant execute on function public.dispute_task(uuid, bool), public.propose_settlement(),
                          public.respond_settlement(uuid, bool), public.get_state()
  to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_due_notifications(uuid) to service_role;
  end if;
end $$;

-- Success: one row, daily_column = true, update_settings_args = 3, dispute_cleared_kind = true
select exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'members' and column_name = 'daily_reminder_enabled') as daily_column,
       (select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'update_settings') as update_settings_args,
       (select pg_get_constraintdef(oid) like '%dispute_cleared%' from pg_constraint
         where conname = 'notification_outbox_kind_check') as dispute_cleared_kind;
