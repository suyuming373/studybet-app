// =====================================================================
// PART C REPLACES THIS FILE
// Stub for push notifications. Keeps the interface the app depends on and
// does nothing, safely.
//
// Contract (CONTRACT.md, "Frontend module contract"):
//   enablePush()   called directly inside a tap handler (Settings → 開啟通知),
//                  so iOS may show the permission prompt. May return a Promise.
//   getPushStatus() → 'granted' | 'denied' | 'default' | 'unsupported' | 'unavailable'
//                  (or a Promise of one). Shown as text in Settings.
//   syncBadge(n)   called after every get_state() with active_task_count.
// =====================================================================

export async function enablePush() {
  return { ok: false, reason: 'unavailable' };
}

export function getPushStatus() {
  return 'unavailable';
}

export function syncBadge(n) { // eslint-disable-line no-unused-vars
  // no-op until Part C
}
