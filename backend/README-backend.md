# 賭讀 / StudyBet — Backend (Part A)

Everything the app needs on Supabase: tables, security rules, scoring, the settlement flow, notification queue and nightly cleanup. All names follow `CONTRACT.md`.

| File | What it does | When to run |
|---|---|---|
| `01_schema.sql` | Tables, constraints, indexes, Realtime | Step 4 |
| `02_rls_and_rpc.sql` | Security rules, scoring, all RPC functions, notification triggers, `claim_due_notifications()` | Step 4 |
| `03_storage.sql` | Private `proofs` bucket and its access rules | Step 4 |
| `04_cron_cleanup.sql` | Nightly purge at 03:30 Taipei, hourly settlement expiry, proof-expiry functions for Part C | Step 4 |
| `05_push_delivery.sql` | Delivery bookkeeping for Part C's Edge Functions (see `../README-push.md`) | Part C setup |
| `06_dispute_and_daily.sql` | **Batch 2 (v1.2.0):** disputes pause the money; per-member daily-reminder switch | Step 4b, after 01–05 |
| `tests.sql` | 136 automatic tests, prints PASS/FAIL (needs 01–06) | Step 5 |
| `seed_demo.sql` | Demo room for UI work — **do not run in production** | Optional, step 8 |
| `99_enable_notification_cron.sql` | Calls Part C's `tick` every minute | **Only after Part C is deployed**, step 9 |

All files are safe to run again. Re-running one replaces functions and policies and never deletes data.

---

## 0. Check before you start

Free-plan limits change from time to time. Spend 5 minutes on these official pages first:

| Check | Page | What to look for |
|---|---|---|
| Price & quotas | https://supabase.com/pricing | Free plan: no credit card, database size, **1 GB file storage**, Edge Function invocations per month, number of free projects |
| Auto-pause rule | https://supabase.com/docs/guides/platform/free-project-pausing | Free projects are **paused after 7 days of low activity**; restorable for 90 days |
| pg_cron | https://supabase.com/docs/guides/cron | Still available on Free |
| pg_net | https://supabase.com/docs/guides/database/extensions/pg_net | Still available on Free |
| Storage limits | https://supabase.com/docs/guides/storage/uploads/file-limits | Per-file limit (Free: 50 MB; we use 300 KB) |
| Deleting storage files | https://supabase.com/docs/guides/storage/management/delete-objects | Files must be deleted through the Storage API, not SQL. That's why Part C's `tick` deletes old proofs |
| Edge Function limits | https://supabase.com/docs/guides/functions/limits | CPU / wall-clock limits for Part C |
| Anonymous sign-ins | https://supabase.com/docs/guides/auth/auth-anonymous | How to enable; abuse protection (CAPTCHA) |

**Things that could cost money or break on Free (flags):**

- ⚠️ **Auto-pause.** The once-a-minute `tick` call may or may not count as "activity" for the 7-day rule. Supabase does not promise either way. If neither of you opens the app for a week, assume the project can pause. See "If the project got paused".
- ⚠️ **No backups on Free.** Free projects get no daily backups. If the score history matters, export it now and then (Table Editor → `tasks` → Export → CSV).
- ⚠️ **Storage quota.** 2 people × ≤ 50 tasks/week × 300 KB × 30 days stays far below 1 GB. That holds only once Part C's `tick` runs the proof hand-off (see "Proof expiry" below); until then, old proofs are **not** deleted and storage keeps growing.
- Nothing in these files needs a paid plan or a credit card. If Supabase ever asks for a card, stop and re-check the pricing page.

---

## 1. Create the Supabase project

1. Open https://supabase.com and click **Start your project**. Sign in with GitHub (or email).
2. Click **New project**.
   - Organization: your personal one (plan **Free**).
   - Name: `studybet`
   - Database password: click **Generate a password**, then save it in a password manager. You rarely need it, but you can't see it again.
   - Region: **Northeast Asia (Tokyo)** or **Southeast Asia (Singapore)**, the closest to Taiwan.
3. Click **Create new project** and wait 1–2 minutes.

