// App state, server sync, offline snapshot + write queue, Realtime with backoff.
import { serverNow, localNow, syncServer, clockOffset, setOffset } from './clock.js';
import { idbGet, idbSet } from './idb.js';
import { AppError, toAppError, msg } from './errors.js';
import { setTz } from './time.js';
import { toast, toastOnce } from './dom.js';
import { syncBadge } from '../push.js';

const PAGE = 30;
const RT_DELAYS = [1000, 2000, 5000, 10000, 30000];

export const S = {
  gs: null,                 // last get_state()
  tasks: [],                // active tasks from `tasks` (deleted_at is null)
  saving: {},               // tempKey → task being created right now (shown immediately)
  history: { items: [], done: false, loading: false, loaded: false },
  queue: [],                // offline writes, sent in order on reconnect
  retry: {},                // taskId → Blob whose upload failed ("Retry")
  online: navigator.onLine, // browser connectivity
  netDown: false,           // last request failed with a network error
  forcedOffline: false,     // ?mock=1 simulateOffline(true)
  rt: 'connecting',         // 'connecting' | 'ok' | 'down'
  lastUpdated: null,        // ms (phone clock) of the last successful get_state()
  tab: 'mine',
  pushOff: false,           // notifications were on but could not be repaired (banner)
};

let api = null;
export const getApi = () => api;
const subs = new Set();
let raf = 0;
export const onUpdate = (fn) => subs.add(fn);
export function emit() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; for (const f of subs) f(); });
}

// ---------- derived ----------
export const me = () => S.gs?.me || null;
export const partner = () => S.gs?.partner || null;
export const partnerName = () => S.gs?.partner?.display_name || '夥伴';
export const isOnline = () => !S.forcedOffline && S.online && !S.netDown;
export const nameOf = (memberId) => (memberId && memberId === me()?.id ? '你' : partnerName());

function viewTasks() {
  return S.tasks
    .concat(Object.values(S.saving))
    .concat(S.queue.filter((q) => q.op === 'create').map((q) => ({ ...q.task, _queued: true })));
}
const dueMs = (t) => Date.parse(t.due_at);
function active(mine) {
  const now = serverNow(), id = me()?.id;
  return viewTasks()
    .filter((t) => (t.owner_id === id) === mine && t.status === 'active' && dueMs(t) > now)
    .sort((a, b) => dueMs(a) - dueMs(b));
}
export const myActive = () => active(true);
export const partnerActive = () => active(false);
export const queuedOp = (id) => S.queue.find((q) => q.op !== 'create' && q.taskId === id)?.op || null;
export const findTask = (id) => viewTasks().find((t) => t.id === id) || null;
export function canUndo(item) {
  const lc = S.gs?.last_confirmed_settlement;
  return !!(lc && item.type === 'settlement' && lc.id === item.id && item.status === 'confirmed'
    && lc.can_undo && serverNow() <= Date.parse(lc.undo_until));
}

// ---------- plumbing ----------
export function init(apiImpl) {
  api = apiImpl;
  addEventListener('online', () => { S.online = true; S.netDown = false; emit(); backOnline(); });
  addEventListener('offline', () => { S.online = false; emit(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.gs) return;
    try { syncBadge(S.gs.active_task_count); } catch {}
    refreshAll().catch(() => {});
    if (S.rt !== 'ok') restartRealtime();
  });
  setInterval(() => {                       // probe while the network looked dead
    if (S.gs && S.netDown && S.online && !S.forcedOffline) refreshState().catch(() => {});
    else if (S.queue.length && isOnline()) flush();
  }, 15000);
  setInterval(tick, 30000);                 // countdown labels + deadlines
}

/** Wrap a backend call: track network health, normalise errors. */
async function call(fn) {
  try {
    if (S.forcedOffline) throw new AppError('NETWORK');
    const r = await fn();
    if (S.netDown) { S.netDown = false; emit(); setTimeout(backOnline, 0); }
    return r;
  } catch (e) {
    const ae = toAppError(e);
    if (ae.code === 'NETWORK' && !S.netDown) { S.netDown = true; emit(); }
    throw ae;
  }
}

