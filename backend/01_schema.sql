-- =====================================================================
-- 賭讀 / StudyBet — 01_schema.sql
-- Tables, constraints, indexes, Realtime publication.
-- Run first. Safe to re-run (uses IF NOT EXISTS everywhere).
-- Names follow CONTRACT.md exactly.
-- =====================================================================

-- pgcrypto: bcrypt for pairing codes. Supabase keeps extensions in schema "extensions".
create extension if not exists pgcrypto with schema extensions;

-- pg_net: used by the notification_outbox trigger (02) and the cron jobs (04, 99).
-- Optional: if it is not available the app still works, pushes just stay unsent.
do $$
begin
  create extension if not exists pg_net with schema extensions;   -- functions still live in schema "net"
exception when others then
  raise warning 'pg_net could not be enabled (%). Push sending via trigger is disabled. See README-backend.md "Fallbacks".', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id                  uuid primary key default gen_random_uuid(),
  code_hash           text not null,
  timezone            text not null default 'Asia/Taipei',
  daily_reminder_time time not null default '21:00',
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- members  (id = auth.uid() of the anonymous user)
-- ---------------------------------------------------------------------
create table if not exists public.members (
  id           uuid primary key,
  room_id      uuid not null references public.rooms(id) on delete cascade,
  slot         smallint not null check (slot in (1, 2)),
  display_name text not null check (char_length(display_name) between 1 and 6),
  created_at   timestamptz not null default now(),
  unique (room_id, slot)
);
create index if not exists members_room_idx on public.members(room_id);

-- ---------------------------------------------------------------------
-- tasks
-- All FKs to members use ON UPDATE CASCADE so join_room slot reclaim
-- (members.id changes to the new anonymous uid) carries the history over.
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms(id) on delete cascade,
  owner_id       uuid not null references public.members(id) on update cascade on delete cascade,
  title          text not null check (char_length(title) between 1 and 40),
  value          int  not null check (value between 1 and 50),
  due_at         timestamptz not null,
  requires_proof bool not null default false,
  status         text not null default 'active' check (status in ('active', 'done', 'abandoned')),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  abandoned_at   timestamptz,
  deleted_at     timestamptz,
  proof_path     text,
  disputed       bool not null default false,
  disputed_at    timestamptz,
  proof_expired  bool not null default false,
  -- state consistency: a done task always has completed_at, strictly before its deadline
  constraint tasks_done_consistent check (
    (status = 'done') = (completed_at is not null)
    and (completed_at is null or completed_at < due_at)
  ),
  constraint tasks_abandoned_consistent check ((status = 'abandoned') = (abandoned_at is not null)),
  constraint tasks_deleted_only_active  check (deleted_at is null or status = 'active'),
  constraint tasks_dispute_only_done    check (not disputed or status = 'done'),
  constraint tasks_proof_when_required  check (not requires_proof or status <> 'done' or proof_path is not null)
);

-- Indexes required by CONTRACT / performance targets
create index if not exists tasks_room_status_due_idx   on public.tasks(room_id, status, due_at);
create index if not exists tasks_owner_completed_idx   on public.tasks(owner_id, completed_at);
-- claim_due_notifications(): scans active tasks across all rooms by deadline
create index if not exists tasks_active_due_idx        on public.tasks(due_at)
  where status = 'active' and deleted_at is null;
-- list_history() and score windows per room
create index if not exists tasks_room_completed_idx    on public.tasks(room_id, completed_at)
  where status = 'done';

-- ---------------------------------------------------------------------
-- settlements
-- ---------------------------------------------------------------------
create table if not exists public.settlements (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null references public.rooms(id) on delete cascade,
  proposed_by      uuid not null references public.members(id) on update cascade on delete cascade,
  status           text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'undone')),
  amount_slot1_net int,
  proposed_at      timestamptz not null default now(),
  confirmed_at     timestamptz,
  responded_by     uuid references public.members(id) on update cascade on delete set null,
  undone_at        timestamptz,
  constraint settlements_confirmed_consistent check (
    (status in ('confirmed', 'undone')) = (confirmed_at is not null and amount_slot1_net is not null)
  ),
  constraint settlements_undone_consistent check ((status = 'undone') = (undone_at is not null))
);
create index if not exists settlements_room_confirmed_idx on public.settlements(room_id, confirmed_at);
-- only one pending proposal per room (also protects against concurrent propose calls)
create unique index if not exists settlements_one_pending_idx on public.settlements(room_id) where status = 'pending';

-- ---------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  member_id       uuid not null references public.members(id) on update cascade on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  disabled_at     timestamptz
);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions(member_id);

-- ---------------------------------------------------------------------
-- notification_outbox
-- ---------------------------------------------------------------------
create table if not exists public.notification_outbox (
  id           bigint generated always as identity primary key,
  recipient_id uuid not null references public.members(id) on update cascade on delete cascade,
  kind         text not null check (kind in ('due_1h', 'due_15m', 'partner_done', 'partner_dispute',
                                             'overdue', 'daily', 'settlement_request', 'settlement_result')),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  error        text
);
create index if not exists notification_outbox_unsent_idx on public.notification_outbox(created_at) where sent_at is null;
create index if not exists notification_outbox_sent_idx   on public.notification_outbox(sent_at) where sent_at is not null;

-- ---------------------------------------------------------------------
-- notification_log  (dedupe for timed task reminders)
-- ---------------------------------------------------------------------
create table if not exists public.notification_log (
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind    text not null,
  sent_at timestamptz not null default now(),
  primary key (task_id, kind)
);

-- ---------------------------------------------------------------------
-- app_config  (filled in by the deployer, see README step 6)
--   edge_function_base_url  e.g. https://abcd.supabase.co/functions/v1
--   function_secret         shared secret checked by Part C's functions
-- No other secrets belong here (in particular never the service role key).
-- RLS on, no policies, no grants for anon/authenticated (see 02).
-- ---------------------------------------------------------------------
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------------
-- Internal tables (not part of the shared contract; never exposed to clients)
-- ---------------------------------------------------------------------
-- failed pairing attempts, for the 5-per-10-minutes limit
create table if not exists public.pairing_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  attempted_at timestamptz not null default now()
);
create index if not exists pairing_attempts_user_idx on public.pairing_attempts(user_id, attempted_at);

-- daily reminder dedupe: one per member per Taipei date
create table if not exists public.daily_reminder_log (
  member_id  uuid not null references public.members(id) on update cascade on delete cascade,
  local_date date not null,
  sent_at    timestamptz not null default now(),
  primary key (member_id, local_date)
);

-- ---------------------------------------------------------------------
-- Realtime: publish tasks, settlements, members
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['tasks', 'settlements', 'members'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- full old row in UPDATE events (lets clients see what changed, e.g. a reclaimed member id)
alter table public.tasks       replica identity full;
alter table public.settlements replica identity full;
alter table public.members     replica identity full;