✅ **Success:** the project home page opens and the status shows the project is up (no "Setting up project" banner).

## 2. Turn on anonymous sign-ins

1. Left sidebar → **Authentication** → **Sign In / Providers** (on some dashboards: **Providers** or **Settings**).
2. Find **Allow anonymous sign-ins** and switch it **on**. Click **Save** if a button appears.

✅ **Success:** the toggle stays on after you reload the page.

> Recommended: in the same area, turn on **CAPTCHA protection** (Cloudflare Turnstile is free). That keeps strangers from creating many anonymous users to guess pairing codes. The frontend then has to show the CAPTCHA widget (Part B).

## 3. Check that the extensions exist

1. Left sidebar → **SQL Editor** → **New query** (the `+` button).
2. Paste this and press **Run** (or `Ctrl` + `Enter`):

```sql
select name, default_version, installed_version
from pg_available_extensions
where name in ('pgcrypto', 'pg_cron', 'pg_net')
order by name;
```

✅ **Success:** **3 rows**: `pg_cron`, `pg_net`, `pgcrypto`. `installed_version` may be empty for now; that's fine.

❌ If `pg_cron` or `pg_net` is missing, continue anyway and read **Fallbacks** at the end. Only `pgcrypto` is required.

## 4. Run the four setup files

Do this for `01_schema.sql`, then `02_rls_and_rpc.sql`, then `03_storage.sql`, then `04_cron_cleanup.sql`, **in that order**:

1. In Windows File Explorer, right-click the file → **Open with** → **Notepad**.
2. Press `Ctrl` + `A`, then `Ctrl` + `C`.
3. In the Supabase SQL Editor click **New query**, click in the editor, press `Ctrl` + `V`.
4. Press **Run**.
   - If Supabase warns about a *destructive operation* (the files contain `drop policy if exists` / `drop trigger if exists`), click **Run this query** / **Confirm**. These lines only replace old versions of our own rules.

✅ **Success:** the result panel says **Success. No rows returned** for each file.

- A yellow **warning** mentioning pg_net or pg_cron means that extension isn't available. See **Fallbacks**.
- A red **error** means something went wrong. Copy the message, fix the cause, and run the same file again.

Quick check after all four files:

```sql
select jobname, schedule from cron.job order by jobname;
```

✅ Expected: `studybet-expire-settlements | 7 * * * *` and `studybet-nightly-cleanup | 30 19 * * *`. pg_cron uses UTC: 19:30 UTC = 03:30 Taipei.

### 4b. Batch 2: run `06_dispute_and_daily.sql` (app v1.2.0)

Run it **once, after 01–05**, exactly like the files above (Notepad → copy → new query → **Run**). Supabase may warn about a destructive operation: the file drops the old 2-argument `update_settings` and the old check on `notification_outbox.kind`, then creates the new versions. Click **Run this query**.

✅ **Success:** one row `daily_column = true | update_settings_args = 3 | dispute_cleared_kind = true`.

What it changes (details in `CONTRACT.md` → ADDENDUM A8):
- A **disputed** done task stops counting in the week net, the total net and any settlement amount until the member who disputed it clears the dispute. Then it counts again in the week of its original `completed_at`.
- New column `members.daily_reminder_enabled` (default `true`) and a third, optional argument `update_settings(…, p_daily_reminder_enabled)`. Only `get_state().me` shows it. The partner can't read it, so `members` is now readable column by column.
- New notification kind `dispute_cleared`. After running 06, redeploy `send-push` so the new texts are used (`../README-push.md`).