function backOnline() {
  if (!S.gs || !isOnline()) return;
  flush();
  if (S.rt !== 'ok') restartRealtime();
  refreshAll().catch(() => {});
}

export function setForcedOffline(on) {
  S.forcedOffline = !!on;
  emit();
  if (!on) backOnline();
}

function quotaWarn(e) {
  if (toAppError(e).code === 'QUOTA') toast(msg('QUOTA'), { kind: 'warn' });
}

let snapTimer;
function saveSnapSoon() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    idbSet('snap', {
      gs: S.gs, tasks: S.tasks, history: S.history.items.slice(0, PAGE),
      lastUpdated: S.lastUpdated, offset: clockOffset(),
    }).catch(quotaWarn);
  }, 400);
}
const saveQueue = () => idbSet('queue', S.queue).catch(quotaWarn);

export async function loadCache() {
  const [snap, queue] = await Promise.all([idbGet('snap'), idbGet('queue')]);
  if (Array.isArray(queue)) S.queue = queue;
  if (!snap || !snap.gs) return false;
  S.gs = snap.gs;
  S.tasks = snap.tasks || [];
  S.history.items = snap.history || [];
  S.history.loaded = S.history.items.length > 0;
  S.lastUpdated = snap.lastUpdated || null;
  setOffset(snap.offset || 0);
  setTz(S.gs.room?.timezone);
  return true;
}
export async function clearLocal() {
  S.gs = null; S.tasks = []; S.queue = []; S.history = { items: [], done: false, loading: false, loaded: false };
  await Promise.all([idbSet('snap', null), idbSet('queue', [])]).catch(() => {});
}

// ---------- reads ----------
function applyState(gs, t0, t1) {
  syncServer(gs.server_now, t0, t1);
  S.gs = gs;
  setTz(gs.room?.timezone);
  S.lastUpdated = Date.now();
  try { syncBadge(gs.active_task_count); } catch {}
  emit();
  saveSnapSoon();
}

export async function refreshState() {
  const t0 = localNow();
  const gs = await call(() => api.rpc('get_state'));
  applyState(gs, t0, localNow());
  return gs;
}

export async function refreshTasks() {
  const rows = await call(() => api.activeTasks());
  const keys = new Map(S.tasks.map((t) => [t.id, t._key]));
  S.tasks = rows.map((t) => (keys.get(t.id) ? { ...t, _key: keys.get(t.id) } : t));
  emit();
  saveSnapSoon();
  scheduleDeadline();
}

const itemKey = (it) => `${it.type}:${it.id}`;
export async function refreshHistory() {
  const items = await call(() => api.rpc('list_history', { p_before: null, p_limit: PAGE }));
  S.history.items = items || [];
  S.history.done = S.history.items.length < PAGE;
  S.history.loaded = true;
  emit();
  saveSnapSoon();
}
export async function loadMoreHistory() {
  const H = S.history;
  if (H.loading || H.done || !isOnline()) return;
  const last = H.items[H.items.length - 1];
  if (!last) return refreshHistory();
  H.loading = true; emit();
  try {
    const more = await call(() => api.rpc('list_history', { p_before: last.at, p_limit: PAGE })) || [];
    const seen = new Set(H.items.map(itemKey));
    H.items = H.items.concat(more.filter((x) => !seen.has(itemKey(x))));
    H.done = more.length < PAGE;
  } finally { H.loading = false; emit(); }
}

export async function refreshAll() {
  const jobs = [refreshState(), refreshTasks()];
  if (S.tab === 'history' || !S.history.loaded) jobs.push(refreshHistory());
  const res = await Promise.allSettled(jobs);
  const bad = res.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
}

