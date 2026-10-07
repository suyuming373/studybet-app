# 共用資料約定

SHARED DATA CONTRACT — "賭讀 / StudyBet" (read fully; names below are binding across all three parts)

Product: a two-person study-bet app. Each person adds tasks with a value (NT$1–50) and a deadline; finishing a task before its deadline earns that value. Money is settled in real life; the app only keeps score. There is no automatic penalty: an overdue task is only labelled "overdue" and never changes the score.

Hosting: static PWA on GitHub Pages (https://<user>.github.io/<repo>/, subpath-safe, relative URLs). Backend: Supabase free tier (Postgres, Realtime, Anonymous Auth, Storage, pg_cron, pg_net, Edge Functions). No credit card anywhere. Frontend config lives in config.js: SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY.

Time rules: store timestamptz (UTC). All calendar logic uses Asia/Taipei (rooms.timezone, default 'Asia/Taipei'). Week = Monday 00:00 to Sunday 23:59:59 Taipei (use date_trunc('week', ts AT TIME ZONE tz)). A task belongs to the week/day of its completed_at. Deadlines are judged ONLY by the server clock (now()).

Tables (public schema):
- rooms(id uuid pk, code_hash text, timezone text default 'Asia/Taipei', daily_reminder_time time default '21:00', created_at)
- members(id uuid pk = auth.uid() of the anonymous user, room_id, slot smallint check in (1,2), display_name text 1–6 chars, created_at; unique(room_id, slot)). A room never has more than 2 members.
- tasks(id uuid pk, room_id, owner_id, title text 1–40 chars, value int check 1..50, due_at timestamptz, requires_proof bool default false, status text check in ('active','done','abandoned') default 'active', created_at, completed_at, abandoned_at, deleted_at, proof_path text, disputed bool default false, disputed_at, proof_expired bool default false). "Overdue" is DERIVED: status='active' and due_at <= now(). Overdue tasks are never completable and are shown in History.
- settlements(id uuid pk, room_id, proposed_by, status text check in ('pending','confirmed','rejected','undone'), amount_slot1_net int (frozen at confirmation: slot-1 net minus slot-2 net, NT$), proposed_at, confirmed_at, responded_by, undone_at)
- push_subscriptions(id, member_id, endpoint unique, p256dh, auth, user_agent, created_at, last_success_at, disabled_at)
- notification_outbox(id bigint identity, recipient_id, kind text, payload jsonb, created_at, sent_at, error text)
- notification_log(task_id, kind, sent_at, primary key(task_id, kind))  -- dedupe for timed reminders
- app_config(key text pk, value text)  -- holds edge_function_base_url and function_secret, filled in by the deployer

Scoring (single net number, never two separate scores):
net_slot1 = sum(value of done tasks by slot 1) − sum(value of done tasks by slot 2), over a time window.
- Week net: window = current Taipei week. Resets itself every Monday 00:00; manual settlement does not affect it.
- Total net: window = tasks with completed_at after the latest confirmed, non-undone settlement's confirmed_at (or all time if none). Nothing is ever deleted by a settlement.
- Each viewer sees their own perspective: if I am +40 the other person is shown −40. The home headline is the TOTAL gap, e.g. "Ming leads you NT$ 40" / "You lead Ming NT$ 40" / "All square".
- Abandoned, overdue and deleted tasks never change any net.
- Streak: per member, count of consecutive Taipei calendar days ending today (or yesterday if today has none yet) with at least one done task by that member.

RPC functions (security definer, all writes go through these; direct INSERT/UPDATE/DELETE on tables is revoked for authenticated users):
- create_room(p_code text, p_display_name text) → room, member (slot 1)
- join_room(p_code text, p_display_name text, p_slot smallint default null) → member. Fills the free slot; if both slots are taken it lets the caller reclaim the slot given by p_slot (needed when iOS storage is cleared). Wrong code: generic error, max 5 attempts per 10 minutes per user.
- create_task(p_title, p_value, p_due_at, p_requires_proof) → task. due_at must be 5 minutes to 7 days in the future.
- complete_task(p_task_id, p_proof_path text default null) → task. Owner only; status active; now() < due_at; if requires_proof then p_proof_path is required; sets completed_at = now().
- abandon_task(p_task_id); delete_task(p_task_id) (owner, active, within 5 minutes of created_at; soft delete)
- dispute_task(p_task_id, p_disputed bool): only the OTHER member; sets a badge flag; never changes scores.
- propose_settlement() → pending row (only one pending at a time; blocked when total net is 0)
- respond_settlement(p_id, p_accept bool): only the other member; accept freezes amount and sets confirmed_at = now().
- undo_settlement(p_id): either member, only the most recent confirmed one, within 24 hours.
- update_settings(p_display_name, p_daily_reminder_time)
- save_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent); remove_push_subscription(p_endpoint)
- get_state() → one jsonb: me, partner, week_start, week_net_me, total_net_me, done_counts, streaks, active task count (non-overdue, owner = me), pending settlement, last confirmed settlement.
- list_history(p_before timestamptz, p_limit int default 30) → done/abandoned/overdue tasks of both members and settlements, newest first.