> ⚠️ **If you ever re-run `02_rls_and_rpc.sql`, run `06` again right after it.** 02 brings back the old function bodies, the old 2-argument `update_settings` (two versions would make the app's settings calls fail) and the full read access to `members`. Re-running 06 on its own is always safe.

The app (v1.2.0) works before and after this step. It shows the new dispute texts and the 每日提醒 switch only once `get_state()` returns `me.daily_reminder_enabled`.

## 5. Run the tests

1. Open `tests.sql` in Notepad, copy everything, paste it into a **new query** and press **Run**.

✅ **Success:** a table of rows marked `PASS`, and the **last row** reads `SUMMARY | 136 tests | failures: 0`. (Before 06 is run, the dispute and `b2:` rows fail. That is expected; run step 4b.)

The `security:` rows check that the server-only functions are refused for signed-in users and anonymous visitors, and that `app_config` is unreadable. The authenticated user's executable functions must be exactly the contract RPCs plus 2 RLS helpers. One caveat: if you ever add your own functions to the `public` schema, the row "authenticated can execute exactly …" flags them. That is on purpose.

- The tests create a throw-away room, delete it again, never send pushes and never touch other rooms.
- They leave a tiny helper schema `studybet_test`. Remove it whenever you like: `drop schema studybet_test cascade;`
- `FAIL` rows show the reason in the `detail` column. A single row `UNEXPECTED ERROR — all tests rolled back` means a test crashed. The detail column says where.

## 6. Fill in `app_config`

`app_config` holds exactly two values: the Edge Function address and the shared secret. **It never holds the service role key.** Part C's functions get that key from Supabase automatically as the environment variable `SUPABASE_SERVICE_ROLE_KEY`.

1. Find your project URL: **Project Settings** (gear icon) → **Data API** (or **API**) → **Project URL**, e.g. `https://abcdefghijkl.supabase.co`.
2. Make a long random secret. Open **PowerShell** (Start menu → type `PowerShell`) and paste:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) })) -replace '[+/=]', ''
```

   Copy the line it prints. Part C needs this same value, so keep it in your password manager.

3. In the SQL Editor run, replacing the two placeholders:

```sql
insert into public.app_config(key, value) values
  ('edge_function_base_url', 'https://YOUR-PROJECT-REF.supabase.co/functions/v1'),
  ('function_secret',        'PASTE-THE-RANDOM-SECRET-HERE')
on conflict (key) do update set value = excluded.value;
```

✅ **Success:** `Success. No rows returned`. Check with `select key from public.app_config;`, which should show exactly 2 rows: `edge_function_base_url` and `function_secret`. Until Part C exists, notifications simply wait in `notification_outbox` and nothing breaks.

`app_config` has RLS enabled, no policies and no grants for `anon` / `authenticated`, so the app's users cannot read it through the API. `tests.sql` checks this.

> If you set up an earlier version of this backend that stored `project_url` / `service_role_key` here: re-running `04_cron_cleanup.sql` deletes those two rows. Then **rotate the service role key**, since it sat in a table: **Project Settings** → **API Keys** → roll / regenerate the secret key.

## 7. Values for the frontend (`config.js`)

**Project Settings** → **API Keys** (or **Data API**):

- `SUPABASE_URL`: the Project URL, e.g. `https://abcdefghijkl.supabase.co`
- `SUPABASE_ANON_KEY`: the **anon / public** key (or the new **publishable** key). It is safe in the browser: every write goes through the checked RPCs.
- `VAPID_PUBLIC_KEY`: produced by Part C.

## 8. (Optional) Demo data for UI work

**Do not run in production.** Paste `seed_demo.sql` into a new query and run it.

✅ **Success:** one row: `demo room ready — code: demo-studybet | -12 | 3`.

To look at it in the app, join with code `demo-studybet` and choose "slot 1 / I was here before" (`join_room('demo-studybet', '<name>', 1)`). Your anonymous user takes over the demo's slot-1 member. Remove the demo afterwards:

```sql
delete from public.rooms where id = '00000000-0000-4000-8000-00000000de00';
```

## 9. After Part C is deployed: turn on the per-minute tick

Only once Part C's `tick` and `send-push` Edge Functions are deployed and step 6 is done:

1. Paste `99_enable_notification_cron.sql` into a new query and run it.

✅ **Success:** the result shows `studybet-tick | * * * * * | true`.

Two minutes later, check that it is really being called:

```sql
-- pg_cron ran the job?
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'studybet-tick')
order by start_time desc limit 5;

-- the HTTP call reached tick? (status_code 200 is good)
select id, status_code, left(content::text, 200) as body, error_msg, created
from net._http_response order by created desc limit 5;
```