let stateTimer;
function refreshStateSoon(ms = 80) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { refreshState().then(flushNotices, () => {}); }, ms);
}
let histTimer;
function refreshHistorySoon() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => { if (isOnline()) refreshHistory().catch(() => {}); }, 300);
}

function upsertTask(t) {
  if (!t || !t.id) return;
  const i = S.tasks.findIndex((x) => x.id === t.id);
  const gone = t.deleted_at || t.status !== 'active';
  if (i >= 0) {
    if (gone) S.tasks.splice(i, 1);
    else S.tasks[i] = { ...t, _key: t._key || S.tasks[i]._key };
  } else if (!gone) S.tasks.push(t);
  scheduleDeadline();
}
function removeTask(id) { S.tasks = S.tasks.filter((t) => t.id !== id); }
function addHistory(item) {
  const k = itemKey(item);
  const items = S.history.items.filter((x) => itemKey(x) !== k);
  items.push(item);
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  S.history.items = items;
}

// ---------- deadlines ----------
const crossed = new Set();
let deadlineTimer;
export function tick() {
  const now = serverNow();
  let any = false;
  for (const t of S.tasks) {
    if (t.status === 'active' && dueMs(t) <= now && !crossed.has(t.id)) {
      crossed.add(t.id);
      addHistory({ type: 'task', ...t, status: 'overdue', mine: t.owner_id === me()?.id, at: t.due_at });
      any = true;
    }
  }
  if (any) { refreshHistorySoon(); refreshStateSoon(400); }
  emit();
  scheduleDeadline();
}
function scheduleDeadline() {
  clearTimeout(deadlineTimer);
  const now = serverNow();
  let next = Infinity;
  for (const t of S.tasks) { const d = dueMs(t); if (t.status === 'active' && d > now && d < next) next = d; }
  if (next !== Infinity) deadlineTimer = setTimeout(tick, Math.min(next - now + 250, 30000));
}

// ---------- writes ----------
const tmpId = () => `tmp-${Math.random().toString(36).slice(2, 10)}`;
function needsOnline() { if (!isOnline()) throw new AppError('NEEDS_ONLINE'); }

async function enqueue(item) {
  item.qid = tmpId();
  S.queue.push(item);
  emit();
  await saveQueue();
  return { ok: true, queued: true };
}

export async function addTask({ title, value, dueMs: due, requiresProof }) {
  const args = { p_title: title, p_value: value, p_due_at: new Date(due).toISOString(), p_requires_proof: !!requiresProof };
  const key = tmpId();
  const temp = {
    id: key, _key: key, _tmp: true, owner_id: me().id, room_id: S.gs.room.id, title, value,
    due_at: args.p_due_at, requires_proof: !!requiresProof, status: 'active', disputed: false,
    created_at: new Date(serverNow()).toISOString(),
  };
  if (!isOnline()) return enqueue({ op: 'create', args, task: temp, taskId: key, title });
  S.saving[key] = temp;
  emit();
  try {
    const t = await call(() => api.rpc('create_task', args));
    delete S.saving[key];
    upsertTask({ ...t, _key: key });
    emit();
    refreshStateSoon();
    return { ok: true, task: t };
  } catch (e) {
    delete S.saving[key];
    if (e.code === 'NETWORK') return enqueue({ op: 'create', args, task: temp, taskId: key, title });
    emit();
    return { ok: false, error: e };
  }
}

function commitDone(t) {
  removeTask(t.id);
  delete S.retry[t.id];
  const g = S.gs;
  if (g) {
    g.total_net_me += t.value;
    g.week_net_me += t.value;
    g.done_counts.me.week += 1;
    g.done_counts.me.total += 1;
    g.active_task_count = Math.max(0, (g.active_task_count || 1) - 1);
  }
  addHistory({ type: 'task', ...t, status: 'done', mine: true, owner_slot: g?.me?.slot, at: t.completed_at });
  emit();
  refreshStateSoon();
}

/**
 * Complete a task (with an already compressed proof Blob if it needs one).
 * → { ok:true, task } | { ok:true, queued:true } | { ok:false, error, uploadFailed? }
 */
