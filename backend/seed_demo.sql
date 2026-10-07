-- =====================================================================
--  !!!  DEMO DATA — DO NOT RUN IN PRODUCTION  !!!
-- =====================================================================
-- 賭讀 / StudyBet — seed_demo.sql
-- Creates one demo room with two fake members and sample tasks covering
-- every state (active, done this week, done last week, abandoned, overdue,
-- disputed, requires proof) plus one old confirmed settlement.
-- Re-running replaces the demo room (fixed ids). Pushes are not sent.
--
-- Pairing code of the demo room:  demo-studybet
--
-- To see it in the app: open the app, choose "join", type the code and pick
-- slot 1 ("I was here before"). join_room(p_code, p_name, 1) hands the slot-1
-- member and all its history to your anonymous user.
--
-- Remove everything again:
--   delete from public.rooms where id = '00000000-0000-4000-8000-00000000de00';
-- =====================================================================

do $$
declare
  v_room uuid := '00000000-0000-4000-8000-00000000de00';
  v_m1   uuid := '00000000-0000-4000-8000-00000000de01';   -- slot 1 "Ming"
  v_m2   uuid := '00000000-0000-4000-8000-00000000de02';   -- slot 2 "Hua"
  v_ws   timestamptz := date_trunc('week', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
begin
  perform set_config('studybet.disable_push', 'on', true);

  delete from public.rooms where id = v_room;

  insert into public.rooms(id, code_hash, timezone, daily_reminder_time)
  values (v_room, extensions.crypt('demo-studybet', extensions.gen_salt('bf', 8)), 'Asia/Taipei', '21:00');

  insert into public.members(id, room_id, slot, display_name, created_at) values
    (v_m1, v_room, 1, 'Ming', now() - interval '30 days'),
    (v_m2, v_room, 2, 'Hua',  now() - interval '30 days');

  -- an old confirmed settlement (20 days ago): only tasks after it count in the total
  insert into public.settlements(room_id, proposed_by, status, amount_slot1_net, proposed_at, confirmed_at, responded_by)
  values (v_room, v_m2, 'confirmed', 35, now() - interval '20 days 1 hour', now() - interval '20 days', v_m1);

  -- done before the settlement (history only, not in the total)
  insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at) values
    (v_room, v_m1, '微積分第 3 章習題', 25, now() - interval '24 days', 'done', now() - interval '26 days', now() - interval '25 days'),
    (v_room, v_m2, '英文單字 50 個',    10, now() - interval '23 days', 'done', now() - interval '24 days', now() - interval '23 days 2 hours');

  -- done last week (in total, not in week)
  insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at) values
    (v_room, v_m1, '物理講義讀完',       20, v_ws - interval '2 days',  'done', v_ws - interval '4 days', v_ws - interval '2 days 3 hours'),
    (v_room, v_m2, '化學實驗報告',       30, v_ws - interval '1 day',   'done', v_ws - interval '3 days', v_ws - interval '1 day 5 hours'),
    (v_room, v_m2, '背 30 個成語',        5, v_ws - interval '3 days',  'done', v_ws - interval '5 days', v_ws - interval '3 days 1 hour');

  -- done this week (completed a few minutes after Monday 00:00 or later, never in the future)
  insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, completed_at, requires_proof, disputed, disputed_at) values
    (v_room, v_m1, '統計作業 1',         15, least(now(), v_ws + interval '1 hour') + interval '2 hours', 'done',
       v_ws - interval '1 day', least(now(), v_ws + interval '1 hour'), false, false, null),
    (v_room, v_m2, '讀 20 頁原文書',      12, now() + interval '1 day', 'done',
       now() - interval '1 hour', now() - interval '10 minutes', false, true, now() - interval '5 minutes');

  -- abandoned and overdue (never count)
  insert into public.tasks(room_id, owner_id, title, value, due_at, status, created_at, abandoned_at) values
    (v_room, v_m1, '整理筆記', 8, now() + interval '2 days', 'abandoned', now() - interval '2 days', now() - interval '1 day');
  insert into public.tasks(room_id, owner_id, title, value, due_at, created_at) values
    (v_room, v_m2, '線代考古題', 40, now() - interval '3 hours', now() - interval '1 day');

  -- active
  insert into public.tasks(room_id, owner_id, title, value, due_at, created_at, requires_proof) values
    (v_room, v_m1, '程式設計作業',      30, now() + interval '50 minutes', now() - interval '2 hours', false),
    (v_room, v_m1, '拍讀書桌照片打卡',   5, now() + interval '6 hours',    now() - interval '1 hour',  true),
    (v_room, v_m2, '會計第 5 章',       20, now() + interval '2 days',     now() - interval '3 hours', false),
    (v_room, v_m2, '早上 7 點起床讀書', 10, now() + interval '14 hours',   now() - interval '30 minutes', false);
end $$;

select 'demo room ready — code: demo-studybet' as info,
       public.total_net_slot1('00000000-0000-4000-8000-00000000de00') as total_net_slot1,
       public.week_net_slot1('00000000-0000-4000-8000-00000000de00')  as week_net_slot1;