To stop it: `select cron.unschedule('studybet-tick');`

---

## Error codes

Every RPC fails with a short, stable code in `error.message` (supabase-js). Map these to Chinese in the frontend.

| Code | Raised by | Meaning |
|---|---|---|
| `NOT_AUTHENTICATED` | all | No signed-in (anonymous) user |
| `NOT_IN_ROOM` | all except pairing | Caller is not a member of any room |
| `ALREADY_IN_ROOM` | create_room, join_room | This user already belongs to (another) room |
| `CODE_TOO_SHORT` | create_room | Pairing code under 8 characters |
| `CODE_TOO_LONG` | create_room | Pairing code over 64 characters |
| `CODE_TAKEN` | create_room | Another room already uses this code (counts as a failed attempt) |
| `BAD_CODE` | join_room | Wrong code **or** room full without a slot to reclaim (deliberately the same answer) |
| `BAD_SLOT` | join_room | `p_slot` not 1 or 2 |
| `BAD_NAME` | create_room, join_room, update_settings | Display name not 1–6 characters |
| `RATE_LIMITED` | create_room, join_room | 5 failed pairing attempts in the last 10 minutes |
| `BAD_TITLE` | create_task | Title not 1–40 characters |
| `BAD_VALUE` | create_task | Value not 1–50 |
| `BAD_DUE` | create_task | Deadline not between 5 minutes and 7 days from now |
| `TASK_NOT_FOUND` | task RPCs | No such task in your room (or deleted) |
| `NOT_OWNER` | complete, abandon, delete | Only the task owner may do this |
| `TASK_NOT_ACTIVE` | complete, abandon, delete | Task already done / abandoned |
| `TASK_OVERDUE` | complete, abandon | Deadline passed (server clock); overdue tasks can't be completed |
| `PROOF_REQUIRED` | complete_task | Task needs a photo, none given |
| `BAD_PROOF_PATH` | complete_task | Path is not `{room_id}/{task_id}.jpg` |
| `PROOF_MISSING` | complete_task | Path is right but the file was not uploaded |
| `DELETE_WINDOW_PASSED` | delete_task | More than 5 minutes since creation |
| `NOT_ALLOWED` | dispute_task, respond_settlement | Must be the *other* member |
| `TASK_NOT_DONE` | dispute_task | Only done tasks can be disputed |
| `NO_PARTNER` | propose_settlement | Partner hasn't joined yet |
| `SETTLEMENT_PENDING` | propose_settlement | A proposal is already waiting |
| `NOTHING_TO_SETTLE` | propose_settlement | Total gap is 0 |
| `SETTLEMENT_NOT_FOUND` | respond, undo | No such settlement in your room |
| `SETTLEMENT_NOT_PENDING` | respond_settlement | Already answered or expired after 7 days |
| `SETTLEMENT_NOT_CONFIRMED` | undo_settlement | Not a confirmed settlement (e.g. already undone) |
| `NOT_LATEST_SETTLEMENT` | undo_settlement | Only the most recent confirmed settlement can be undone |
| `UNDO_WINDOW_PASSED` | undo_settlement | More than 24 h since confirmation |
| `BAD_SUBSCRIPTION` | save_push_subscription | Endpoint not https or keys missing |
| `BAD_INTERVAL` | list_expired_proofs (server only) | Interval under 1 day refused, so a typo can't delete fresh proofs |
| `permission denied for …` | direct table access, server-only functions | Not an RPC code: direct INSERT/UPDATE/DELETE, reading `app_config`/`notification_outbox`, and calling server-only functions are blocked by design |

**Why pairing errors arrive differently:** `create_room` and `join_room` don't *raise* `BAD_CODE` / `CODE_TAKEN`. A raised error would roll back the transaction, and the failed-attempt counter with it. Instead they set HTTP status 400 and return `{"code":"P0001","message":"BAD_CODE",...}`, the same JSON shape PostgREST uses for raised errors. PostgREST commits in this case. In supabase-js both cases look identical: `const { data, error } = await sb.rpc('join_room', …)` → `error.message === 'BAD_CODE'`.