export async function completeTask(task, blob) {
  const id = task.id;
  const queueIt = async () => enqueue({
    op: 'complete', taskId: id, title: task.title, value: task.value,
    proof: blob ? await blob.arrayBuffer() : null,
  });
  if (task._tmp || !isOnline()) return queueIt();
  let path = null;
  if (task.requires_proof) {
    if (!blob) return { ok: false, error: new AppError('PROOF_REQUIRED') };
    path = `${S.gs.room.id}/${id}.jpg`;
    try {
      await call(() => api.upload(path, blob));
    } catch (e) {
      S.retry[id] = blob;   // keep the task active, offer "Retry"
      emit();
      return { ok: false, error: e.code === 'NETWORK' ? new AppError('UPLOAD_FAILED') : e, uploadFailed: true };
    }
  }
  try {
    const t = await call(() => api.rpc('complete_task', { p_task_id: id, p_proof_path: path }));
    commitDone(t);
    return { ok: true, task: t };
  } catch (e) {
    if (e.code === 'NETWORK') return queueIt();
    if (path && e.code === 'PROOF_MISSING') { S.retry[id] = blob; emit(); }
    return { ok: false, error: e };
  }
}

export async function abandonTask(task) {
  if (task._tmp) return dropQueuedCreate(task.id);
  if (!isOnline()) return enqueue({ op: 'abandon', taskId: task.id, title: task.title });
  try {
    const t = await call(() => api.rpc('abandon_task', { p_task_id: task.id }));
    removeTask(t.id);
    addHistory({ type: 'task', ...t, status: 'abandoned', mine: true, at: t.abandoned_at });
    emit(); refreshStateSoon();
    return { ok: true };
  } catch (e) {
    if (e.code === 'NETWORK') return enqueue({ op: 'abandon', taskId: task.id, title: task.title });
    return { ok: false, error: e };
  }
}

async function dropQueuedCreate(tempId) {
  S.queue = S.queue.filter((q) => q.taskId !== tempId);
  emit();
  await saveQueue();
  return { ok: true };
}

export async function deleteTask(task) {
  if (task._tmp) return dropQueuedCreate(task.id);
  needsOnline();
  await call(() => api.rpc('delete_task', { p_task_id: task.id }));
  removeTask(task.id);
  emit(); refreshStateSoon();
}

export async function disputeTask(item, flag) {
  const apply = (queued) => {
    item.disputed = flag;
    const h = S.history.items.find((x) => x.type === 'task' && x.id === item.id);
    if (h) { h.disputed = flag; h._queued = queued; }
    emit();
  };
  if (!isOnline()) { apply(true); return enqueue({ op: 'dispute', taskId: item.id, flag, title: item.title }); }
  try {
    await call(() => api.rpc('dispute_task', { p_task_id: item.id, p_disputed: flag }));
    apply(false);
    return { ok: true };
  } catch (e) {
    if (e.code === 'NETWORK') { apply(true); return enqueue({ op: 'dispute', taskId: item.id, flag, title: item.title }); }
    return { ok: false, error: e };
  }
}

export async function proposeSettlement() {
  needsOnline();
  await call(() => api.rpc('propose_settlement'));
  await refreshState();
}
export async function respondSettlement(id, accept) {
  needsOnline();
  await call(() => api.rpc('respond_settlement', { p_id: id, p_accept: accept }));
  await refreshState();
  refreshHistorySoon();
}
export async function undoSettlement(id) {
  needsOnline();
  await call(() => api.rpc('undo_settlement', { p_id: id }));
  await refreshState();
  refreshHistorySoon();
}
export async function updateSettings(name, time) {
  needsOnline();
  const t0 = localNow();
  const gs = await call(() => api.rpc('update_settings', { p_display_name: name ?? null, p_daily_reminder_time: time ?? null }));
  applyState(gs, t0, localNow());
}