Realtime: publish tasks, settlements, members. Clients subscribe by room_id and re-run get_state() on any event.

Storage: private bucket "proofs", path {room_id}/{task_id}.jpg, image/jpeg only, max 300 KB, readable/writable only by the room's two members, served via signed URLs (60 s). Proofs older than 30 days are deleted nightly and tasks.proof_expired is set.

Notification kinds (written to notification_outbox; payload carries title/body/url/badge):
due_1h, due_15m, partner_done, partner_dispute, overdue (owner only), daily (at rooms.daily_reminder_time Taipei, only if the member has ≥1 active non-overdue task), settlement_request, settlement_result.
Badge number = the recipient's count of active, non-overdue tasks, computed at send time.

Frontend module contract (so parts can be built separately): index.html, app.css, app.js, config.js, manifest.webmanifest, sw.js, push.js (exports enablePush(), getPushStatus(), syncBadge(n)), onboarding.js (exports showOnboarding()), sw-push.js (loaded by sw.js via importScripts). Part B ships push.js, onboarding.js and sw-push.js as clearly-marked stubs; Part C replaces them.

---

## CONTRACT ADDENDUM

Deviations and additions introduced by Part A (backend). No name or signature listed above was changed; everything below is either a clarification of behavior or a new server-side name. Parts B and C must follow these as binding too. Details: `backend/README-backend.md`.

### A1. Pairing errors arrive as HTTP 400, not as a raised exception
- `create_room` and `join_room` do not raise `BAD_CODE` / `CODE_TAKEN`. A raised error would roll back the failed-attempt counter behind the 5-per-10-minutes limit. They set HTTP status 400 and return the JSON body `{"code": "P0001", "message": "BAD_CODE", "details": null, "hint": null}` (or `"CODE_TAKEN"`). PostgREST commits the transaction in this case.
- **Frontend reads `error.message`**, exactly as for every other RPC error. supabase-js turns the 400 into `error`, so `error.message === 'BAD_CODE'`.
- `BAD_CODE` is also the answer when the room is full and no `p_slot` was given (no information leak).
- All other errors, including `RATE_LIMITED`, `CODE_TOO_SHORT`, `BAD_NAME` and `ALREADY_IN_ROOM`, are raised normally. The full list of stable error codes is in the README.

### A2. Return shapes (not specified above)
- `create_room` → `{room: {id, timezone, daily_reminder_time, created_at}, member: {id, slot, display_name, room_id, created_at}}`
- `join_room` → the member object `{id, slot, display_name, room_id, created_at}`
- Task RPCs return the task row; settlement RPCs return the settlement row.
- `update_settings` → a fresh `get_state()`.
- `get_state()` additionally carries `server_now`, `room`, `week_end`, `pending_settlement.proposed_by_me` / `expires_at` and `last_confirmed_settlement.amount_me` / `can_undo` / `undo_until`.
- `list_history` → JSON array of items `{type: 'task'|'settlement', at, …}`. Next page: pass the last item's `at` as `p_before`. Items sharing that timestamp are always returned together, so a page may exceed `p_limit` slightly.