---

## Interface notes for Part B (frontend) and Part C (push)

**RPC results**

- `create_room` → `{ room: {id, timezone, daily_reminder_time, created_at}, member: {id, slot, display_name, room_id, created_at} }`
- `join_room` → `{id, slot, display_name, room_id, created_at}` (the member)
- `create_task`, `complete_task`, `abandon_task`, `delete_task`, `dispute_task` → the task row
- `propose_settlement`, `respond_settlement`, `undo_settlement` → the settlement row
- `update_settings(p_display_name, p_daily_reminder_time, p_daily_reminder_enabled)` → fresh `get_state()`. Every argument is optional and `null` keeps the current value. The time is rounded to the minute and shared by the room; `p_daily_reminder_enabled` changes only the caller's own switch (06).
- `get_state()` (06) adds `me.daily_reminder_enabled` (never on `partner`) and `disputed_pending: {count, amount_me}`: the disputed tasks in the current total window and what would come back, from my point of view, if they were all cleared.
- `get_state()` → `server_now, room, me, partner (null until joined), week_start, week_end, week_net_me, total_net_me, done_counts {me:{week,total}, partner:{week,total}}, streaks {me, partner}, active_task_count, pending_settlement {id, proposed_by, proposed_by_me, proposed_at, expires_at} | null, last_confirmed_settlement {id, amount_slot1_net, amount_me, confirmed_at, proposed_by, responded_by, can_undo, undo_until} | null`
  - Headline: `total_net_me > 0` → "You lead {partner} NT$ x"; `< 0` → "{partner} leads you NT$ x"; `0` → "All square".
  - Use `server_now` to correct the phone's clock when showing countdowns.
- `list_history(p_before, p_limit)` → JSON array, newest first, each item has `type` (`task`|`settlement`) and `at`. Task items carry `status` ∈ `done|abandoned|overdue`, `mine`, `owner_slot`, `disputed`, `proof_path`, `proof_expired`, …; settlement items carry `status`, `amount_me`, …. **Next page:** pass the last item's `at` as `p_before`. A page can hold a few more items than `p_limit` when several share the same timestamp; that way none is skipped.

**Reading the task list:** clients may `select` (never write) their own room's rows: `sb.from('tasks').select('*').is('deleted_at', null)`. The view `task_states` adds a server-computed `is_overdue` / `display_status`. Soft-deleted tasks stay readable with `deleted_at` set, so the Realtime UPDATE for a deletion reaches both phones. Filter them out in the UI. `rooms` is readable only by column: `select('id,timezone,daily_reminder_time,created_at')`.

**Realtime:** `tasks`, `settlements` and `members` are published. Subscribe with `filter: 'room_id=eq.<room id>'` on each table and re-run `get_state()` on any event. After a slot reclaim, the `members` UPDATE event tells the other phone that the partner's id changed.

**Proof upload:**

```js
await sb.storage.from('proofs').upload(`${roomId}/${taskId}.jpg`, blob,
  { contentType: 'image/jpeg', upsert: true });
await sb.rpc('complete_task', { p_task_id: taskId, p_proof_path: `${roomId}/${taskId}.jpg` });
const { data } = await sb.storage.from('proofs').createSignedUrl(path, 60);   // view
```

Only the owner can upload, and only while the task is active. The bucket rejects anything that isn't `image/jpeg` or is over 300 KB (307 200 bytes). Compress on the phone first.

**Push (Part C):**

