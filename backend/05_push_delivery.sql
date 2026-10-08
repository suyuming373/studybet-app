-- =====================================================================
-- 賭讀 / StudyBet — 05_push_delivery.sql   (Part C addition)
-- Delivery bookkeeping for the Edge Functions send-push and tick.
--
-- Run ONCE after 01–04 (before deploying the Edge Functions). Safe to re-run.
-- Purely additive: two new columns on notification_outbox, three new
-- functions. Nothing in 01–04 changes. All three functions are executable by
-- service_role only, so tests.sql's "authenticated can execute exactly …"
-- check still passes.
--
--   claim_outbox(p_id, p_min_age, p_limit)  hand each unsent row to exactly one sender
--   finish_outbox(p_id, p_ok, p_error)      record the result of that attempt
--   push_context(p_outbox_id)               everything send-push needs to word the message
-- =====================================================================

alter table public.notification_outbox
  add column if not exists attempts        int not null default 0,
  add column if not exists claimed_at      timestamptz,
  add column if not exists last_attempt_at timestamptz;

comment on column public.notification_outbox.attempts   is 'delivery attempts so far (max 3, then the row stays unsent with error set)';
comment on column public.notification_outbox.claimed_at is 'set while a sender owns the row; a claim older than 2 minutes is considered abandoned';

-- Claim rows for sending. Each row goes to exactly one caller (FOR UPDATE SKIP
-- LOCKED + claimed_at), and attempts is counted at claim time, so a crash
-- mid-send still uses up an attempt.
--   p_id given      → just that row (send-push, right after the insert trigger)
--   p_id null       → the sweep: unsent rows older than p_min_age (tick)
-- Rows with 3 attempts are never returned again.
create or replace function public.claim_outbox(p_id bigint default null,
                                               p_min_age interval default '30 seconds',
                                               p_limit int default 25)
returns setof public.notification_outbox
language plpgsql security definer
set search_path = public
as $$
begin
  return query
  with c as (
    select o.id
    from public.notification_outbox o
    where o.sent_at is null
      and o.attempts < 3
      and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes')
      and (case when p_id is not null then o.id = p_id
                else o.created_at <= now() - coalesce(p_min_age, interval '30 seconds') end)
    order by o.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  )
  update public.notification_outbox o
     set attempts = o.attempts + 1, claimed_at = now(), last_attempt_at = now()
    from c
   where o.id = c.id
  returning o.*;
end $$;

-- Result of one attempt.
--   p_ok = true  → sent_at = now() (never touched again); p_error may still note
--                  e.g. NO_SUBSCRIPTION or a partly failed device
--   p_ok = false → released for a retry by the next tick (until attempts = 3)
create or replace function public.finish_outbox(p_id bigint, p_ok boolean, p_error text default null)
returns void
language sql security definer
set search_path = public
as $$
  update public.notification_outbox
     set sent_at    = case when p_ok then now() else null end,
         claimed_at = null,
         error      = left(p_error, 500)
   where id = p_id and sent_at is null;
$$;

-- Wording context for one outbox row, from the RECIPIENT's point of view,
-- computed at send time (so the gap in "你現在落後 NT$ 40" is current).
create or replace function public.push_context(p_outbox_id bigint)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  o public.notification_outbox;
  m public.members;
  p public.members;
  t public.tasks;
  v_next text;
begin
  select * into o from public.notification_outbox where id = p_outbox_id;
  if not found then return null; end if;
  select * into m from public.members where id = o.recipient_id;
  if not found then return null; end if;
  p := public._partner_of(m.room_id, m.id);
  if (o.payload ->> 'task_id') is not null then
    select * into t from public.tasks where id = (o.payload ->> 'task_id')::uuid;
  end if;
  select title into v_next from public.tasks
   where owner_id = m.id and status = 'active' and deleted_at is null and due_at > now()
   order by due_at limit 1;

  return jsonb_build_object(
    'outbox_id',    o.id,
    'kind',         o.kind,
    'payload',      o.payload,
    'recipient_id', m.id,
    'me_name',      m.display_name,
    'partner_name', p.display_name,
    'total_net_me', case when m.slot = 1 then 1 else -1 end * public.total_net_slot1(m.room_id),
    'badge',        public.badge_count(m.id),
    'next_title',   v_next,
    'task_title',   t.title,
    'task_value',   t.value);
end $$;

revoke all on function public.claim_outbox(bigint, interval, int)  from public, anon, authenticated;
revoke all on function public.finish_outbox(bigint, boolean, text) from public, anon, authenticated;
revoke all on function public.push_context(bigint)                 from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_outbox(bigint, interval, int),
                              public.finish_outbox(bigint, boolean, text),
                              public.push_context(bigint)
      to service_role;
  end if;
end $$;

-- Success: one row, attempts_column = true, functions = 3
select exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'notification_outbox' and column_name = 'attempts') as attempts_column,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('claim_outbox', 'finish_outbox', 'push_context')) as functions;
