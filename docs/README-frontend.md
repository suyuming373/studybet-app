# 賭讀 / StudyBet — Frontend (Part B)

A static PWA made of plain HTML, CSS and ES modules. There is no build step. It lives in the **`docs/`** folder, so GitHub Pages can publish it straight from the repository.

| File | Purpose |
|---|---|
| `index.html`, `app.css`, `app.js` | App shell, styles, entry point (boot, error boundary, test hooks) |
| `config.js` | **Your** Supabase values (empty placeholders until you fill them in) |
| `src/*.js` | Modules: `store` (data, offline queue, Realtime), `home`, `sheets`, `viewer` (full-screen proof photo), `pairing`, `fx` (sound/haptics/confetti), `mock` (`?mock=1` fake backend), … |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (`icon.svg` is the source for the PNGs) |
| `sw.js` | Service worker: precaches the app and supabase-js, stale-while-revalidate |
| `push.js`, `onboarding.js`, `sw-push.js` | Web Push, app badge, install guide (Part C, see `../README-push.md`) |

---

## 1. Preview on your computer (no Supabase needed)

You need either Python or Node.js. Check by opening **PowerShell** (Start menu → type `PowerShell`):

```powershell
python --version     # or:
node --version
```

1. In File Explorer, open the project's `docs` folder. Click the address bar, type `powershell` and press **Enter**. A PowerShell window opens in that folder.
2. Start a small web server with **one** of these:
   ```powershell
   python -m http.server 8080
   # or
   npx serve -l 8080
   ```
   (If Windows Firewall asks, click **Allow**.)
3. Open **http://localhost:8080/?mock=1** in Chrome or Edge.
4. Press `F12` → click the phone icon (**Toggle device toolbar**) → pick **iPhone 12 Pro** or type width **380**.

✅ You see "Ming 領先你 NT$ 40", two cards, two of your tasks and a green ＋ button.

Useful variants:

