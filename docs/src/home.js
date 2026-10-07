// Home: headline gap, cards, streaks, tabs (Mine / Partner / History), FAB.
import { h, svg, reconcile, toast } from './dom.js';
import {
  S, emit, onUpdate, partnerName, myActive, partnerActive, queuedOp, isOnline, canUndo, nameOf,
  loadMoreHistory, refreshHistory, completeTask, respondSettlement, undoSettlement,
} from './store.js';
import { serverNow } from './clock.js';
import { dueLabel, fmtDayHeader, fmtMD, fmtHM, dayKey } from './time.js';
import * as fx from './fx.js';
import { compressImage, fakePhoto } from './image.js';
import { errText, msg } from './errors.js';
import { openAddTask, openTaskDetail, openSettle, openMenu, openQueue, confirmDialog } from './sheets.js';

const MINUS = '−';
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : '0');
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
/** From my point of view: amount_me > 0 means the partner pays me. */
export function payText(amountMe) {
  const pn = partnerName();
  if (amountMe > 0) return `${pn} 付你 NT$ ${amountMe}`;
  if (amountMe < 0) return `你付 ${pn} NT$ ${-amountMe}`;
  return '平手，不用付錢';
}

const RING = '<svg class="ringsvg" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring" cx="24" cy="24" r="22"/></svg>';
const TICK = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let el = {};
let shownGap = null;
let lastTab = null;
let sentinelObs = null;
let onCrash = (e) => { throw e; };

export function mountHome(root, opts = {}) {
  if (opts.onCrash) onCrash = opts.onCrash;
  if (location.hash === '#history') S.tab = 'history';
  shownGap = null; lastTab = null;
  const tabBtn = (id) => h('button', { role: 'tab', 'data-tab': id, onclick: () => setTab(id) });
  el = {
    rt: h('span', { class: 'rt-dot', title: '即時同步' }),
    bars: h('div'),
    gap: h('section', { class: 'gap even', 'aria-live': 'polite' }),
    gapLabel: h('div', { class: 'gap-label' }, ' '),
    gapNum: h('span', { class: 'n num' }, '—'),
    gapSub: h('div', { class: 'gap-sub' }, ' '),
    cardMe: h('div', { class: 'card' }),
    cardP: h('div', { class: 'card' }),
    streaks: h('div', { class: 'streaks' }),
    pending: h('div'),
    tabs: { mine: tabBtn('mine'), partner: tabBtn('partner'), history: tabBtn('history') },
    list: h('div', { class: 'list', role: 'tabpanel' }),
  };
  el.gap.append(el.gapLabel, h('div', { class: 'gap-num' }, h('span', { class: 'cur' }, 'NT$'), el.gapNum), el.gapSub);
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': '選單', onclick: (e) => openMenu(e.currentTarget) }, '⋯');
  root.replaceChildren(
    h('div', { class: 'app' },
      h('header', { class: 'top' },
        h('div', { class: 'brand' }, h('b', null, '賭讀'), h('small', null, 'StudyBet')),
        opts.mock && h('span', { class: 'chip-mock' }, 'MOCK'),
        el.rt, menuBtn),
      el.bars, el.gap,
      h('div', { class: 'cards' }, el.cardMe, el.cardP),
      el.streaks, el.pending,
      h('nav', { class: 'tabs', role: 'tablist' }, el.tabs.mine, el.tabs.partner, el.tabs.history),
      el.list),
    h('button', { class: 'fab', 'aria-label': '新增任務', onclick: () => openAddTask() }, '＋'),
  );
  onUpdate(render);
  render();
}

function setTab(id) {
  if (S.tab === id) return;
  S.tab = id;
  try { history.replaceState(null, '', id === 'history' ? '#history' : location.pathname + location.search); } catch {}
  if (id === 'history') refreshHistory().catch(() => {});
  render();
}

function render() {
  if (!el.list || !el.list.isConnected) return;
  try {
    renderTop();
    renderList();
  } catch (e) { onCrash(e); }
}

