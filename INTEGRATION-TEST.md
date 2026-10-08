# 賭讀 / StudyBet — Integration test (two real iPhones)

**You need:** two iPhones with **iOS 16.4 or later** (call them **A** and **B**), the published app URL, and a computer with the Supabase dashboard open. Setup is complete when README-push.md steps 1–11 are done.

**How to use:** do the items in order. Tick **Pass** or **Fail** and write what you saw under "Notes". "Locked" means: press the side button and wait 10 seconds.

Time limits are targets under normal conditions. Apple gives no delivery guarantee (see README-push.md §2). A late push is a **Fail with a note**, not a blocker. Repeat the item once before investigating.

Before starting, on each phone: **設定 › 通知 › 賭讀** must not exist yet (fresh install). Focus / Do Not Disturb is off.

---

### 1. Install via the onboarding (both phones)
1. Open the app URL in **Safari** on A.
2. Follow the 5-step guide: Share → 加入主畫面 → 新增 with "以網頁 App 形式開啟" on.
3. Open 賭讀 from the Home Screen.
4. Repeat on B.

Extra check: open the URL in **Chrome** or inside **LINE**. A warning to use Safari appears.

**Expected:** the guide shows one picture per step, Back/Next work, and swiping works. The Home Screen icon is the green book with the coin. Opening it shows the pairing screen, not the guide.

- [ ] Pass - [ ] Fail - Notes:

### 2. Pair, names correct
1. A: **建立房間** → name `A` → **產生** → **建立房間** → send the code to B.
2. B: **加入房間** → name `B` → paste the code → **加入房間**.

**Expected:** both phones reach Home. A's headline mentions **B** and B's mentions **A** (e.g. "和 B 平手"). The cards show the right names.

- [ ] Pass - [ ] Fail - Notes:

### 3. Enable notifications (both phones)
Right after pairing, the **開啟通知** step appears. Tap **🔔 開啟通知** → **允許**. On a phone where you skipped it: **⋯ › 設定 › 🔔 開啟通知**.

**Expected:** **設定** shows "✅ 通知已開啟". The `?debug=1` page (tap the version 5 times) shows 狀態 "已訂閱 ✅" and 已存到伺服器 "是".

- [ ] Pass - [ ] Fail - Notes:

### 4. Partner completion, foreground and locked
1. A adds "測試 20" worth **NT$ 20** and completes it while **B has the app open**.
2. Then A adds and completes another NT$ 20 task while **B is locked**.

**Expected:**
* Foreground: on B the gap updates in **< 2 s**, with an in-app toast like "A 剛完成 +20 — 你落後 NT$ 20". No system banner appears.
* Locked: within **2 minutes** (usually < 30 s) B's lock screen shows **A 剛完成 +20** / "你現在落後 NT$ 40，輪到你了".

- [ ] Pass - [ ] Fail - Notes (seconds measured):

### 5. 1-hour and 15-minute reminders, each once
1. On A, add task **X** due in **65 min** (自訂). Add task **Y** due in **20 min**. Lock A.
2. Leave A locked and don't complete X or Y.

**Expected:**
* **X:** "賭讀 ⏰ 還剩 1 小時" arrives about **15 min after creating it** (50 min left; reminders skip tasks younger than 15 min). "賭讀 🔥 只剩 15 分鐘" arrives about 50 min after creating it.
* **Y:** only "賭讀 🔥 只剩 15 分鐘", about **15 min after creating it** (5 min before its deadline). Y gets no 1-hour reminder.
* Each notification arrives **exactly once**, within 1–2 min of those times.

Optional SQL check, expecting one row per (task, kind):
```sql
select task_id, kind, sent_at from public.notification_log order by sent_at desc limit 5;
```

- [ ] Pass - [ ] Fail - Notes:

### 6. Deadline passes → overdue to the owner only
Let task **Y** from item 5 pass its deadline (or add one due in 6 min and wait).

**Expected:**
* Within 1–2 min A gets "賭讀 任務已逾期" / "「Y」已逾期，不影響分數". **B gets nothing.**
* Both phones' scores are unchanged.
* Y appears in **紀錄** with ⏰ 逾期, and moves there without reloading if the app is open.