- Every new `notification_outbox` row triggers `POST {edge_function_base_url}/send-push` with body `{"outbox_id": <id>}` and headers `Authorization: Bearer <function_secret>` and `x-function-secret: <function_secret>`. The secret is not a JWT, so deploy both functions with JWT verification off (`supabase functions deploy send-push --no-verify-jwt`) and check the secret inside the function.
- `send-push` should load the row with the service role, (re)compute the badge with `rpc('badge_count', { p_member: recipient_id })`, send to that member's `push_subscriptions` where `disabled_at is null`, then set `sent_at` (or `error`). It should also update `last_success_at`, and set `disabled_at` on HTTP 404/410 from the push service.
- `tick` is called with the same headers (by pg_cron via step 9, or by Cloudflare). It should call `rpc('claim_due_notifications')` with the service role key. That creates the due_1h / due_15m / overdue / daily rows, and each row then dispatches itself through the trigger above. If you also retry rows with `sent_at is null` older than a few minutes, mark them so you don't send twice.
- `payload` always has `title`, `body`, `url` (relative, `./` or `./#history`), `badge`, `kind`, and usually `tag` and `task_id` / `settlement_id`. Texts are already in Traditional Chinese.
- Both functions create their Supabase client with `Deno.env.get('SUPABASE_URL')` and `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`. Supabase injects both into every Edge Function automatically, so no key is stored in the database.

**Server-only functions** (executable by `service_role` only; `anon`/`authenticated` get `permission denied`, which `tests.sql` checks):

| Function | Used by |
|---|---|
| `claim_due_notifications(p_only_room uuid default null) → int` | `tick`, every minute |
| `badge_count(p_member uuid) → int` | `send-push`, badge at send time |
| `expire_stale_settlements(p_room uuid default null) → int` | pg_cron hourly (also runs inside claim) |
| `list_expired_proofs(p_older_than interval default '30 days') → setof (task_id uuid, proof_path text)` | `tick`, proof expiry |
| `mark_proofs_expired(p_task_ids uuid[]) → int` | `tick`, proof expiry |
| `nightly_cleanup() → jsonb` | pg_cron 03:30 Taipei (or `tick` in the Cloudflare fallback) |

