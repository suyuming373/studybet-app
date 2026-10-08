# 賭讀 / StudyBet — Push notifications (Part C)

This part adds lock-screen notifications, the number on the app icon, the "add to Home Screen" guide, and a diagnostics page. Everything stays on free plans.

## Contents
1. [How it works](#1-how-it-works)
2. [Honest limits](#2-honest-limits)
3. [Verify with the official docs first](#3-verify-with-the-official-docs-first)
4. [Setup, step by step (Windows PowerShell)](#4-setup-step-by-step-windows-powershell)
5. [Send yourself a test push](#5-send-yourself-a-test-push)
6. [Notification copy](#6-notification-copy)
7. [Admin queries](#7-admin-queries)
8. [Rotating secrets and keys](#8-rotating-secrets-and-keys)
9. [Troubleshooting](#9-troubleshooting)
10. [Files and local tests](#10-files-and-local-tests)

---

## 1. How it works

```
 something happens                    Supabase database                         Edge Functions           Apple
 ─────────────────                    ─────────────────                         ──────────────           ─────
 partner completes / disputes /  ──►  trigger writes notification_outbox  ──►   send-push  ─────────►  Web Push ─► iPhone
 settlement request / result          + pg_net POST {"outbox_id"}               (claims the row,          service
                                                                                 words it, encrypts,
 every minute (pg_cron)          ──►  call_tick() ─────────────────────────►    tick                      sends)
                                                                                 1. claim_due_notifications()
                                                                                    → due_1h / due_15m / overdue / daily rows
                                                                                 2. retries unsent rows older than 30 s
                                                                                 3. deletes proofs older than 30 days
```

* **No duplicates.** Timed reminders are deduped in SQL (`notification_log`, `daily_reminder_log`). Each outbox row is handed to exactly one sender by `claim_outbox()` (`05_push_delivery.sql`). Once a row is sent it is never sent again.
* **No silent losses.** Rows that fail are retried by `tick`, at most **3 attempts**. After that they stay unsent with the error recorded (see [Admin queries](#7-admin-queries)).
* **Subscriptions repair themselves.** The push service may answer `404` or `410` (subscription expired). `send-push` then sets `push_subscriptions.disabled_at`. The next time the app opens, `push.js` sees that, re-subscribes and saves the new subscription. If that also fails, the app shows a "🔕 通知已關閉" bar.
* **App in front: no banner.** If the app window is visible and focused, the service worker passes the push to the page, which shows an in-app toast instead. Every push ends in either a visible notification or a toast; there are never silent pushes.
* **Badge.** The number on the icon is your count of active, non-overdue tasks. It is computed when the push is sent and set by the service worker. While the app is open it is kept current after every refresh.

## 2. Honest limits

* **Apple gives no delivery guarantee.** Web Push on iPhone is best effort. Typical delays are seconds. Low Power Mode, Focus modes, weak signal, or a phone that was off can delay or drop a notification. Apple's service only holds a push for the time-to-live we set: 15–45 minutes for reminders, up to 24 hours for partner events.
* **Targets, not promises:**
  * Partner's completion: on a locked iPhone within 2 minutes, usually under 30 seconds.
  * 1-hour and 15-minute reminders: within 1–2 minutes of when they're due.
  * Daily reminder: at the set time ± 2 minutes.
* **Reminder timing follows the backend rules (CONTRACT A5):**
  * No 1-hour or 15-minute reminder for a task that is less than 15 minutes old.
  * A task due in 20 minutes therefore gets its "只剩 15 分鐘" about 15 minutes after you create it, 5 minutes before the deadline.
  * `overdue` only goes out if the task became overdue within the last hour.
* **Notifications require an installed app.** They only work when the app is opened from the Home Screen (iOS 16.4+). A normal Safari tab can't receive them.
* **When a push is late:** open the app. Realtime shows the current state immediately, so nothing in the app depends on the push arriving. To check whether delivery works at all, use [section 5](#5-send-yourself-a-test-push).
* **Free plan:** this uses one Edge Function call per minute (`tick`) plus one per notification. Check the current monthly limit in step 3.

## 3. Verify with the official docs first

Free-plan rules change. Spend 5 minutes on these pages:

| Check | Page | What to look for |
|---|---|---|
| Edge Function pricing and quota | https://supabase.com/pricing | Free plan: invocations per month. We use ~45 000/month (tick) + notifications. |
| Edge Function limits | https://supabase.com/docs/guides/functions/limits | Wall-clock / CPU time per call. tick normally takes < 5 s. |
| Edge Function secrets | https://supabase.com/docs/guides/functions/secrets | `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically |
| Deploying without JWT check | https://supabase.com/docs/guides/functions/deploy | `--no-verify-jwt` flag |
| pg_cron on Free | https://supabase.com/docs/guides/cron | Still available on Free |
| pg_net on Free | https://supabase.com/docs/guides/database/extensions/pg_net | Still available on Free |
| Supabase CLI via npx | https://supabase.com/docs/guides/local-development/cli/getting-started | `npx supabase …` works without a global install |
| Apple: Web Push for web apps | https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers | iOS 16.4+, Home Screen web apps only, permission must come from a tap |
| Apple: badging | https://developer.apple.com/documentation/usernotifications/badging-for-web-apps | `navigator.setAppBadge` needs notification permission |
| WebKit blog: Web Push on iOS | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ | Background on the iOS rules |

If a link has moved, search its page title on the same site. Apple and Supabase reorganise their docs from time to time.

## 4. Setup, step by step (Windows PowerShell)

You need **Node.js LTS** from https://nodejs.org (the installer; nothing else is installed globally). Every command below uses `npx`, which downloads the tool for that one run.

**Open PowerShell in the project folder:** in File Explorer open the folder that holds `CONTRACT.md`, `backend`, `docs` and `supabase`. Click the address bar, type `powershell`, press **Enter**.

---

### Step 1. Run the new database file

1. Open `backend\05_push_delivery.sql` in Notepad. Press `Ctrl` + `A`, then `Ctrl` + `C`.
2. Supabase → **SQL Editor** → **New query** → paste → **Run**.

✅ **Success:** one row: `attempts_column = true`, `functions = 3`.
❌ **If it fails:** `relation "notification_outbox" does not exist` means files 01–04 haven't run yet. Run them first (backend README step 4).

### Step 2. Log in to Supabase

```powershell
npx supabase login
```

The first time, npx asks `Ok to proceed? (y)`. Type `y` and press **Enter**. A browser window opens; click **Authorize**.

✅ **Success:** the terminal prints `You are now logged in. Happy coding!`
❌ **If it fails:** if no browser opens, copy the link shown in the terminal into your browser. If you see `npx is not recognized`, install Node.js LTS and open a **new** PowerShell window.

### Step 3. Prepare the folder (only once)

Check whether `supabase\config.toml` exists:

```powershell
Test-Path supabase\config.toml
```

If it prints `False`, run:

```powershell
npx supabase init
```

Answer **N** to both questions (VS Code / IntelliJ settings).

✅ **Success:** `Finished supabase init.` and a new file `supabase\config.toml`. Your existing `supabase\functions` folder is left alone.
❌ **If it fails:** `file exists` means you've already done this step. Go on.

### Step 4. Link this folder to your project

```powershell
npx supabase link --project-ref rqlgldutexfozaatpypd
```

If it asks for the database password, paste it (it was created in backend README step 1), or just press **Enter** to skip. Deploying doesn't need it.

✅ **Success:** `Finished supabase link.`
❌ **If it fails:**
* `Unauthorized`: repeat step 2.
* `project not found`: check the ref in Supabase → **Project Settings** → **General** → **Reference ID**.

### Step 5. Create the VAPID key pair

```powershell
npx web-push generate-vapid-keys
```

✅ **Success:** it prints a **Public Key** (about 87 characters) and a **Private Key** (about 43 characters). Copy both into your password manager now.
❌ **If it fails:** run it again. It only needs internet to download the tool.

> The private key is a secret. Never put it in `config.js`, in Git, or in a chat.

### Step 6. Look up your FUNCTION_SECRET

It must be **exactly** the value already stored in the database (backend README step 6). In the Supabase **SQL Editor** run:

```sql
select value from public.app_config where key = 'function_secret';
```

✅ **Success:** one row. Copy the value.
❌ **If it fails:** no row means backend README step 6 isn't done. Do it first, using a new random secret.

### Step 7. Store the four secrets in Supabase

Replace the four placeholders; keep everything on one line:

```powershell
npx supabase secrets set VAPID_PUBLIC_KEY=PASTE_PUBLIC_KEY VAPID_PRIVATE_KEY=PASTE_PRIVATE_KEY VAPID_SUBJECT=mailto:you@example.com FUNCTION_SECRET=PASTE_FUNCTION_SECRET
```

`VAPID_SUBJECT` must be a `mailto:` address (or an `https://` URL) where a push service could contact you.

✅ **Success:** `Finished supabase secrets set.` Check with:

```powershell
npx supabase secrets list
```

You should see the four names, plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase adds itself. The values are shown only as hashes.
❌ **If it fails:**
* `Cannot find project ref`: repeat step 4.
* A secret got cut off: PowerShell treats `;` and `&` specially. The generated keys never contain them. If your mailto address does, wrap that one item in single quotes: `'VAPID_SUBJECT=mailto:a&b@x.com'`.

The service role key is **not** something you set: Supabase injects it into Edge Functions. It is never stored in the database or in any file.

### Step 8. Deploy both functions (with `--no-verify-jwt`)

```powershell
npx supabase functions deploy send-push --no-verify-jwt
npx supabase functions deploy tick --no-verify-jwt
```

✅ **Success:** each ends with `Deployed Functions on project rqlgldutexfozaatpypd: send-push` (or `tick`). Both appear in Supabase → **Edge Functions**.
❌ **If it fails:**
* An error mentioning **Docker**: add `--use-api` to the same command, e.g. `npx supabase functions deploy tick --no-verify-jwt --use-api`. That bundles on Supabase's side, so you don't need Docker.
* Any other bundling error: copy the error text and check that you're in the project folder (`Test-Path supabase\functions\tick\index.ts` should print `True`).

> `--no-verify-jwt` is required. The database calls these functions with the shared `FUNCTION_SECRET`, which isn't a Supabase login token. Both functions check the secret themselves (constant-time compare) and answer **401** to anything else.

### Step 9. Smoke test `tick`

```powershell
$secret = "PASTE_FUNCTION_SECRET"
Invoke-RestMethod -Method Post -Uri "https://rqlgldutexfozaatpypd.supabase.co/functions/v1/tick" -Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" -Body '{"source":"manual"}'
```

✅ **Success:** a small table with `claimed`, `sweep`, `proofs` and `ms` (e.g. `claimed: 0`, `ms: 300`).

Now check that a wrong secret is refused:

```powershell
Invoke-RestMethod -Method Post -Uri "https://rqlgldutexfozaatpypd.supabase.co/functions/v1/tick" -Headers @{ Authorization = "Bearer wrong" } -Body '{}'
```

✅ **Expected:** an error `(401) Unauthorized`.
❌ **If the first call fails:**
* `401`: the secret in step 7 doesn't match. Repeat steps 6–7.
* `500`: open Supabase → **Edge Functions** → **tick** → **Logs** and read the red line. `VAPID ... missing` means step 7 is incomplete.

### Step 10. Turn on the per-minute tick

Paste `backend\99_enable_notification_cron.sql` into a new SQL Editor query and **Run**.

✅ **Success:** `studybet-tick | * * * * * | true`. Two minutes later, Supabase → **Edge Functions** → **tick** → **Invocations** shows one call per minute.
❌ **If it fails:** `pg_cron is not enabled` or `pg_net is not enabled`: use the Cloudflare fallback in `backend/README-backend.md`. It also sends `{"job":"nightly"}` once a night, which makes `tick` run `nightly_cleanup()`.

### Step 11. Put the public key into the app

1. Open `docs\config.js` in Notepad.
2. Paste the **Public Key** from step 5 between the quotes of `VAPID_PUBLIC_KEY: ''`.
3. Save, then publish: GitHub Desktop → **Commit to main** → **Push origin**.

The app version is already bumped to **1.1.0**. Phones show "新版本已就緒" on the next launch; tap **重新整理**.

✅ **Success:** the phone's Settings no longer says "管理員已設定推播金鑰" is missing, and a **🔔 開啟通知** button appears.

### Step 12. Turn notifications on, on each iPhone

1. Open 賭讀 **from the Home Screen** → **⋯** → **設定** → **🔔 開啟通知** → **允許**.
2. Continue with [section 5](#5-send-yourself-a-test-push) and then `INTEGRATION-TEST.md`.

---

## 5. Send yourself a test push

1. On the iPhone, open the diagnostics page. Either tap the version number at the bottom of **設定** five times, or open `https://<user>.github.io/<repo>/?debug=1` in the installed app.
2. It shows the permission state, a short hash of the subscription, the last push received, the badge value, the offline queue length and your **會員 ID**. Tap **複製會員 ID** and send it to your computer (e.g. through Notes).
3. Lock the iPhone, then on the computer run:

```powershell
$secret = "PASTE_FUNCTION_SECRET"
$member = "PASTE_MEMBER_ID"
Invoke-RestMethod -Method Post -Uri "https://rqlgldutexfozaatpypd.supabase.co/functions/v1/send-push" `
  -Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" `
  -Body "{`"action`":`"send_test_push`",`"member_id`":`"$member`"}"
```

✅ **Success:** PowerShell shows `ok: True` and `subscriptions: 1` (or more). The lock screen shows **賭讀 測試通知**.
❌ **If it fails:**
* `subscriptions: 0`: the phone never saved a subscription. Open the app from the Home Screen and turn notifications on again.
* `ok: False` with `HTTP 403`: the VAPID keys don't match. The public key in `config.js` must belong to the private key in the secrets. Fix it, push, reopen the app.
* `HTTP 410`: the subscription expired. Reopen the app; it re-subscribes by itself.
* `ok: True` but nothing appears: check iPhone **設定 › 通知 › 賭讀** (allowed, banners on) and Focus mode. If the app was in front, you get an in-app toast instead of a banner.

The `send_test_push` action only works with the function secret, so the app itself can't trigger it.

## 6. Notification copy

`send-push` words every message from the **recipient's** point of view, at send time (`supabase/functions/_shared/copy.ts`). N = the other person's name; amounts in NT$. Titles are cut to 24 characters and bodies to 60; only the task title is shortened (with "…").

| kind | Who gets it | Title | Body |
|---|---|---|---|
| `due_1h` | owner | 賭讀 ⏰ 還剩 1 小時 | 「{title}」NT$ {value}，快去完成！ |
| `due_15m` | owner | 賭讀 🔥 只剩 15 分鐘 | 「{title}」NT$ {value} 快到期了 |
| `partner_done` | the other person | {N} 剛完成 +{value} | 你現在落後 NT$ {gap}，輪到你了 · 你領先 NT$ {gap} · 平手 |
| `partner_dispute` | owner | {N} 質疑了你的證明 | 「{title}」的照片需要再確認 |
| `overdue` | owner only | 賭讀 任務已逾期 | 「{title}」已逾期，不影響分數 |
| `daily` | each member with ≥ 1 active task | 賭讀 📚 今天還有 {n} 件事沒做 | 最近到期：「{title}」 |
| `settlement_request` | the other person | {N} 想結算 | 同意後總計歸零，目前 NT$ {amount} |
| `settlement_result` (accepted) | proposer | {N} 已同意結算 | 總計已歸零，可在歷史撤銷 |
| `settlement_result` (rejected / expired / undone) | as backend | backend text kept: 結算未成立 / 結算已撤銷 | e.g. 「Ming 拒絕了結算」 |
| test | you | 賭讀 測試通知 | 看到這則通知，代表推播設定成功 ✅ |

**About the backend's own texts:** the database still writes its original texts into `notification_outbox.payload`, e.g. "Ming 完成了任務". `send-push` replaces them with the table above. The table doesn't cover rejected, expired or undone settlements, so those keep the backend's wording.

**Grouping:** the notification tag is `kind:task_id` (or `settlement:id`, `daily:date`). A repeat of the same thing replaces the earlier notification instead of stacking.

## 7. Admin queries

Run these in the Supabase SQL Editor.

**Rows that failed 3 times (never delivered):**
```sql
select id, kind, recipient_id, attempts, error, created_at, last_attempt_at
from public.notification_outbox
where sent_at is null and attempts >= 3
order by created_at desc;
```

**Retry one of them after you fixed the cause:**
```sql
update public.notification_outbox set attempts = 0, claimed_at = null, error = null where id = 123;
```

**Last 20 deliveries:**
```sql
select id, kind, attempts, sent_at - created_at as delay, error
from public.notification_outbox where sent_at is not null
order by sent_at desc limit 20;
```

`error` can be set even on a delivered row:
* `NO_SUBSCRIPTION`: that person hasn't turned notifications on.
* `HTTP 410`: one of their devices expired; another device got it.

**Subscriptions per person:**
```sql
select m.display_name, s.user_agent, s.created_at, s.last_success_at, s.disabled_at
from public.push_subscriptions s join public.members m on m.id = s.member_id
order by m.display_name, s.created_at;
```

**Is the tick running?**
```sql
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'studybet-tick')
order by start_time desc limit 5;
```

## 8. Rotating secrets and keys

**FUNCTION_SECRET** (rotate it if it ever leaked):
1. Make a new one (PowerShell):
   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) })) -replace '[+/=]', ''
   ```
2. Update the database copy:
   ```sql
   update public.app_config set value = 'NEW_SECRET' where key = 'function_secret';
   ```
3. Update the function copy:
   ```powershell
   npx supabase secrets set FUNCTION_SECRET=NEW_SECRET
   ```
4. If you use the Cloudflare fallback, update its `FUNCTION_SECRET` variable too.
5. Check with step 9. If you still get 401 after a minute, redeploy both functions (step 8) so they pick up the new value.

Between steps 2 and 3, calls are refused with 401 and logged as `[send-push] 401 secret mismatch`. Rows created in that window stay unsent, and the next ticks retry them once the secrets match again (rows less than 3 attempts old).

**VAPID keys** (rarely needed): generate a new pair (step 5) and set both secrets (step 7). Put the new public key into `config.js` and push. Each phone notices the key change the next time the app opens, re-subscribes on its own and saves the new subscription. Until a phone has been opened once, its pushes fail with HTTP 403 and are recorded in `error`.

## 9. Troubleshooting

| Symptom | Where to look | Fix |
|---|---|---|
| Nothing ever arrives | `?debug=1` on the phone, then section 5 | Usually: permission not granted, VAPID key missing in `config.js`, or the app was opened in Safari instead of from the Home Screen |
| Reminders never come, partner events do | `cron.job_run_details` query above | The tick isn't running: repeat step 10, or use the Cloudflare fallback |
| Edge Function logs show `401 secret mismatch` | Supabase → Edge Functions → Logs | The secret differs between `app_config` and the function secrets; repeat steps 6–7 |
| "🔕 通知已關閉" bar in the app | `?debug=1` → **重新訂閱** | The subscription was revoked and the automatic repair failed (e.g. permission was turned off) |
| Push arrives minutes late | — | Apple's delivery; see [Honest limits](#2-honest-limits). Opening the app always shows the current state |
| iOS revokes the subscription after foreground pushes | — | In `docs/sw-push.js`, set `SUPPRESS_WHEN_FOCUSED = false`, bump `CACHE_VERSION` in `docs/sw.js` and `APP_VERSION` in `docs/src/version.js`, and push. That's the only change needed: every push then shows a system banner even with the app in front |

## 10. Files and local tests

| File | Purpose |
|---|---|
| `backend/05_push_delivery.sql` | `attempts` / `claimed_at` columns plus `claim_outbox`, `finish_outbox`, `push_context` (service_role only) |
| `supabase/functions/send-push/` | One outbox row → Web Push; also the `send_test_push` admin action |
| `supabase/functions/tick/` | Reminders, retry sweep, proof cleanup, nightly job for the Cloudflare fallback |
| `supabase/functions/_shared/` | Secret check, notification copy, delivery core (web-push builds the encrypted request; `fetch` sends it) |
| `supabase/tests/push_test.ts` | Local tests |
| `docs/push.js` | `enablePush()`, `getPushStatus()`, `syncBadge(n)`, plus self-repair and the debug info |
| `docs/sw-push.js` | Push and notification-tap handling inside the service worker; `SUPPRESS_WHEN_FOCUSED` |
| `docs/onboarding.js` | The 5-step install guide, the permission step after pairing, the "re-enable in Settings" guide |
| `docs/src/debug.js` | The `?debug=1` page |

Run the local tests (no Supabase needed; they include encrypting a real push and decrypting it the way a phone would):

```powershell
npx -y deno test --allow-env --allow-net=127.0.0.1 --allow-read supabase/tests/push_test.ts
```

✅ Expected: `ok | 13 passed | 0 failed`.
