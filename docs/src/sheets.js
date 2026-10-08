// Bottom sheets: add task, task detail, settle up, settings, queue; menu; confirm dialog.
import { h, toast, reducedMotion } from './dom.js';
import {
  S, emit, me, partnerName, isOnline, getApi, addTask, abandonTask, deleteTask, disputeTask,
  proposeSettlement, respondSettlement, undoSettlement, updateSettings, canUndo,
} from './store.js';
import { serverNow } from './clock.js';
import { endOfDay, fmtWhen, fmtMD, fmtMMSS, toLocalInput, fromLocalInput } from './time.js';
import { errText, msg } from './errors.js';
import * as fx from './fx.js';
import { APP_VERSION } from './version.js';
import { enablePush, getPushStatus } from '../push.js';
import { deniedGuide } from '../onboarding.js';
import { onCheck, payText, showTab } from './home.js';

const MIN = 6e4, DAY = 864e5;
let current = null;

export function openSheet(title, body, { onClose } = {}) {
  current?.close(true);
  const back = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'grab' }),
    h('div', { class: 'sheet-head' }, h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': '關閉', onclick: () => api.close() }, '✕')),
    body);
  const onKey = (e) => { if (e.key === 'Escape') api.close(); };
  const api = {
    sheet,
    close(instant) {
      if (current !== api) return;
      current = null;
      document.removeEventListener('keydown', onKey);
      onClose?.();
      if (instant || reducedMotion()) { sheet.remove(); back.remove(); return; }
      sheet.classList.add('closing'); back.classList.add('closing');
      setTimeout(() => { sheet.remove(); back.remove(); }, 200);
    },
  };
  back.addEventListener('click', () => api.close());
  document.addEventListener('keydown', onKey);
  document.body.append(back, sheet);
  current = api;
  return api;
}
export const closeSheet = () => current?.close();

export function confirmDialog({ title, body, ok = '確定', cancel = '取消', okClass = '' }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'backdrop dialog-back' });
    const done = (v) => { back.remove(); box.remove(); resolve(v); };
    const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      h('h2', null, title), h('p', null, body),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn ghost', onclick: () => done(false) }, cancel),
        h('button', { class: `btn ${okClass}`, onclick: () => done(true) }, ok)));
    back.addEventListener('click', () => done(false));
    document.body.append(back, box);
  });
}

const chip = (label, pressed, onclick, disabled) =>
  h('button', { class: 'chip', type: 'button', 'aria-pressed': String(!!pressed), disabled, onclick }, label);