**Proof expiry (Part C's `tick`):** SQL can't delete storage files, so `tick` does it. Once a day is enough, e.g. on the first tick after 03:30 Taipei; every tick also works, since the query is cheap and usually returns nothing.

```ts
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const { data: expired, error } = await sb.rpc('list_expired_proofs');          // default 30 days
if (!error && expired.length) {
  for (let i = 0; i < expired.length; i += 100) {                               // remove() in batches
    const batch = expired.slice(i, i + 100);
    const { error: rmErr } = await sb.storage.from('proofs').remove(batch.map((r) => r.proof_path));
    if (!rmErr) await sb.rpc('mark_proofs_expired', { p_task_ids: batch.map((r) => r.task_id) });
  }
}
```

- `list_expired_proofs` returns (a) done tasks whose proof is older than 30 days and not yet flagged, and (b) stray files older than 30 days in the bucket with no such task, e.g. uploaded but never used. For (b), `task_id` is parsed from the file name and may not exist any more. It never returns the upload of an active task.
- `mark_proofs_expired` sets `tasks.proof_expired = true` and keeps `proof_path`, so history can say "proof expired". Unknown ids are ignored.
- If `remove()` fails, don't mark: the same rows come back next time. Removing a file that is already gone is harmless.

---

## Behavior details worth knowing

- **Server clock only.** Deadlines, weeks and settlements all use the database clock. `complete_task` must finish strictly before `due_at`. Completing exactly at `due_at` fails.
- **No lost or double-counted task around a settlement.** `complete_task` and `respond_settlement` lock the room row and read the clock *after* the lock. Every completed task therefore lands either in the frozen settlement amount or in the new total, never in neither. Tasks completed exactly at `confirmed_at` belong to the settled period.
- **Week** = Monday 00:00 to next Monday 00:00 Asia/Taipei, by `completed_at`. Tested at Sunday 23:59:59.9 and Monday 00:00:00.1.
- **Disputes pause the money (06).** While a done task is disputed it counts for nobody: not in the week net, the total net, `propose_settlement`'s "nothing to settle" check or the frozen settlement amount. `done_counts` and streaks still count it. Only the member who disputed it (the non-owner) can clear it; the owner gets `NOT_ALLOWED`. Once cleared it counts again **in the window of its original `completed_at`**: a task completed this week is back in this week, one completed last week only in the total.
  - **Edge case: disputed at settlement time.** `respond_settlement` freezes the amount without the disputed task. The task was completed before `confirmed_at`, so it is outside the new total window too. Clearing the dispute later does **not** bring it back into the total (it still returns to its week). It is excluded permanently, unless that settlement is undone, in which case it counts again as usual. The owner's `dispute_cleared` notification says so ("在上次結算前完成，不再計分") instead of "+N 已加回".
  - `dispute_task` locks the room row like `complete_task` and `respond_settlement`, so "disputed at confirmation time" is always well defined.
- **Settlement expiry:** a proposal pending for 7 days is rejected automatically (`responded_by` stays empty). This happens on the hourly job and on every `claim_due_notifications` run. `get_state()` already hides it before that.
- **Reminder rules** (`claim_due_notifications`):
  - `due_1h` fires when 15–60 minutes are left; `due_15m` when ≤ 15 minutes are left.
  - **Neither fires for a task created less than 15 minutes ago.** You just set that deadline, so a reminder would be noise. Once the task is 15 minutes old it becomes eligible if it is still in a window. A task due in 30 minutes, for example, gets `due_1h` at its 15-minute mark.
  - `overdue` goes to the owner only, and only for tasks that went overdue **in the last hour**. Turning on the cron late, or after a pause, won't flood you with old ones. This rule ignores task age.
  - `daily` fires once per member per Taipei date, in the hour after `daily_reminder_time`, if the member has ≥ 1 active, non-overdue task **and has the daily reminder switched on** (`members.daily_reminder_enabled`, 06). The time is shared by the room; the on/off switch is per member.
- **Slot reclaim** moves the member row to the new anonymous user. Tasks, settlements and push subscriptions follow through `ON UPDATE CASCADE`. Anyone with the code can do this, which is the contract's design, so **keep the code secret**.
- **Brute force:** 5 failed pairing attempts per 10 minutes per anonymous user. An attacker could create new anonymous users, so use a code of **12+ random characters** and turn on CAPTCHA (step 2). Codes are stored as bcrypt hashes. Clients cannot even read the hash column.

### Additions beyond the contract

No contract name or signature was changed. Every deviation is listed in the **CONTRACT ADDENDUM** at the end of `CONTRACT.md`. In short:

- Internal tables `pairing_attempts` and `daily_reminder_log`, both invisible to clients.
- Batch 2 (06): `members.daily_reminder_enabled`, `update_settings`' third argument, `get_state().disputed_pending`, notification kind `dispute_cleared` (ADDENDUM A8).
- View `task_states`.
- Internal helpers, not callable by clients: `week_start_for`, `week_net_slot1`, `total_net_slot1`, `settlement_boundary`, `member_streak`, `task_deadline_ok`, `call_tick`.
- RLS helpers callable by clients: `my_room_id`, `proof_object_allowed`.
- Server-only functions: see the table under "Interface notes".

---

## Performance

Indexes from the contract are in place: `tasks(room_id, status, due_at)`, `tasks(owner_id, completed_at)`, `settlements(room_id, confirmed_at)`. Two more support the reminder scan and history. In a local test (Postgres 17 compiled to WebAssembly, much slower than Supabase), `get_state()` took **21 ms** with 2 000 tasks in one room, and `claim_due_notifications()` took **3 ms** over 1 000 active tasks.

To measure on your project (rolls back, so nothing is sent):

```sql
begin;
explain analyze select public.claim_due_notifications();
rollback;

begin;
select set_config('request.jwt.claims', '{"sub":"<a member id>","role":"authenticated"}', true);
set local role authenticated;
explain analyze select public.get_state();
rollback;
```

Look at `Execution Time` at the bottom. Targets: get_state < 50 ms, claim < 100 ms.

---

## Fallbacks

### Is pg_cron / pg_net there?

```sql
select extname, extversion from pg_extension where extname in ('pg_cron', 'pg_net', 'pgcrypto');
```

Missing rows = not enabled. Try enabling: **Database** → **Extensions** → search `pg_cron` / `pg_net` → toggle on. Then re-run `01_schema.sql` and `04_cron_cleanup.sql`. If the toggle isn't offered on your plan, use the fallbacks below.

- **No pg_net:** the outbox trigger quietly does nothing and rows stay unsent. Part C's `tick` must then also send unsent outbox rows itself. Proof expiry is unaffected: `tick` does it anyway.
- **No pg_cron:** the nightly purge, the hourly expiry and step 9 are not scheduled. Use Cloudflare Workers instead (free, no card). The worker only knows the shared `function_secret`; it never gets the service role key:

### Cloudflare Workers cron (instead of pg_cron)

1. Sign up at https://dash.cloudflare.com/sign-up (free plan). Check the current free limits at https://developers.cloudflare.com/workers/platform/limits/. One call per minute is ~1 440 requests/day.
2. **Workers & Pages** → **Create** → **Create Worker** → name it `studybet-cron` → **Deploy**.
3. Click **Edit code**, replace everything with the code below, then click **Deploy**:

```js
export default {
  async scheduled(event, env, ctx) {
    // '30 19 * * *' (03:30 Taipei) asks tick to also run nightly_cleanup()
    const job = event.cron === '30 19 * * *' ? 'nightly' : 'tick';
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/tick`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.FUNCTION_SECRET}`,
        'x-function-secret': env.FUNCTION_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'cloudflare', job }),
    });
    console.log(job, r.status);
  },
};
```

   For Part C: when `tick` receives `{"job": "nightly"}`, it should also call `rpc('nightly_cleanup')`. With pg_cron this never happens; pg_cron runs the purge itself.