- [ ] Pass - [ ] Fail - Notes:

### 7. Daily reminder
1. On A: **設定 › 每日提醒時間** → set it to **3 minutes from now** → **儲存**.
2. Make sure A has at least one active task that isn't overdue. Lock A.

**Expected:**
* Within 1–2 min after that time: "賭讀 📚 今天還有 {n} 件事沒做" / "最近到期：「…」".
* It arrives **once**; changing the time again the same day doesn't send another one.
* B gets it too if B has an active task, because the time is shared by both.
* Set the time back to 21:00 afterwards.

- [ ] Pass - [ ] Fail - Notes:

### 8. Badge equals active, non-overdue tasks
On A, with the app open and closed in turn:
1. Note the number of active tasks in **我的**. The icon badge shows the same number.
2. Complete one: the badge drops by 1 when you leave the app.
3. Add one: the badge rises by 1.
4. Close the app (swipe it away). Have B complete a task so a push arrives on A.

**Expected:**
* The badge always equals the "我的" count, with overdue tasks not counted.
* After step 4 the badge still shows the right number without opening the app (it's set from the push).

- [ ] Pass - [ ] Fail - Notes:

### 9. Dispute a proof
1. A adds a task with **📷 需要拍照證明** and completes it with a photo.
2. B: **紀錄** → tap that task → the photo loads → **質疑這個證明**. Lock A first.

**Expected:**
* A gets "B 質疑了你的證明" / "「…」的照片需要再確認".
* The task shows **被質疑** on both phones.
* **Scores don't change.**

- [ ] Pass - [ ] Fail - Notes:

### 10. Settlement request → agree → total 0 → undo restores
1. Make sure the total gap isn't 0. A: **⋯ › 結算 › 請求歸零**. B is locked.
2. B gets the notification → opens the app → card **同意**.
3. Then on either phone: **紀錄** → the settlement row → **撤銷**.

**Expected:**
* B gets "A 想結算" / "同意後總計歸零，目前 NT$ {amount}".
* After 同意: both headlines show 平手 / NT$ 0. A gets "B 已同意結算" / "總計已歸零，可在歷史撤銷".
* After 撤銷: the previous gap returns on both phones, and the other phone gets "結算已撤銷".

- [ ] Pass - [ ] Fail - Notes:

### 11. Airplane mode
1. On A open the app once online. Turn on **Airplane mode**, close the app and reopen it.
2. Still offline: complete a task that's due in about 6 minutes.
3. Wait until its deadline has passed, then turn Airplane mode off.

**Expected:**
* Step 1: the cached data shows, with the orange bar "離線中 — 最後更新 hh:mm".
* Step 2: the row is marked "已完成・等待連線", and the bar shows "1 項變更等待連線".
* Step 3: after reconnecting, a toast "「…」太晚了——伺服器時間顯示期限已經過了。" appears and the score is unchanged.

- [ ] Pass - [ ] Fail - Notes:

### 12. A third device can't join
On a third phone (or a private Safari window on a computer), open the app URL with `?dev=1` → **加入房間** → enter the code, **without** using "我回來了".

**Expected:** "配對碼不對，或這個房間已經滿了…". Nothing changes on A or B.

> By design, anyone with the code **can** take over a slot through "我回來了". That's how a phone that lost its data gets back in. Keep the code private.

- [ ] Pass - [ ] Fail - Notes:

### 13. Permission denied → app still works, guide shown
On B: iPhone **設定 › 通知 › 賭讀 › 允許通知 off**. Open 賭讀 → **⋯ › 設定**.

**Expected:**
* The notification section shows "通知被關掉了" with the picture **設定 › 通知 › 賭讀 › 允許通知**.
* Adding, completing and Realtime all still work.
* Turning permission back on and reopening the app restores "✅ 通知已開啟" with no extra steps.

- [ ] Pass - [ ] Fail - Notes:

---

### After the run
* Delivery delays: in the SQL Editor, run "Last 20 deliveries" from README-push.md §7.
* Anything stuck: run "Rows that failed 3 times" from the same section. It should return no rows.

Tester: ____________  Date: ____________  App version (設定, bottom): ________  iOS A / B: ______ / ______