// ---------- add task ----------
export function openAddTask() {
  if (!S.gs) return;
  const now = serverNow();
  const todayOK = endOfDay(0, now) - now >= 5 * MIN;
  const st = { value: 20, custom: false, due: todayOK ? 'today' : 'tomorrow', proof: false };

  const title = h('input', { class: 'input', maxlength: '40', placeholder: '例如：背 30 個英文單字', enterkeyhint: 'done', autocomplete: 'off', 'aria-label': '任務名稱' });
  const valueChips = h('div', { class: 'chips' });
  const stepVal = h('span', { class: 'v num' });
  const stepper = h('div', { class: 'stepper' },
    h('button', { class: 'btn ghost small', type: 'button', 'aria-label': '減少', onclick: () => setVal(st.value - 1) }, '−'),
    stepVal,
    h('button', { class: 'btn ghost small', type: 'button', 'aria-label': '增加', onclick: () => setVal(st.value + 1) }, '+'));
  const dueChips = h('div', { class: 'chips' });
  const dt = h('input', { class: 'input', type: 'datetime-local', 'aria-label': '自訂期限' });
  const proof = h('input', { type: 'checkbox', class: 'switch', 'aria-label': '需要拍照證明', onchange: () => { st.proof = proof.checked; } });
  const err = h('div', { class: 'msg warn', hidden: true });

  function setVal(v) { st.value = Math.min(50, Math.max(1, v)); draw(); }
  function draw() {
    valueChips.replaceChildren(
      ...[10, 20, 30, 50].map((v) => chip(`NT$ ${v}`, !st.custom && st.value === v, () => { st.custom = false; st.value = v; draw(); })),
      chip('自訂', st.custom, () => { st.custom = true; draw(); }));
    stepper.hidden = !st.custom;
    stepVal.textContent = st.value;
    const n = serverNow();
    dueChips.replaceChildren(
      chip('今天 23:59', st.due === 'today', () => { st.due = 'today'; draw(); }, endOfDay(0, n) - n < 5 * MIN),
      chip('明天 23:59', st.due === 'tomorrow', () => { st.due = 'tomorrow'; draw(); }),
      chip('3 天後 23:59', st.due === 'in3', () => { st.due = 'in3'; draw(); }),
      chip('自訂', st.due === 'custom', () => {
        st.due = 'custom';
        const m = serverNow();
        dt.min = toLocalInput(m + 6 * MIN);
        dt.max = toLocalInput(m + 7 * DAY - MIN);
        if (!dt.value) dt.value = toLocalInput(endOfDay(1, m));
        draw();
      }));
    dt.hidden = st.due !== 'custom';
  }
  function dueMs() {
    const n = serverNow();
    if (st.due === 'today') return endOfDay(0, n);
    if (st.due === 'tomorrow') return endOfDay(1, n);
    if (st.due === 'in3') return endOfDay(3, n);
    return fromLocalInput(dt.value);
  }
  function showErr(code) { err.textContent = msg(code); err.hidden = false; fx.playWarn(); }

  async function submit() {
    const t = title.value.trim();
    if (t.length < 1 || t.length > 40) { showErr('BAD_TITLE'); title.focus(); return; }
    const due = dueMs(), n = serverNow();
    if (!Number.isFinite(due) || due < n + 5 * MIN || due > n + 7 * DAY) { showErr('BAD_DUE'); return; }
    fx.haptic();
    sheet.close();
    showTab('mine');
    const res = await addTask({ title: t, value: st.value, dueMs: due, requiresProof: st.proof });
    if (res.queued) toast('離線中：已記下，連線後會自動新增');
    else if (!res.ok) { fx.playWarn(); toast(errText(res.error), { kind: 'warn', ms: 5000 }); }
  }
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });

  draw();
  const body = h('div', null,
    h('label', { class: 'field' }, h('span', null, '要做什麼？'), title),
    h('div', { class: 'field' }, h('span', null, '完成可得'), valueChips, stepper),
    h('div', { class: 'field' }, h('span', null, '期限（台北時間）'), dueChips, h('div', { style: 'margin-top:10px' }, dt)),
    h('label', { class: 'toggle-row' }, h('span', null, '📷 需要拍照證明'), proof),
    err,
    h('button', { class: 'btn block', onclick: submit }, '新增'));
  const sheet = openSheet('新增任務', body);
  title.focus();   // same tap as ＋ → iOS shows the keyboard
}