// ---------- queue flush ----------
let flushing = false;
export async function flush() {
  if (flushing || !S.queue.length || !isOnline() || !S.gs) return;
  flushing = true;
  let sent = 0;
  try {
    while (S.queue.length && isOnline()) {
      const it = S.queue[0];
      try {
        await runOp(it);
      } catch (e) {
        const ae = toAppError(e);
        if (ae.code === 'NETWORK') break;   // keep it, try again later
        reportQueued(it, ae);
      }
      S.queue.shift();
      sent++;
      emit();
      await saveQueue();
    }
  } finally {
    flushing = false;
  }
  if (sent) { refreshState().catch(() => {}); refreshTasks().catch(() => {}); refreshHistorySoon(); }
}

async function runOp(it) {
  if (it.op === 'create') {
    const t = await call(() => api.rpc('create_task', it.args));
    upsertTask({ ...t, _key: it.taskId });
    for (const q of S.queue) if (q.taskId === it.taskId && q !== it) q.taskId = t.id;   // later ops follow the real id
    return;
  }
  const id = it.taskId;
  if (String(id).startsWith('tmp-')) return;   // its create was refused; nothing to send
  if (it.op === 'complete') {
    let path = null;
    if (it.proof) {
      path = `${S.gs.room.id}/${id}.jpg`;
      try {
        await call(() => api.upload(path, new Blob([it.proof], { type: 'image/jpeg' })));
      } catch (e) {
        if (e.code !== 'NETWORK') S.retry[id] = new Blob([it.proof], { type: 'image/jpeg' });
        throw e.code === 'NETWORK' ? e : new AppError('UPLOAD_FAILED');
      }
    }
    const t = await call(() => api.rpc('complete_task', { p_task_id: id, p_proof_path: path }));
    commitDone(t);
    toast(`已送出：「${t.title}」完成 +NT$ ${t.value}`, { kind: 'good' });
  } else if (it.op === 'abandon') {
    const t = await call(() => api.rpc('abandon_task', { p_task_id: id }));
    removeTask(id);
    addHistory({ type: 'task', ...t, status: 'abandoned', mine: true, at: t.abandoned_at });
  } else if (it.op === 'dispute') {
    await call(() => api.rpc('dispute_task', { p_task_id: id, p_disputed: it.flag }));
    const h = S.history.items.find((x) => x.type === 'task' && x.id === id);
    if (h) h._queued = false;
  }
}

function reportQueued(it, e) {
  const what = `「${it.title || '任務'}」`;
  if (it.op === 'complete' && e.code === 'TASK_OVERDUE') {
    toast(`${what}太晚了——伺服器時間顯示期限已經過了。`, { kind: 'warn', ms: 7000 });
  } else {
    toast(`${what}沒有送出：${msg(e.code)}`, { kind: 'warn', ms: 7000 });
  }
  if (it.op === 'dispute') {
    const h = S.history.items.find((x) => x.type === 'task' && x.id === it.taskId);
    if (h) { h.disputed = !it.flag; h._queued = false; }
  }
}

// ---------- realtime ----------
let closeCh = null, rtGen = 0, rtAttempt = 0, rtTimer = null;
const notices = [];
const seenNotice = new Set();

export function startRealtime() {
  if (!S.gs?.room?.id) return;
  stopRealtime();
  const gen = rtGen;
  S.rt = 'connecting';
  emit();
  closeCh = api.openChannel(S.gs.room.id, onRealtime, (status) => {
    if (gen !== rtGen) return;   // events from a channel we already replaced
    if (status === 'SUBSCRIBED') {
      const reconnected = rtAttempt > 0;
      rtAttempt = 0;
      S.rt = 'ok';
      emit();
      if (reconnected) { refreshAll().catch(() => {}); flush(); }
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      S.rt = 'down';
      emit();
      if (!rtTimer) {
        const d = RT_DELAYS[Math.min(rtAttempt, RT_DELAYS.length - 1)];
        rtAttempt++;
        rtTimer = setTimeout(() => { rtTimer = null; startRealtime(); }, d);
      }
    }
  });
}
function stopRealtime() {
  rtGen++;
  if (closeCh) { try { closeCh(); } catch {} closeCh = null; }
}
function restartRealtime() {
  clearTimeout(rtTimer); rtTimer = null;
  rtAttempt = Math.max(rtAttempt, 1);   // treat as a reconnect → refetch on success
  startRealtime();
}

