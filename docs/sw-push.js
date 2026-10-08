// 賭讀 / StudyBet — push handling inside the service worker (Part C).
// Loaded by sw.js via importScripts('./sw-push.js').
//
// Every push ends in exactly one visible result:
//   * a focused, visible app window → message to the page, which shows an in-app toast
//   * otherwise                     → a system notification
// Never a silent push: iOS revokes subscriptions that receive pushes without
// showing anything.

// If iOS ever revokes subscriptions during testing because of the in-app-only
// path, set this to false (and bump CACHE_VERSION). That is the only change needed:
// every push then shows a system notification, even with the app in front.
const SUPPRESS_WHEN_FOCUSED = true;

const SCOPE = self.registration.scope;
const abs = (p) => new URL(p, SCOPE).href;

// --- tiny IndexedDB record of the last push, for the ?debug=1 page ---
function recordPush(data) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('studybet-push', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try {
          const t = r.result.transaction('kv', 'readwrite');
          t.objectStore('kv').put({ at: Date.now(), kind: data.kind || null, title: data.title || null }, 'lastPush');
          t.oncomplete = t.onerror = () => resolve();
        } catch { resolve(); }
      };
      r.onerror = () => resolve();
    } catch { resolve(); }
  });
}

async function setBadge(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return;
  try {
    if (n > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
  } catch { /* badging not allowed or unsupported */ }
}

async function handlePush(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || '賭讀';
  const body = data.body || '';
  const tag = data.tag || `${data.kind || 'msg'}:${data.task_id || data.settlement_id || Date.now()}`;
  const url = data.url || './';

  await Promise.all([recordPush(data), setBadge(data.badge)]);

  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const focused = wins.find((c) => c.visibilityState === 'visible' && c.focused);
  if (SUPPRESS_WHEN_FOCUSED && focused) {
    focused.postMessage({ type: 'studybet-push', payload: { ...data, title, body, tag }, shown: false });
    return;
  }
  // Open-but-unfocused windows just refresh their data.
  for (const c of wins) c.postMessage({ type: 'studybet-push', payload: { ...data, title, body, tag }, shown: true });
  await self.registration.showNotification(title, {
    body,
    tag,                       // repeats of the same kind + task collapse into one
    renotify: false,
    icon: abs('./icons/icon-192.png'),
    badge: abs('./icons/badge-96.png'),
    lang: 'zh-TW',
    data: { url, kind: data.kind || null },
  });
}

self.addEventListener('push', (event) => { event.waitUntil(handlePush(event)); });

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = abs((event.notification.data && event.notification.data.url) || './');
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((c) => c.url.startsWith(SCOPE));
    if (same) {
      await same.focus().catch(() => {});
      same.postMessage({ type: 'studybet-open', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// iOS does not fire this today; when a browser does, the next app open re-subscribes
// (push.js repairPush), because the worker has no signed-in session to save with.
self.addEventListener('pushsubscriptionchange', () => {});