// ---------- task detail ----------
export function openTaskDetail(t) {
  const myId = me()?.id;
  const mine = t.mine ?? t.owner_id === myId;
  const isHist = t.type === 'task';
  const now = serverNow();
  const status = isHist ? t.status : Date.parse(t.due_at) <= now ? 'overdue' : t.status;
  const statusText = { active: '進行中', done: '完成', overdue: '逾期', abandoned: '放棄' }[status] || status;
  const owner = mine ? '你' : partnerName();
  let timer = null;

  const proofBox = t.proof_path
    ? h('div', { class: 'proof-box' }, t.proof_expired ? '照片已超過 30 天，已自動刪除' : '載入照片中…')
    : null;
  if (proofBox && !t.proof_expired) {
    if (!isOnline()) proofBox.textContent = '離線中，連線後才能看照片';
    else {
      getApi().signedUrl(t.proof_path).then((url) => {
        const img = h('img', { alt: `「${t.title}」的證明照片`, decoding: 'async' });
        img.onload = () => proofBox.replaceChildren(img);
        img.onerror = () => { proofBox.textContent = '照片載入失敗'; };
        img.src = url;
      }, (e) => { proofBox.textContent = errText(e); });
    }
  }

  const actions = h('div', { class: 'row-btns', style: 'margin-top:8px' });
  const canAct = mine && status === 'active' && !t._queued;
  if (canAct) {
    const doneBtn = h('button', { class: 'btn', onclick: () => {
      sheet.close(true);
      showTab('mine');
      const b = document.querySelector(`[data-key="${CSS.escape(t._key || t.id)}"] .check`);
      onCheck(t, b);   // still inside the tap → photo picker allowed
    } }, t.requires_proof ? '📷 拍照完成' : '完成');
    const abandonBtn = h('button', { class: 'btn ghost', onclick: async () => {
      const ok = await confirmDialog({
        title: '放棄這個任務？',
        body: `「${t.title}」會移到紀錄並標記為放棄。不會扣分，但也拿不到 NT$ ${t.value}。`,
        ok: '放棄', okClass: 'orange',
      });
      if (!ok) return;
      sheet.close();
      const r = await abandonTask(t);
      if (r.queued) toast('離線中：連線後會送出放棄');
      else if (!r.ok) toast(errText(r.error), { kind: 'warn' });
    } }, '放棄');
    actions.append(doneBtn, abandonBtn);

    const created = Date.parse(t.created_at);
    if (t._tmp || serverNow() < created + 5 * MIN) {
      const delBtn = h('button', { class: 'btn ghost', onclick: async () => {
        try { await deleteTask(t); sheet.close(); toast('已刪除'); } catch (e) { toast(errText(e), { kind: 'warn' }); }
      } });
      const tickDel = () => {
        const left = created + 5 * MIN - serverNow();
        if (t._tmp) { delBtn.textContent = '刪除'; return; }
        if (left <= 0) { delBtn.remove(); clearInterval(timer); return; }
        delBtn.textContent = `刪除（${fmtMMSS(left)}）`;
      };
      tickDel();
      timer = setInterval(tickDel, 1000);
      actions.append(delBtn);
    }
  }
  if (!mine && status === 'done') {
    const label = () => (t.disputed ? '取消質疑' : t.proof_path ? '質疑這個證明' : '質疑這個任務');
    const btn = h('button', { class: 'btn ghost block', onclick: async () => {
      btn.disabled = true;
      const r = await disputeTask(t, !t.disputed);
      btn.disabled = false;
      if (!r.ok) { toast(errText(r.error), { kind: 'warn' }); return; }
      btn.textContent = label();
      badge.hidden = !t.disputed;
      if (r.queued) toast('離線中：連線後會送出');
    } }, label());
    actions.append(btn);
  }

  const badge = h('span', { class: 'tag orange soft', hidden: !t.disputed }, mine ? '被質疑' : '你質疑了這個任務');
  const body = h('div', null,
    h('div', { class: 'row-title', style: 'font-size:22px;white-space:normal' }, t.title),
    h('div', { class: 'row-meta', style: 'margin:6px 0 4px' }, badge,
      t.requires_proof && h('span', { class: 'tag blue' }, '📷 需照片')),
    h('dl', { class: 'detail-grid' },
      h('dt', null, '金額'), h('dd', { class: 'num' }, `NT$ ${t.value}`),
      h('dt', null, '期限'), h('dd', null, fmtWhen(Date.parse(t.due_at), now)),
      h('dt', null, '狀態'), h('dd', null, statusText),
      h('dt', null, '屬於'), h('dd', null, owner),
      t.completed_at && [h('dt', null, '完成於'), h('dd', null, fmtWhen(Date.parse(t.completed_at), now))]),
    proofBox,
    mine && t.disputed && h('p', { class: 'msg info' }, `${partnerName()} 對這個任務有疑問。分數不受影響，聊聊吧！`),
    actions);
  const sheet = openSheet('任務詳情', body, { onClose: () => clearInterval(timer) });
}

