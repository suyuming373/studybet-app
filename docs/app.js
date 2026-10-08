// 賭讀 / StudyBet — entry point.
// Boot order: config check → install gate → cached paint → session → live data.
//   ?mock=1  in-memory backend + test hooks on window.__studybet (no Supabase needed)
//   ?mock=1&pair=1  same, starting at the pairing screen
//   ?mock=1&batch2=1  same, with the batch 2 backend fields (每日提醒 toggle in 設定)
//   ?dev=1   real backend without the "add to Home Screen" gate (desktop preview)
//   ?debug=1 push diagnostics page (also: tap the version in Settings 5 times)
import { h, toast } from './src/dom.js';
import { openDb, idbClear } from './src/idb.js';
import * as store from './src/store.js';
import { S } from './src/store.js';
import { toAppError, errText } from './src/errors.js';
import { installAudioUnlock } from './src/fx.js';
import { setSkew, advanceVirtual, serverNow } from './src/clock.js';
import { endOfDay } from './src/time.js';
import { initPush, repairPush } from './push.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const DEV = params.has('dev');
const DEBUG = params.has('debug');
let booted = false;
let homeMounted = false;

// ---------- error boundary: never a blank screen ----------
function crash(err) {
  console.error('[studybet] crash', err);
  try {
    root.replaceChildren(h('div', { class: 'screen center-msg' },
      h('div', { class: 'big' }, '😵'),
      h('h1', null, '出了點問題'),
      h('p', null, '畫面沒辦法顯示。重新載入通常就能解決；你的紀錄都還在伺服器上。'),
      h('button', { class: 'btn block', onclick: () => location.reload() }, '重新載入')));
  } catch {
    root.innerHTML = '<p style="padding:24px">出了點問題。<button onclick="location.reload()">重新載入</button></p>';
  }
}
addEventListener('error', (e) => { if (!booted || !root.firstElementChild) crash(e.error || e.message); });
addEventListener('unhandledrejection', (e) => {
  console.warn('[studybet] unhandled', e.reason);
  if (!booted) crash(e.reason);
});

const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('[studybet] sw', e));
  // Only an update replaces an existing controller; the very first install does not need a reload.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !booted || !hadController) return;
    toast('新版本已就緒', { action: { label: '重新整理', fn: () => { reloaded = true; location.reload(); } } });
  });
}

function showSetup(cfg) {
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter((k) => !cfg[k]);
  root.replaceChildren(h('div', { class: 'screen' },
    h('h1', null, '賭讀', h('small', null, 'StudyBet')),
    h('h2', null, '還差一步：填寫 config.js'),
    h('p', null, '這個 App 還不知道要連到哪個 Supabase 專案。請打開 config.js，填入下列值，再重新發布：'),
    h('ol', null, ...missing.map((k) => h('li', null, h('code', null, k), k === 'SUPABASE_URL'
      ? '：Supabase › Project Settings › Data API › Project URL'
      : '：Supabase › Project Settings › API Keys › anon / public key'))),
    h('p', null, '詳細步驟在 README-frontend.md 的「填寫 config.js」。'),
    h('p', null, '只是想先看看畫面？在網址後面加上 ', h('code', null, '?mock=1'), '。'),
    h('button', { class: 'btn block', onclick: () => location.reload() }, '我填好了，重新載入')));
}

async function showInstallGate() {
  // Minimal fallback first, so the screen is never blank; Part C's onboarding replaces #app.
  root.replaceChildren(h('div', { class: 'screen center-msg' },
    h('div', { class: 'big' }, '📲'),
    h('h1', null, '賭讀', h('small', null, 'StudyBet')),
    h('p', null, '請先把賭讀加到主畫面：在 Safari 點「分享」→「加入主畫面」，再從主畫面的圖示打開。')));
  const { showOnboarding } = await import('./onboarding.js');
  showOnboarding();
}

function showOfflineEmpty() {
  root.replaceChildren(h('div', { class: 'screen center-msg' },
    h('div', { class: 'big' }, '📡'),
    h('h1', null, '目前離線'),
    h('p', null, '第一次開啟需要網路。連上 Wi-Fi 或行動網路後再試一次。'),
    h('button', { class: 'btn block', onclick: () => location.reload() }, '重試')));
}

async function mountHome() {
  if (homeMounted) return;
  const { mountHome: mount } = await import('./src/home.js');
  mount(root, { onCrash: crash, mock: MOCK });
  homeMounted = true;
}