function renderTop() {
  const g = S.gs;
  const pn = partnerName();
  el.rt.className = `rt-dot ${S.rt === 'ok' && isOnline() ? 'ok' : ''}`;
  el.rt.title = S.rt === 'ok' ? '即時同步中' : '重新連線中…';

  // bars: offline + queue
  const bars = [];
  if (!isOnline()) bars.push(h('div', { class: 'bar orange' }, `離線中 — 最後更新 ${S.lastUpdated ? fmtHM(S.lastUpdated) : '—'}`));
  if (S.queue.length) {
    bars.push(h('div', { class: 'bar' }, `📤 ${S.queue.length} 項變更${isOnline() ? '送出中…' : '等待連線'}`,
      h('button', { class: 'link', onclick: openQueue }, '查看')));
  }
  const barSig = bars.map((b) => b.textContent).join('|');
  if (el.bars.dataset.sig !== barSig) { el.bars.replaceChildren(...bars); el.bars.dataset.sig = barSig; }

  // headline gap (total net)
  const n = g ? g.total_net_me : 0;
  let cls = 'even', label = '載入中…', sub = ' ';
  if (g && !g.partner) { label = '等待夥伴加入'; sub = '把配對碼傳給對方，就能開始對賭'; }
  else if (g && n > 0) { cls = 'lead'; label = `你領先 ${pn}`; sub = `本週 ${signed(g.week_net_me)}`; }
  else if (g && n < 0) { cls = 'behind'; label = `${pn} 領先你`; sub = `本週 ${signed(g.week_net_me)}`; }
  else if (g) { label = `和 ${pn} 平手`; sub = 'All square'; }
  el.gap.className = `gap ${cls}`;
  el.gapLabel.textContent = label;
  el.gapSub.textContent = sub;
  const abs = Math.abs(n);
  if (!g) el.gapNum.textContent = '—';
  else if (shownGap === null) el.gapNum.textContent = String(abs);
  else if (shownGap !== abs) fx.countTo(el.gapNum, shownGap, abs);
  if (g) shownGap = abs;

  // cards (mine | partner), partner values mirrored
  const dc = g?.done_counts;
  setCard(el.cardMe, g ? `${g.me.display_name}（你）` : '你', g?.week_net_me, g?.total_net_me, dc?.me.week);
  setCard(el.cardP, g?.partner ? pn : '夥伴', g?.partner ? -g.week_net_me : null, g?.partner ? -g.total_net_me : null, g?.partner ? dc?.partner.week : null);

  // streaks
  const st = g?.streaks;
  const sSig = st ? `${st.me}|${st.partner}|${pn}|${!!g.partner}` : '';
  if (el.streaks.dataset.sig !== sSig) {
    el.streaks.dataset.sig = sSig;
    el.streaks.replaceChildren(
      st && h('span', { class: 'streak me' }, `🔥 ${st.me} 天`),
      st && g.partner && h('span', { class: 'streak partner' }, `${pn} 🔥 ${st.partner}`));
  }

  // settlement request card
  const ps = g?.pending_settlement;
  const pSig = ps ? `${ps.id}|${ps.proposed_by_me}|${n}|${pn}` : '';
  if (el.pending.dataset.sig !== pSig) {
    el.pending.dataset.sig = pSig;
    if (!ps) el.pending.replaceChildren();
    else if (ps.proposed_by_me) el.pending.replaceChildren(h('div', { class: 'bar' }, `已請 ${pn} 確認歸零，等待回應中…`));
    else {
      const busy = (b) => { b.disabled = true; };
      el.pending.replaceChildren(h('div', { class: 'pending-card' },
        h('p', null, `${pn} 想把總差距歸零：${payText(n)}`),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn', onclick: (e) => { busy(e.currentTarget); answer(ps.id, true); } }, '同意'),
          h('button', { class: 'btn ghost', onclick: (e) => { busy(e.currentTarget); answer(ps.id, false); } }, '先不要'))));
    }
  }

  // tabs
  el.tabs.mine.textContent = `我的 ${g ? myActive().length : ''}`.trim();
  el.tabs.partner.textContent = `${pn} 的`;
  el.tabs.history.textContent = '紀錄';
  for (const [id, b] of Object.entries(el.tabs)) b.setAttribute('aria-selected', String(S.tab === id));
}