// ---------- settle up ----------
export function openSettle() {
  const g = S.gs;
  if (!g) return;
  const pn = partnerName();
  const n = g.total_net_me;
  const ps = g.pending_settlement;
  const lc = g.last_confirmed_settlement;
  const box = h('div');
  const run = async (btn, fn, okText) => {
    btn.disabled = true;
    try { await fn(); if (okText) toast(okText, { kind: 'good' }); sheet.close(); }
    catch (e) { btn.disabled = false; toast(errText(e), { kind: 'warn' }); }
  };

  box.append(h('section', null,
    h('div', { class: 'k', style: 'text-align:center;font-weight:700;color:var(--muted)' }, '目前總差距'),
    h('div', { class: `big-amount num ${n > 0 ? 'gap lead' : n < 0 ? 'gap behind' : 'gap even'}`, style: 'min-height:0;padding:0' }, n === 0 ? '平手' : payText(n)),
    h('p', { style: 'color:var(--muted);font-weight:600' }, '現實中付完錢後，按「請求歸零」。對方同意後總差距歸零；本週分數不受影響，紀錄也不會刪除。')));

  if (!g.partner) box.append(h('p', { class: 'msg info' }, msg('NO_PARTNER')));
  else if (ps && ps.proposed_by_me) {
    box.append(h('p', { class: 'msg info' }, `已送出，等待 ${pn} 同意（${fmtMD(Date.parse(ps.expires_at))} 前有效）。`));
  } else if (ps) {
    const yes = h('button', { class: 'btn', onclick: () => run(yes, () => respondSettlement(ps.id, true), '已結清！總差距歸零 🎉') }, '同意');
    const no = h('button', { class: 'btn ghost', onclick: () => run(no, () => respondSettlement(ps.id, false)) }, '先不要');
    box.append(h('p', { class: 'msg info' }, `${pn} 想把總差距歸零。`), h('div', { class: 'row-btns' }, yes, no));
  } else {
    const req = h('button', { class: 'btn block', disabled: n === 0, onclick: () => run(req, proposeSettlement, `已請 ${pn} 確認`) }, '請求歸零');
    box.append(req);
  }

  if (lc) {
    const item = { type: 'settlement', id: lc.id, status: 'confirmed' };
    const undoable = canUndo(item);
    const undo = h('button', { class: 'btn ghost small', onclick: async () => {
      if (!(await confirmDialog({ title: '撤銷這次結清？', body: '總差距會回到結清前的數字。', ok: '撤銷', okClass: 'orange' }))) return;
      run(undo, () => undoSettlement(lc.id), '已撤銷');
    } }, '撤銷');
    box.append(h('section', null,
      h('div', { class: 'toggle-row' },
        h('span', null, `上次結清 ${fmtMD(Date.parse(lc.confirmed_at))}：${payText(lc.amount_me)}`),
        undoable && undo)));
  }
  const sheet = openSheet('結算', box);
}