async function goPairing(api, cfg) {
  homeMounted = false;
  await store.clearLocal();
  const { showPairing } = await import('./src/pairing.js');
  await showPairing(root, {
    api, cfg, mock: MOCK,
    onPaired: async () => {
      // Installed app: ask for notifications right after pairing (skipped unless still undecided).
      const { showPermissionStep } = await import('./onboarding.js');
      await showPermissionStep(root, { onDone: () => startLive(api, cfg) });
    },
  });
}

async function startLive(api, cfg) {
  try {
    await store.refreshAll();
  } catch (e) {
    const code = toAppError(e).code;
    if (code === 'NOT_IN_ROOM' || code === 'NOT_AUTHENTICATED') return goPairing(api, cfg);
    if (code === 'NETWORK') { if (S.gs) { await mountHome(); return; } return showOfflineEmpty(); }
    if (!S.gs) throw e;
    toast(errText(e), { kind: 'warn' });
  }
  await mountHome();
  store.startRealtime();
  store.flush();
  repairPush();   // silent: re-subscribe if the subscription is missing, changed or disabled (410)
}

async function showDebugPage(api, cfg) {
  const { showDebug } = await import('./src/debug.js');
  await showDebug(root, {
    onClose: () => {
      try { history.replaceState(null, '', location.pathname); } catch {}
      homeMounted = false;
      startLive(api, cfg).catch(crash);
    },
  });
}

async function boot() {
  const cfg = window.STUDYBET_CONFIG || {};
  registerSW();
  if (!MOCK && (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY)) { showSetup(cfg); booted = true; return; }
  if (!MOCK && !DEV && !DEBUG && !isStandalone()) { await showInstallGate(); booted = true; return; }

  installAudioUnlock();
  openDb(MOCK ? 'studybet-mock' : 'studybet');
  if (MOCK) await idbClear();   // the mock starts fresh on every load

  // Repeat visits: paint the last snapshot immediately, before any network.
  const cached = await store.loadCache().catch(() => false);
  if (cached) await mountHome();

  let api;
  if (MOCK) {
    const { createMockApi } = await import('./src/mock.js');
    api = createMockApi({ pair: params.has('pair'), batch2: params.has('batch2') });
    exposeTestHooks(api);
  } else {
    const { createApi } = await import('./src/api-supabase.js');
    try { api = await createApi(cfg); }
    catch (e) { if (cached) { booted = true; S.netDown = true; store.emit(); return; } throw e; }
  }
  store.init(api);
  initPush({ openUrl: openFromNotification });
  booted = true;

  let session = false;
  try { session = await api.hasSession(); } catch {}
  if (!session) { await goPairing(api, cfg); return; }
  if (DEBUG) { await store.refreshState().catch(() => {}); await showDebugPage(api, cfg); return; }
  await startLive(api, cfg);
}

/** A notification was tapped while the app was already open. */
async function openFromNotification(url) {
  if (!homeMounted) return;
  const { showTab } = await import('./src/home.js');
  showTab(String(url).includes('#history') ? 'history' : 'mine');
  store.refreshAll().catch(() => {});
}

function exposeTestHooks(api) {
  const hk = api.hooks;
  const sync = () => { store.tick(); store.refreshState().catch(() => {}); };
  window.__studybet = {
    get state() { return S; },
    server: api.db,
    /** Simulate the phone's clock being wrong by `ms`; countdowns must stay correct. */
    setClockOffset(ms) { setSkew(ms); sync(); },
    /** Move time forward (phone and mock server together). */
    advance(minutes) { advanceVirtual(minutes * 6e4); sync(); },
    async completeTask(id) { const { triggerComplete } = await import('./src/home.js'); return triggerComplete(id); },
    /** obj: { title, value, due_at (ISO) | due_in_minutes, requires_proof } */
    addTask(obj = {}) {
      return store.addTask({
        title: obj.title || '測試任務', value: obj.value ?? 20,
        dueMs: obj.due_in_minutes != null ? serverNow() + obj.due_in_minutes * 6e4
          : obj.due_at ? Date.parse(obj.due_at) : endOfDay(1),
        requiresProof: !!obj.requires_proof,
      });
    },
    simulatePartnerComplete(value = 20) { return hk.partnerComplete(value); },
    simulateOffline(on = true) { hk.setOffline(on); store.setForcedOffline(on); },
    simulateRealtimeDrop() { hk.dropRealtime(); },
    // extras for the settlement flow
    simulatePartnerProposeSettlement() { return hk.partnerPropose(); },
    simulatePartnerRespond(accept = true) { return hk.partnerRespond(accept); },
  };
  console.info('[studybet] mock mode — try window.__studybet.simulatePartnerComplete(20)');
}

boot().catch(crash);