function notice(key, item) {
  if (seenNotice.has(key)) return;
  seenNotice.add(key);
  notices.push(item);
}

function onRealtime(table, p) {
  const n = p.new && Object.keys(p.new).length ? p.new : null;
  const myId = me()?.id;
  const fresh = (ts) => ts && serverNow() - Date.parse(ts) < 120000;
  if (table === 'tasks' && n) {
    // a create of ours echoing back before the RPC returned: keep the same row
    const tmp = Object.values(S.saving).find((s) => s.owner_id === n.owner_id && s.title === n.title && s.due_at && Date.parse(s.due_at) === Date.parse(n.due_at));
    if (tmp) { delete S.saving[tmp._key]; n._key = tmp._key; }
    upsertTask(n);
    if (n.owner_id !== myId && n.status === 'done' && !n.deleted_at && fresh(n.completed_at)) {
      notice(`done:${n.id}`, { kind: 'done', value: n.value, title: n.title, key: `partner_done|partner_done:${n.id}` });
    }
    if (n.owner_id === myId && n.disputed && fresh(n.disputed_at)) {
      notice(`dispute:${n.id}:${n.disputed_at}`, { kind: 'dispute', title: n.title, key: `partner_dispute|partner_dispute:${n.id}` });
    }
    if (n.status !== 'active' || n.deleted_at) {
      const h = S.history.items.find((x) => x.type === 'task' && x.id === n.id);
      if (h) h.disputed = n.disputed;
    }
  } else if (table === 'settlements' && n) {
    if (n.status === 'pending' && n.proposed_by !== myId) notice(`s:${n.id}:p`, { kind: 's-request', key: `settlement_request|settlement:${n.id}` });
    if (n.status === 'confirmed' && n.proposed_by === myId) notice(`s:${n.id}:c`, { kind: 's-ok', key: `settlement_result|settlement:${n.id}` });
    if (n.status === 'rejected' && n.responded_by && n.responded_by !== myId) notice(`s:${n.id}:r`, { kind: 's-no', key: `settlement_result|settlement:${n.id}` });
    if (n.status === 'undone') notice(`s:${n.id}:u`, { kind: 's-undo', key: `settlement_result|settlement:${n.id}` });
  } else if (table === 'members') {
    refreshTasks().catch(() => {});
  }
  emit();
  refreshStateSoon(40);
  if (S.tab === 'history' || table === 'settlements') refreshHistorySoon();
}

function flushNotices() {
  const g = S.gs;
  if (!g) return;
  const pn = partnerName();
  for (const it of notices.splice(0)) {
    if (it.kind === 'done') {
      const n = g.total_net_me;
      const tail = n < 0 ? `你落後 NT$ ${-n}` : n > 0 ? `你還領先 NT$ ${n}` : '現在平手';
      toastOnce(it.key, `${pn} 剛完成 +${it.value} — ${tail}`, { kind: n < 0 ? 'warn' : '' });
    } else if (it.kind === 'dispute') toastOnce(it.key, `${pn} 質疑了「${it.title}」`, { kind: 'warn' });
    else if (it.kind === 's-request') toastOnce(it.key, `${pn} 想把總差距歸零，到首頁回應吧`);
    else if (it.kind === 's-ok') toastOnce(it.key, '已結清！總差距歸零 🎉', { kind: 'good' });
    else if (it.kind === 's-no') toastOnce(it.key, `${pn} 暫時不想結算`);
    else if (it.kind === 's-undo') toastOnce(it.key, '上一次結清已撤銷');
  }
}