| URL | What it does |
|---|---|
| `/?mock=1` | Full app with a fake in-memory backend ("Me" and "Ming", 5 tasks, 1 settlement). Reload = fresh start. |
| `/?mock=1&pair=1` | Same, starting at the pairing screen. Join code: `studybet-demo` (the room is full, so tap 我回來了 and pick slot 1). |
| `/?mock=1&batch2=1` | Same, but the fake backend behaves like the real one **with `backend/06` applied**: disputed tasks pause their money (badge "質疑中 · 暫不計分", settlement note), and `get_state().me.daily_reminder_enabled` exists, so 設定 shows the **每日提醒** switch (the partner's value is never exposed). |
| `/?mock=1` (no `batch2`) | Behaves like a backend **without** 06: disputes don't touch the money, the switch stays hidden and the mock rejects `p_daily_reminder_enabled`. Useful to check that v1.2.0 still works before you run 06. |
| `/?dev=1` | The **real** Supabase backend without the "add to Home Screen" gate (needs `config.js`). |

### Test hooks (`?mock=1` only)

Open the browser console (`F12` → **Console**) and type:

```js
__studybet.state                          // live app state
__studybet.addTask({ title: '測試', value: 30, due_in_minutes: 10 })
__studybet.completeTask(__studybet.state.tasks[0].id)   // same path as a tap (generates a photo for proof tasks)
__studybet.simulatePartnerComplete(20)    // toast "Ming 剛完成 +20 — 你落後 NT$ …"
__studybet.advance(30)                    // move time forward 30 minutes
__studybet.setClockOffset(-45 * 60000)    // phone clock 45 min slow; countdowns must not change
__studybet.simulateOffline(true)          // then complete something; later: simulateOffline(false)
__studybet.simulateRealtimeDrop()         // header dot turns orange, then green again
__studybet.simulatePartnerProposeSettlement()   // extra: shows the Agree / Not now card
__studybet.simulatePartnerRespond(true)          // extra: partner accepts your request
__studybet.simulatePartnerDispute()              // Ming disputes your latest done task (with &batch2=1 its money pauses)
__studybet.simulatePartnerDispute(id, false)     // …and clears it again: toast "Ming 取消質疑「…」，+N 已加回"
__studybet.simulateExpiredPhotoUrl()             // next proof photo link is already expired → 照片載入失敗，請重試 / 重新載入
__studybet.simulateProofExpired(id)              // 30-day cleanup ran: detail shows 照片已超過 30 天，已清除
```

> **Seeing old files after an edit?** The service worker serves the cached copy first and updates in the background. Reload twice, or in DevTools → **Application** → **Service workers** tick **Update on reload**.

---

## 2. Fill in `config.js`

Open `docs/config.js` in Notepad (right-click → **Open with** → **Notepad**) and paste the values between the quotes:

| Key | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → **Project Settings** (gear) → **Data API** → **Project URL**, e.g. `https://abcdefghijkl.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → **Project Settings** → **API Keys** → the **anon / public** key (or the **publishable** key) |
| `VAPID_PUBLIC_KEY` | The **Public Key** from `npx web-push generate-vapid-keys` (README-push.md step 5/11). Empty = notifications stay off. |
| `TURNSTILE_SITE_KEY` | Optional. Only if you turned on CAPTCHA in Supabase → **Authentication** (Cloudflare Turnstile). Empty = no CAPTCHA widget. |

These values are safe to publish. **Never** put the `service_role` key here.

Save the file (`Ctrl` + `S`). If `SUPABASE_URL` or `SUPABASE_ANON_KEY` is missing, the app shows a setup screen that lists what is still empty.

---

## 3. Publish on GitHub Pages (step by step)

### 3a. One-time setup
1. Create a free account at https://github.com.
2. Install **GitHub Desktop**: https://desktop.github.com → sign in with your GitHub account.
3. GitHub Desktop → **File** → **Add local repository** → choose the project folder (the one that holds `docs`, `backend` and `CONTRACT.md`). If it says "not a Git repository", click **create a repository** → **Create repository**.
4. Look at the **Changes** list on the left. You should **not** see any `.env` or key files; `.gitignore` excludes them.
5. Type a summary (e.g. `first version`) → **Commit to main** → **Publish repository**. Untick **Keep this code private** only if your GitHub plan needs a public repo for Pages (Free plan: Pages requires a **public** repository).

### 3b. Turn on Pages
1. On github.com open your repository → **Settings** → **Pages** (left sidebar).
2. **Source**: *Deploy from a branch*. **Branch**: `main`, folder **`/docs`** → **Save**.
3. Wait 1–2 minutes and reload the page. It shows **"Your site is live at https://<user>.github.io/<repo>/"**.

✅ Open `https://<user>.github.io/<repo>/?mock=1` on your computer and the app appears.

### 3c. Install on the iPhone
1. On the iPhone open `https://<user>.github.io/<repo>/` in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open 賭讀 from the Home Screen icon. In Safari itself the app only shows the install hint, on purpose.

### 3d. Releasing an update
1. Change files and save.
2. Bump the version in **both** `docs/sw.js` (e.g. `CACHE_VERSION = 'v1.1.1'`) and `docs/src/version.js` (`APP_VERSION = '1.1.1'`).
3. GitHub Desktop → **Commit to main** → **Push origin**.
4. Phones pick it up on the next launch and show "新版本已就緒 / 重新整理".

If you only changed `config.js`, there's no need to bump the version: the service worker always fetches `config.js` from the network first.

---

## 4. Manual checklist (on an iPhone, installed to the Home Screen)

- [ ] **Add a task in ≤ 5 s**: tap ＋, type a title, tap 新增. The sheet closes and the row slides in.
- [ ] **Complete with animation + sound + haptic**: tap the round button. It squishes, "+NT$ 20" floats up, confetti plays, two rising tones sound, the phone ticks (iOS 17.4+), and the headline number counts to its new value.
- [ ] **Complete with proof < 150 KB**: on a 📷 task, iOS offers 拍照 / 相簿 / 選擇檔案. Try both a new photo and one from 相簿 (HEIC). In Supabase → Storage → `proofs` each file is a JPEG ≤ 150 KB.
- [ ] **Deadline passing moves a row to History** while the app stays open (try a task due in 6 minutes).
- [ ] **Offline open shows cached data**: open once online, turn on Airplane mode, reopen. The orange "離線中 — 最後更新 hh:mm" bar appears and the data is there.
- [ ] **Offline completion past the deadline is rejected after reconnect**: in Airplane mode complete a task due in ~6 min, wait until it is past due, turn Airplane mode off. You get "太晚了——伺服器時間顯示期限已經過了".
- [ ] **Dark mode**: iPhone Settings → Display → Dark. Colours switch and nothing is unreadable.
- [ ] **320 px width has no horizontal scroll**: Chrome DevTools, width 320, `?mock=1`.
- [ ] **Lighthouse PWA installable**: Chrome DevTools → **Lighthouse** → check the installability items against the GitHub Pages URL.
- [ ] **Partner's change within 2 s**: with two phones, complete on one. The other shows a toast and the new gap.
- [ ] **Proof photo viewer (v1.2.1)**: in a task's 任務詳情 tap the photo. It opens full screen; pinch to zoom (up to 4x), double-tap toggles 1x/2x, drag to move when zoomed. The page behind does not scroll or zoom. Swipe down, tap beside the photo or ✕ to close. On the partner's photo, 質疑這張證明 is at the bottom.
- [ ] **Dispute pauses the money (v1.2.0, after 06)**: dispute the partner's done task → confirm dialog → both headlines change by its value, badge "質疑中 · 暫不計分". Only the disputer has **取消質疑**; tapping it brings the money back.

---

## 5. Notes for Part C and maintainers

- **Push, onboarding and badge (Part C, implemented).** `push.js` exports `enablePush()`, `getPushStatus()` and `syncBadge(n)`:
  - `enablePush()` is called directly inside a tap; `Notification.requestPermission()` is its first await.
  - `getPushStatus()` returns `'unsupported' | 'needs-install' | 'default' | 'denied' | 'subscribed'`.
  - `syncBadge(n)` runs after every `get_state()` and on `visibilitychange`.
  - Extras: `initPush()`, `repairPush()` (silent re-subscribe on each app open) and `debugInfo()`.
- **Onboarding:** `onboarding.js` `showOnboarding()` renders the 5-step guide into `#app`, replacing the install hint. `showPermissionStep()` runs after pairing; `deniedGuide()` is used in Settings.
- **Service worker:** `sw-push.js` holds the push and notification-click handlers. `SUPPRESS_WHEN_FOCUSED` sits at the top.
- **Setup:** see `../README-push.md`. Diagnostics: `?debug=1`, or tap the version in Settings 5 times.
- **Pairing**: `BAD_CODE` means "wrong code **or** room full" (CONTRACT A1). After a `BAD_CODE` on Join, the app explains both cases and opens the **我回來了** slot picker. The picker is also always reachable under the Join form.
- **Daily reminder time** is a room setting (`rooms.daily_reminder_time`), so Settings labels it 兩人共用 (shared by both people). The **on/off switch** is per person (`members.daily_reminder_enabled`, backend 06): "每日提醒（開／關只影響你自己）".
- **Batch 2 detection (v1.2.0):** `store.js` `hasReminderToggle()` / `disputesPauseMoney()` are true when `get_state().me.daily_reminder_enabled` is defined, i.e. `backend/06_dispute_and_daily.sql` has been run. Until then the app keeps the old behavior and texts (dispute = badge "被質疑" only, no switch, no settlement note), so this frontend can be published before or after running 06.
- **Disputes (after 06):** a disputed task counts for nobody until the member who disputed it taps **取消質疑**. A task still disputed when a settlement is confirmed stays out of the total even after it is cleared (it still counts in its week); the Settlement sheet says "質疑中的任務不計入這次結算". See `CONTRACT.md` → A8.
- **Proof viewer (v1.2.1):** `src/viewer.js` `openProofViewer(task, { badge, dispute })`. Every open and every **重新載入** asks for a new 60 s signed URL (`createSignedUrl`). Signed URLs live only in the `<img>`: they are never written to IndexedDB, and the service worker never touches Supabase requests. If a link has expired the image fails to load and the viewer offers 重新載入. The dispute button inside the viewer runs the same code as the one in the sheet (same confirmation dialog), and both update together.
- **supabase-js** is pinned to `2.117.3` (jsDelivr `+esm`). The 9 module URLs it pulls in are listed in `sw.js` → `CDN_FILES`. When you upgrade, change both `src/api-supabase.js` and that list.
- **Size**: about 125 KB of own code uncompressed, about 39 KB gzipped as GitHub Pages serves it (excluding supabase-js; `mock.js` loads only with `?mock=1`).