// ---------- settings ----------
export function openSettings() {
  const g = S.gs;
  if (!g) return;
  const name = h('input', { class: 'input', maxlength: '6', value: g.me.display_name, autocomplete: 'off', 'aria-label': '顯示名稱' });
  const time = h('input', { class: 'input', type: 'time', value: (g.room?.daily_reminder_time || '21:00').slice(0, 5), 'aria-label': '每日提醒時間' });
  const save = async (btn, n, t, okText) => {
    btn.disabled = true;
    try { await updateSettings(n, t); toast(okText, { kind: 'good' }); } catch (e) { toast(errText(e), { kind: 'warn' }); }
    btn.disabled = false;
  };
  const nameBtn = h('button', { class: 'btn small', onclick: () => {
    const v = name.value.trim();
    if (v.length < 1 || v.length > 6) { toast(msg('BAD_NAME'), { kind: 'warn' }); return; }
    save(nameBtn, v, null, '名字已更新');
  } }, '儲存');
  const timeBtn = h('button', { class: 'btn small', onclick: () => save(timeBtn, null, time.value || '21:00', '提醒時間已更新') }, '儲存');
  const sound = h('input', { type: 'checkbox', class: 'switch', checked: fx.soundOn(), 'aria-label': '音效',
    onchange: () => { fx.setSound(sound.checked); if (sound.checked) fx.playComplete(); } });

  // Notifications: 'unsupported' | 'needs-install' | 'default' | 'denied' | 'subscribed'
  const pushStatus = h('small', null, '');
  const pushExtra = h('div');
  const pushBtn = h('button', { class: 'btn blue block', hidden: true, onclick: () => {
    // enablePush() must start inside this tap (iOS permission prompt rule): no await before it.
    pushBtn.disabled = true;
    Promise.resolve(enablePush()).then((s) => {
      pushBtn.disabled = false;
      if (s === 'subscribed') toast('通知已開啟 🔔', { kind: 'good' });
      showPush();
    }, (e) => { pushBtn.disabled = false; toast(errText(e), { kind: 'warn' }); });
  } }, '🔔 開啟通知');
  const PUSH_TEXT = {
    subscribed: '✅ 通知已開啟',
    default: '尚未開啟。開啟後會提醒截止時間，並通知對方的進度。',
    denied: '',
    'needs-install': '請從主畫面的「賭讀」圖示打開，才能開啟通知（Safari 分頁裡不行）。',
    unsupported: '這台裝置目前無法收通知：需要 iOS 16.4 以上、從主畫面開啟，且管理員已設定推播金鑰。',
  };
  const showPush = () => Promise.resolve().then(() => getPushStatus()).then((s) => {
    pushStatus.textContent = PUSH_TEXT[s] ?? '';
    pushBtn.hidden = s !== 'default';
    pushExtra.replaceChildren(s === 'denied' ? deniedGuide() : '');
    if (S.pushOff && s === 'subscribed') pushExtra.replaceChildren(h('p', { class: 'msg warn' }, '通知已關閉：訂閱失效且自動修復失敗。請關掉 App 再打開；若仍如此，到 ?debug=1 按「重新訂閱」。'));
  }, () => { pushStatus.textContent = ''; });
  showPush();

  let taps = 0;
  const version = h('p', { style: 'color:var(--muted);font-size:13px;text-align:center;margin-top:20px', onclick: () => {
    if (++taps >= 5) location.href = './?debug=1';   // hidden shortcut to the push diagnostics page
  } }, `賭讀 StudyBet v${APP_VERSION}${getApi()?.mode === 'mock' ? '（mock 模式）' : ''}`);

  const body = h('div', null,
    h('label', { class: 'field' }, h('span', null, '你的名字（1–6 字）'), h('div', { class: 'input-row' }, name, nameBtn)),
    h('label', { class: 'field' }, h('span', null, '每日提醒時間（兩人共用）'), h('div', { class: 'input-row' }, time, timeBtn),
      h('small', null, '提醒時間屬於整個房間，修改後兩支手機都會改變。台北時間。')),
    h('label', { class: 'toggle-row' }, h('span', null, '🔊 音效'), sound),
    h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:700;margin-bottom:6px' }, '🔔 通知'), pushBtn, pushStatus, pushExtra),
    version);
  openSheet('設定', body);
}

// ---------- queue & menu ----------
export function openQueue() {
  const label = { create: '新增', complete: '完成', abandon: '放棄', dispute: '質疑' };
  const list = S.queue.length
    ? S.queue.map((q, i) => h('div', { class: 'toggle-row' },
      h('span', null, `${i + 1}. ${q.op === 'dispute' && !q.flag ? '取消質疑' : label[q.op]}「${q.title || ''}」`),
      q.op === 'complete' && q.proof && h('span', { class: 'tag blue' }, '📷')))
    : [h('p', { class: 'empty' }, '沒有等待中的變更')];
  openSheet('等待連線的變更', h('div', null,
    h('p', { style: 'color:var(--muted);font-weight:600' }, isOnline() ? '正在依序送出…' : '連上網路後會依序自動送出。期限以伺服器時間為準。'),
    ...list));
}

export function openMenu(anchor) {
  const back = h('div', { class: 'backdrop', style: 'background:transparent' });
  const close = () => { back.remove(); menu.remove(); };
  const item = (label, fn) => h('button', { onclick: () => { close(); fn(); } }, label);
  const menu = h('div', { class: 'menu', role: 'menu' },
    item('🤝 結算', openSettle),
    item('⚙️ 設定', openSettings),
    S.queue.length && item(`📤 等待中的變更（${S.queue.length}）`, openQueue));
  back.addEventListener('click', close);
  document.body.append(back, menu);
  anchor?.blur?.();
  emit();
}
