// 賭讀 / StudyBet — Web Push and app-icon badge (Part C).
// Exports used by the app (contract): enablePush(), getPushStatus(), syncBadge(n)
// Extra exports: initPush(), repairPush(), environment helpers, debugInfo().
import { getApi, S, emit, refreshAll } from './src/store.js';
import { toastOnce } from './src/dom.js';
import { toAppError } from './src/errors.js';

const KEY_EP = 'studybet.pushEndpoint';
const KEY_BADGE = 'studybet.badge';
const KEY_LAST = 'studybet.lastPushSeen';
const cfg = () => window.STUDYBET_CONFIG || {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch {} },
};

// ---------- environment ----------
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
/** [major, minor] on iPhone/iPad, else null. iPadOS reports a Mac UA, recognised by touch support. */
export function iosVersion() {
  const ua = navigator.userAgent;
  const m = /(?:iPhone|iPad|iPod)[^)]*? OS (\d+)_(\d+)/.exec(ua);
  if (m) return [+m[1], +m[2]];
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
    const v = /Version\/(\d+)\.(\d+)/.exec(ua);
    return v ? [+v[1], +v[2]] : [16, 4];
  }
  return null;
}
export const isIOS = () => !!iosVersion();
export const iosTooOld = () => { const v = iosVersion(); return !!v && (v[0] < 16 || (v[0] === 16 && v[1] < 4)); };
/** Chrome / Firefox / Edge for iOS and in-app browsers (LINE, Facebook, Instagram, WeChat) cannot add web apps. */
export const isOtherIOSBrowser = () => isIOS() && /CriOS|FxiOS|EdgiOS|OPiOS|Line\/|FBAN|FBAV|Instagram|MicroMessenger|GSA\//.test(navigator.userAgent);
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const ready = () => withTimeout(navigator.serviceWorker.ready, 6000);

function sameKey(sub) {
  try {
    const have = new Uint8Array(sub.options.applicationServerKey);
    const want = urlB64ToBytes(cfg().VAPID_PUBLIC_KEY);
    return have.length === want.length && have.every((b, i) => b === want[i]);
  } catch { return true; }   // cannot tell: keep it
}

// ---------- status ----------
/** 'unsupported' | 'needs-install' | 'default' | 'denied' | 'subscribed' */
export async function getPushStatus() {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!supported() || !cfg().VAPID_PUBLIC_KEY || iosTooOld()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted') {
    const sub = await ready().then((r) => r.pushManager.getSubscription()).catch(() => null);
    if (sub) return 'subscribed';
  }
  return 'default';
}

// ---------- subscribe ----------
async function save(sub) {
  const j = sub.toJSON();
  await getApi().rpc('save_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
    p_user_agent: navigator.userAgent.slice(0, 300),
  });
  store.set(KEY_EP, j.endpoint);
}
async function subscribe(reg) {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(cfg().VAPID_PUBLIC_KEY) });
}

/**
 * Turn notifications on. MUST be called directly from a tap handler:
 * Notification.requestPermission() is the first await, as iOS requires.
 * Resolves to the new status.
 */
export async function enablePush() {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!supported() || !cfg().VAPID_PUBLIC_KEY || iosTooOld()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'default';
  const reg = await ready();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  sub ||= await subscribe(reg);
  await save(sub);
  setPushOff(false);
  return 'subscribed';
}

function setPushOff(on) {
  if (S.pushOff === on) return;
  S.pushOff = on;
  emit();
}

/**
 * On every app open: if permission is granted, make sure this phone has a live
 * subscription that the server knows about and has not disabled (410 → disabled).
 * Silent; shows the "通知已關閉" banner only when the repair itself fails.
 */
export async function repairPush() {
  try {
    if (!supported() || !cfg().VAPID_PUBLIC_KEY || Notification.permission !== 'granted') return;
    if (isIOS() && !isStandalone()) return;
    const api = getApi();
    if (!api || !S.gs || api.mode === 'mock') return;
    const reg = await ready();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    let needSave = !sub || sub.endpoint !== store.get(KEY_EP);
    if (sub && !needSave) {
      const rows = await api.pushRows(sub.endpoint);   // only this member's own rows are visible
      if (!rows.length) needSave = true;               // missing, or saved under an older (reclaimed) member id
      else if (rows[0].disabled_at) {                  // push service said 404/410: this endpoint is dead
        await sub.unsubscribe().catch(() => {});
        sub = null;
        needSave = true;
      }
    }
    if (needSave) {
      sub ||= await subscribe(reg);
      await save(sub);
    }
    setPushOff(false);
  } catch (e) {
    if (toAppError(e).code === 'NETWORK') return;   // try again next open
    console.warn('[push] repair failed', e);
    setPushOff(true);
  }
}

// ---------- badge ----------
/** App icon badge = my active, non-overdue tasks. Called after every get_state() and on visibilitychange. */
export function syncBadge(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  store.set(KEY_BADGE, v);
  try {
    if (v > 0 && navigator.setAppBadge) navigator.setAppBadge(v).catch(() => {});
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch {}
}

// ---------- messages from sw-push.js ----------
let onOpenUrl = null;
/** Call once at startup. openUrl(url) handles notification taps while the app is open. */
export function initPush({ openUrl } = {}) {
  onOpenUrl = openUrl || null;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'studybet-push') {
      const p = d.payload || {};
      store.set(KEY_LAST, Date.now());
      // Foreground: the worker showed no banner, so the page must show something.
      // Realtime may already have toasted the same event; toastOnce keeps it to one.
      if (!d.shown) toastOnce(`${p.kind}|${p.tag}`, p.body ? `${p.title} — ${p.body}` : p.title, { kind: p.kind === 'due_15m' || p.kind === 'overdue' ? 'warn' : '' });
      if (S.gs) refreshAll().catch(() => {});
    } else if (d.type === 'studybet-open' && onOpenUrl) {
      onOpenUrl(d.url);
    }
  });
}

// ---------- ?debug=1 ----------
async function sha256Short(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function lastPushFromWorker() {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('studybet-push', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('kv').objectStore('kv').get('lastPush');
          q.onsuccess = () => resolve(q.result || null);
          q.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
export async function debugInfo() {
  const sub = supported() ? await ready().then((r) => r.pushManager.getSubscription()).catch(() => null) : null;
  const api = getApi();
  return {
    status: await getPushStatus(),
    permission: 'Notification' in window ? Notification.permission : 'n/a',
    standalone: isStandalone(),
    ios: iosVersion()?.join('.') || '—',
    vapid: !!cfg().VAPID_PUBLIC_KEY,
    endpointHash: sub ? await sha256Short(sub.endpoint) : null,
    endpointHost: sub ? new URL(sub.endpoint).host : null,
    savedMatches: sub ? sub.endpoint === store.get(KEY_EP) : null,
    lastPush: await lastPushFromWorker(),
    lastPushSeenByPage: Number(store.get(KEY_LAST)) || null,
    badge: Number(store.get(KEY_BADGE) ?? NaN),
    queue: S.queue.length,
    memberId: api?.memberId ? await api.memberId().catch(() => null) : null,
    pushOff: S.pushOff,
  };
}
/** Local check that notifications can be displayed at all (no server involved). */
export async function showLocalTest() {
  const reg = await ready();
  await reg.showNotification('賭讀 本機測試', { body: '這則通知由手機自己產生，沒有經過伺服器', tag: 'local-test', icon: './icons/icon-192.png' });
}
export const subscriptionPresent = async () => !!(supported() && await ready().then((r) => r.pushManager.getSubscription()).catch(() => null));