async function answer(id, accept) {
  try {
    await respondSettlement(id, accept);
    if (accept) { fx.playComplete(); toast('已結清！總差距歸零 🎉', { kind: 'good' }); }
  } catch (e) {
    el.pending.dataset.sig = '';
    toast(errText(e), { kind: 'warn' });
    emit();
  }
}

function setCard(box, name, week, total, done) {
  const sig = `${name}|${week}|${total}|${done}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const has = week != null;
  box.replaceChildren(
    h('h3', null, name),
    h('div', { class: 'k' }, '本週'),
    h('div', { class: `v num ${has ? tone(week) : 'zero'}` }, has ? signed(week) : '—'),
    h('div', { class: 'sub' }, h('span', null, `累計 ${has ? signed(total) : '—'}`), h('span', null, `✓ ${has ? done : '—'}`)));
}

// ---------- lists ----------
function renderList() {
  const animate = lastTab === S.tab;
  if (!animate) el.list.replaceChildren();
  lastTab = S.tab;
  if (!S.gs) {
    reconcile(el.list, [0, 1, 2].map((i) => ({ key: `sk${i}`, sig: 'sk', render: () => h('div', { class: 'skeleton' }) })), false);
    return;
  }
  if (S.tab === 'mine') {
    const ts = myActive();
    reconcile(el.list, ts.length ? ts.map(mineItem)
      : [emptyItem('📚', '還沒有任務。按右下角 ＋，5 秒就能新增一個。')], animate);
  } else if (S.tab === 'partner') {
    const ts = partnerActive();
    reconcile(el.list, ts.length ? ts.map(partnerItem)
      : [emptyItem('🌱', S.gs.partner ? `${partnerName()} 目前沒有進行中的任務` : '夥伴還沒加入')], animate);
  } else {
    reconcile(el.list, historyItems(), animate);
    watchSentinel();
  }
}

const emptyItem = (icon, text) => ({
  key: `empty-${text}`, sig: text, enter: false,
  render: () => h('div', { class: 'empty' }, h('span', { class: 'big' }, icon), text),
});

function dueTag(t) {
  const lab = dueLabel(Date.parse(t.due_at), serverNow());
  return lab.urgent ? h('span', { class: 'tag orange pulse' }, `⏰ ${lab.text}`) : h('span', null, lab.text);
}

function mineItem(t) {
  const q = t._queued ? 'create' : queuedOp(t.id);
  const saving = t._tmp && !t._queued;
  const retry = !!S.retry[t.id];
  const lab = dueLabel(Date.parse(t.due_at), serverNow());
  return {
    key: t._key || t.id,
    sig: [t.id, t.title, t.value, lab.text, lab.urgent, t.requires_proof, q, saving, retry].join('|'),
    render: () => {
      const check = retry
        ? h('button', { class: 'check retry', onclick: (e) => onRetry(t, e.currentTarget) }, '重試')
        : h('button', {
          class: `check ${q === 'complete' ? 'done' : ''}`, 'aria-label': `完成「${t.title}」`,
          disabled: saving || q === 'complete' || q === 'abandon', onclick: (e) => onCheck(t, e.currentTarget),
        }, svg(RING), svg(TICK));
      return h('div', { class: `row ${q || saving ? 'queued' : ''}` },
        check,
        h('button', { class: 'row-main', onclick: () => openTaskDetail(t) },
          h('div', { class: 'row-title' }, t.title),
          h('div', { class: 'row-meta' },
            dueTag(t),
            t.requires_proof && h('span', { class: 'tag blue' }, '📷 需照片'),
            saving && h('span', { class: 'tag' }, '儲存中…'),
            q === 'create' && h('span', { class: 'tag' }, '等待連線'),
            q === 'complete' && h('span', { class: 'tag green' }, '已完成・等待連線'),
            q === 'abandon' && h('span', { class: 'tag' }, '放棄・等待連線'),
            retry && h('span', { class: 'tag orange soft' }, '照片未上傳'))),
        h('div', { class: 'row-val num' }, `+${t.value}`));
    },
  };
}

function partnerItem(t) {
  const lab = dueLabel(Date.parse(t.due_at), serverNow());
  return {
    key: t.id,
    sig: [t.title, t.value, lab.text, lab.urgent, t.requires_proof, t.disputed].join('|'),
    render: () => h('div', { class: 'row' },
      h('div', { class: 'hist-ico' }, (partnerName()[0] || '?').toUpperCase()),
      h('button', { class: 'row-main', onclick: () => openTaskDetail(t) },
        h('div', { class: 'row-title' }, t.title),
        h('div', { class: 'row-meta' },
          dueTag(t),
          t.requires_proof && h('span', { class: 'tag blue' }, '📷 需照片'),
          t.disputed && h('span', { class: 'tag orange soft' }, '被質疑'))),
      h('div', { class: 'row-val num neg' }, `+${t.value}`)),
  };
}

function historyItems() {
  const H = S.history;
  if (!H.loaded) {
    if (!H.loading && isOnline()) refreshHistory().catch(() => {});
    return [0, 1, 2].map((i) => ({ key: `sk${i}`, sig: 'sk', render: () => h('div', { class: 'skeleton' }), enter: false }));
  }
  const out = [];
  let day = null;
  const now = serverNow();
  for (const it of H.items) {
    const at = Date.parse(it.at);
    const dk = dayKey(at);
    if (dk !== day) {
      day = dk;
      const label = fmtDayHeader(at, now);
      out.push({ key: `d:${dk}`, sig: label, enter: false, render: () => h('div', { class: 'hist-day' }, label) });
    }
    out.push(it.type === 'task' ? histTask(it) : histSettle(it));
  }
  if (!H.items.length) out.push(emptyItem('🗂️', '完成、放棄或逾期的任務和結算都會出現在這裡'));
  const sTxt = H.loading ? '載入中…' : !isOnline() ? '離線中，連線後可載入更多' : H.done ? (H.items.length ? '沒有更多了' : '') : '往下捲動載入更多';
  out.push({ key: 'sentinel', sig: sTxt, enter: false, render: () => h('div', { class: 'sentinel' }, sTxt) });
  return out;
}

function watchSentinel() {
  const s = el.list.querySelector('[data-key="sentinel"]');
  if (!s || s === watchSentinel.el) return;
  watchSentinel.el = s;
  sentinelObs?.disconnect();
  sentinelObs = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting) && S.tab === 'history') loadMoreHistory().catch(() => {});
  }, { rootMargin: '300px' });
  sentinelObs.observe(s);
}

const STATUS = { done: ['✓', '完成', 'done'], overdue: ['⏰', '逾期', 'overdue'], abandoned: ['✕', '放棄', ''] };
function histTask(it) {
  const [ico, word, cls] = STATUS[it.status] || STATUS.abandoned;
  const at = Date.parse(it.at);
  const who = it.mine ? '你' : partnerName();
  return {
    key: `t:${it.id}`,
    sig: [it.status, it.title, it.value, it.disputed, it.proof_path, it.proof_expired, it._queued, who].join('|'),
    render: () => h('div', { class: 'row' },
      h('div', { class: `hist-ico ${cls}` }, ico),
      h('button', { class: 'row-main', onclick: () => openTaskDetail(it) },
        h('div', { class: 'row-title' }, it.title),
        h('div', { class: 'row-meta' },
          h('span', null, `${who} · ${word} · ${fmtHM(at)}`),
          it.proof_path && h('span', { class: 'tag blue' }, it.proof_expired ? '照片已過期' : '📷 照片'),
          it.disputed && h('span', { class: 'tag orange soft' }, '被質疑'),
          it._queued && h('span', { class: 'tag' }, '等待連線'))),
      h('div', { class: `row-val num ${it.status !== 'done' ? 'muted' : it.mine ? '' : 'neg'}` }, `+${it.value}`)),
  };
}

function histSettle(it) {
  const undo = canUndo(it);
  let text;
  if (it.status === 'confirmed') text = `${fmtMD(Date.parse(it.confirmed_at))} 結清：${payText(it.amount_me)}`;
  else if (it.status === 'undone') text = `結清已撤銷${it.amount_me != null ? `（原本 ${payText(it.amount_me)}）` : ''}`;
  else if (it.status === 'rejected') text = it.responded_by ? `${nameOf(it.responded_by)}婉拒了結算請求` : '結算請求已過期';
  else text = '結算請求';
  return {
    key: `s:${it.id}`,
    sig: [it.status, text, undo].join('|'),
    render: () => h('div', { class: 'row' },
      h('div', { class: 'hist-ico settle' }, '＝'),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title wrap' }, text),
        h('div', { class: 'row-meta' }, fmtHM(Date.parse(it.at)), undo && h('span', null, '・24 小時內可撤銷'))),
      undo && h('button', { class: 'btn ghost small', onclick: () => onUndo(it) }, '撤銷')),
  };
}

async function onUndo(it) {
  const ok = await confirmDialog({ title: '撤銷這次結清？', body: '總差距會回到結清前的數字。', ok: '撤銷', okClass: 'orange' });
  if (!ok) return;
  try { await undoSettlement(it.id); toast('已撤銷，總差距已恢復'); } catch (e) { toast(errText(e), { kind: 'warn' }); }
}

// ---------- completing ----------
function rowCheck(t) {
  const key = t._key || t.id;
  return el.list.querySelector(`[data-key="${CSS.escape(key)}"] .check`);
}

/** Tap on the round check button. Must stay synchronous until the photo picker opens. */
export function onCheck(t, btn) {
  fx.haptic();
  if (t.requires_proof) { pickPhoto(t); return; }
  doComplete(t, btn, null);
}

let picker = null;
function pickPhoto(t) {
  picker?.remove();
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', 'aria-hidden': 'true' });
  picker = input;
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) { toast(msg('CAMERA'), { kind: 'warn' }); return; }
    let blob;
    try { blob = await compressImage(f); } catch (e) { fx.playWarn(); toast(errText(e), { kind: 'warn' }); return; }
    const b = rowCheck(t);
    doComplete(t, b, blob);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

function celebrate(btn, value) {
  if (!btn) return;
  btn.classList.remove('busy');
  btn.classList.add('done');
  fx.squish(btn);
  fx.floatGain(btn, `+NT$ ${value}`);
  fx.confetti(btn);
  fx.playComplete();
}

async function doComplete(t, btn, blob) {
  const row = btn?.closest('.row');
  if (btn) btn.disabled = true;
  if (blob) { btn?.classList.add('busy'); } else celebrate(btn, t.value);   // optimistic feel
  const res = await completeTask(t, blob);
  if (res.ok) {
    if (blob) celebrate(rowCheck(t) || btn, t.value);
    if (res.queued) toast('離線中：已記下這次完成，連線後會自動送出', { ms: 4500 });
    return;
  }
  // rejected → snap back with a shake; the score never moved
  const r = (rowCheck(t) || btn)?.closest('.row') || row;
  if (btn) { btn.classList.remove('done', 'busy'); btn.disabled = false; }
  if (r) { r.classList.remove('shake'); void r.offsetWidth; r.classList.add('shake'); setTimeout(() => r.classList.remove('shake'), 220); }
  fx.playWarn();
  toast(errText(res.error), { kind: 'warn', ms: 5000 });
}

function onRetry(t, btn) {
  fx.haptic();
  const blob = S.retry[t.id];
  if (!blob) { pickPhoto(t); return; }
  doComplete(t, btn, blob);
}

/** Test hook (?mock=1): complete like a tap, with a generated photo when proof is required. */
export async function triggerComplete(id) {
  const t = myActive().find((x) => x.id === id || x._key === id);
  if (!t) return { ok: false, error: 'TASK_NOT_FOUND_IN_MINE' };
  if (S.tab !== 'mine') { setTab('mine'); }
  render();
  const btn = rowCheck(t);
  fx.haptic();
  if (t.requires_proof) { const blob = await fakePhoto(); return doComplete(t, btn, blob); }
  return doComplete(t, btn, null);
}
export const showTab = setTab;