### A3. Server-only functions (executable by `service_role` only)
`anon` and `authenticated` get `permission denied` for all of these:
- `claim_due_notifications(p_only_room uuid default null) → int`: the contract's reminder claim. `p_only_room` restricts the run to one room (used by tests). `tick` calls it **without arguments**.
- `list_expired_proofs(p_older_than interval default '30 days') → setof (task_id uuid, proof_path text)`: proofs to delete. Refuses intervals under 1 day (`BAD_INTERVAL`).
- `mark_proofs_expired(p_task_ids uuid[]) → int`: sets `tasks.proof_expired = true` after the files were removed. Keeps `proof_path`.
- `badge_count(p_member uuid) → int`: badge number at send time.
- `expire_stale_settlements(p_room uuid default null) → int`, `nightly_cleanup() → jsonb`.

### A4. Proof deletion is done by the Edge Function `tick`, not by SQL
Supabase blocks deleting storage files through SQL. `tick` therefore calls `list_expired_proofs()`, removes those paths from bucket `proofs` through the Storage API using `SUPABASE_SERVICE_ROLE_KEY`, then calls `mark_proofs_expired(task_ids)`. pg_cron still runs `nightly_cleanup()` at 03:30 Taipei: it purges sent outbox rows older than 14 days plus internal bookkeeping. **The service role key is never stored in the database.** `app_config` holds only `edge_function_base_url` and `function_secret`.

### A5. Reminder timing rules
- `due_1h`: 15–60 minutes left. `due_15m`: ≤ 15 minutes left.
- **Neither is sent for a task created less than 15 minutes ago.** It becomes eligible once 15 minutes old, if still inside a window.
- **`overdue` is sent only for tasks that became overdue within the last 1 hour**, to the owner only. Older overdue tasks never trigger a push; enabling the cron late does not flood.
- `daily` is sent at most once per member per Taipei date, within the hour after `rooms.daily_reminder_time`. The 1-active-task condition from the contract still applies.
- Each outbox row carries `payload.title/body/url/badge` plus `kind`, usually `tag`, and `task_id` or `settlement_id`. `url` is relative (`./` or `./#history`). Texts are Traditional Chinese.

### A6. Edge Function auth contract
- Every call from the database to an Edge Function sends the header **`Authorization: Bearer <function_secret>`**. This covers outbox → `send-push` with body `{"outbox_id": <id>}`, and pg_cron or the Cloudflare fallback → `tick`. An identical `x-function-secret: <function_secret>` header is sent too.
- `function_secret` is not a JWT, so **`tick` and `send-push` are deployed with `--no-verify-jwt`** and compare the secret themselves.
- `tick` receiving `{"job": "nightly"}` (Cloudflare fallback only, when pg_cron is unavailable) also calls `nightly_cleanup()`.

### A7. Other behavior clarifications
- **Reading data:** clients read tables with `select` (writes revoked). Soft-deleted tasks stay readable with `deleted_at` set, so the Realtime UPDATE reaches both phones; the UI filters them out. `rooms` is readable only through the columns `id, timezone, daily_reminder_time, created_at` (`code_hash` is hidden). View `task_states` adds a server-computed `is_overdue` / `display_status`.
- **`complete_task` with a proof** requires `p_proof_path = '{room_id}/{task_id}.jpg'` and the file to exist in bucket `proofs`. Errors: `BAD_PROOF_PATH`, `PROOF_MISSING`. Only the owner may upload, and only while the task is active.
- **`abandon_task`** is refused on overdue tasks (`TASK_OVERDUE`), so their history label stays "overdue".
- **Settlement auto-rejection** after 7 days leaves `responded_by = null`, and `get_state()` hides such a proposal immediately. In history, a settlement's `at` is `undone_at`, else `confirmed_at`, else `proposed_at`.
- **Settlement boundary:** `complete_task` and `respond_settlement` serialize on the room row and take `clock_timestamp()` after the lock. A task completed exactly at `confirmed_at` belongs to the settled period.
- **Internal tables** `pairing_attempts` and `daily_reminder_log` are invisible to clients.