4. Back on the worker page → **Settings** → **Variables and Secrets** → **Add**, type **Secret**, twice:
   - `SUPABASE_URL` = `https://YOUR-PROJECT-REF.supabase.co`
   - `FUNCTION_SECRET` = the secret from step 6
5. **Settings** → **Triggers** → **Cron Triggers** → **Add**: `* * * * *`. Add a second one: `30 19 * * *`. Cloudflare cron also uses UTC.

✅ **Success:** the worker's **Logs** (or **Observability**) tab shows `tick 200` once a minute. Don't also run step 9, or `tick` runs twice a minute. That's harmless (claims are deduplicated) but wasteful.

The hourly settlement expiry needs no job of its own here: `claim_due_notifications` already does it every minute.

---

## If the project got paused

1. Open https://supabase.com/dashboard. The project shows as **Paused**.
2. Click it → **Restore project** / **Resume project** → confirm. It takes a few minutes. Free projects can be restored for 90 days after pausing.
3. When it is up again, check in the SQL Editor:

```sql
select jobname, schedule, active from cron.job order by jobname;   -- 2 jobs, or 3 after step 9
select key from public.app_config order by key;                    -- your keys are still there
```

   If jobs are missing, re-run `04_cron_cleanup.sql` (and `99_enable_notification_cron.sql`).
4. Open the app on both phones once. The PWA re-subscribes Realtime and push on start.

To avoid pausing: use the app at least every few days, or open the Supabase dashboard once a week. Supabase emails a warning before pausing.

---

## How this was tested

`tests.sql` (136 tests: pairing, validation, scoring symmetry, week boundary, streaks, settlement propose/accept/reject/expire/undo, disputes pausing and restoring money (incl. week boundary, settlement while disputed, undo), per-member daily reminder, history paging, reminders incl. the 15-minute rule, slot reclaim, blocked direct writes, the security audit of server-only functions and `app_config`, proof-expiry hand-off) passed with **0 failures** on PostgreSQL 17 (PGlite), using stand-ins for Supabase's `auth.uid()`, the roles and `storage` tables. `01`–`04`, `06` and `seed_demo.sql` were also run twice in a row, with the tests passing again afterwards, to confirm they are safe to re-run without loosening any grant. The Supabase-only parts couldn't be exercised there: pg_cron, pg_net, the real Storage API and PostgREST's HTTP-400 handling. Step 5 on your project is the real confirmation, and step 9's checks cover the cron/HTTP side.
