// Full-screen proof photo viewer: pinch / double-tap zoom (1x–4x), pan, swipe down to close.
// A fresh 60 s signed URL is fetched on every open and every 重新載入; URLs are never stored.
import { h, reducedMotion } from './dom.js';
import { getApi, isOnline } from './store.js';

const MIN_S = 1, MAX_S = 4, TAP_MS = 300, TAP_PX = 24, CLOSE_PX = 110;
let active = null;
export const viewerOpen = () => !!active;

/**
 * openProofViewer(task, { badge: () => text|'' , dispute: { label: () => text, run: () => Promise } | null, returnFocus })
 * `badge` and `dispute.label` are re-read after every dispute so the viewer and the sheet stay in sync.
 */
export function openProofViewer(t, { badge, dispute = null, returnFocus = null } = {}) {
  active?.close(true);
  const prevFocus = returnFocus || document.activeElement;

  const closeBtn = h('button', { class: 'pv-btn', 'aria-label': '關閉照片', onclick: () => api.close() }, '✕');
  const badgeEl = h('span', { class: 'tag orange soft pv-badge' });
  const img = h('img', { class: 'pv-img', alt: `「${t.title}」的證明照片`, draggable: 'false', decoding: 'async', hidden: true });
  const spinner = h('div', { class: 'pv-status', role: 'status' }, h('span', { class: 'pv-spin', 'aria-hidden': 'true' }), h('span', null, '載入照片中…'));
  const errText = h('p', null, '照片載入失敗，請重試');
  const retryBtn = h('button', { class: 'btn ghost', onclick: () => load() }, '重新載入');
  const errBox = h('div', { class: 'pv-status pv-error', role: 'alert', hidden: true }, errText, retryBtn);
  const stage = h('div', { class: 'pv-stage' }, img, spinner, errBox);
  const dispBtn = dispute && h('button', { class: 'btn orange pv-dispute', onclick: async () => {
    dispBtn.disabled = true;
    try { await dispute.run(); } finally { dispBtn.disabled = false; sync(); }
  } });
  const box = h('div', { class: 'pv', role: 'dialog', 'aria-modal': 'true', 'aria-label': `證明照片：${t.title}` },
    h('div', { class: 'pv-top' }, badgeEl, h('span', { class: 'pv-title' }, t.title), closeBtn),
    stage,
    dispBtn && h('div', { class: 'pv-bottom' }, dispBtn));

  function sync() {
    const b = badge?.() || '';
    badgeEl.textContent = b; badgeEl.hidden = !b;
    if (dispBtn) dispBtn.textContent = dispute.label();
  }

  // ---------- loading ----------
  let token = 0;
  async function load() {
    const my = ++token;
    reset(false);
    img.hidden = true; errBox.hidden = true; spinner.hidden = false;
    img.removeAttribute('src');
    const fail = (text) => {
      if (my !== token || active !== api) return;
      spinner.hidden = true; errText.textContent = text; errBox.hidden = false;
    };
    if (!isOnline()) { fail('離線中，連線後才能看照片'); return; }
    let url;
    try { url = await getApi().signedUrl(t.proof_path); } catch { fail('照片載入失敗，請重試'); return; }
    if (my !== token || active !== api) return;
    img.onload = () => { if (my === token) { spinner.hidden = true; img.hidden = false; } };
    img.onerror = () => fail('照片載入失敗，請重試');   // also what an expired signed URL looks like
    img.src = url;
  }

  // ---------- zoom / pan ----------
  let s = 1, tx = 0, ty = 0, dragY = 0;
  const apply = (anim) => {
    img.classList.toggle('pv-anim', !!anim && !reducedMotion());
    img.style.transform = `translate3d(${tx}px, ${ty + dragY}px, 0) scale(${s})`;
    box.style.setProperty('--pv-fade', String(Math.max(0.25, 1 - Math.abs(dragY) / 400)));
    box.classList.toggle('zoomed', s > 1.01);
  };
  const clampPan = () => {
    const r = stage.getBoundingClientRect();
    const mx = Math.max(0, (img.offsetWidth * s - r.width) / 2);
    const my = Math.max(0, (img.offsetHeight * s - r.height) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  };
  /** Zoom to `ns` keeping the stage point (px, py) — relative to the stage centre — still. */
  const zoomAt = (ns, px, py) => {
    ns = Math.min(MAX_S, Math.max(MIN_S, ns));
    tx = px - (px - tx) * (ns / s);
    ty = py - (py - ty) * (ns / s);
    s = ns;
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
    clampPan();
  };
  function reset(anim) { s = 1; tx = 0; ty = 0; dragY = 0; apply(anim); }
  const rel = (x, y) => { const r = stage.getBoundingClientRect(); return [x - r.left - r.width / 2, y - r.top - r.height / 2]; };

  const pts = new Map();
  let g = null;          // current gesture
  let lastTap = null;    // { t, x, y } for double-tap
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const mid = () => { const [a, b] = [...pts.values()]; return [(a.x + b.x) / 2, (a.y + b.y) / 2]; };
  const onImg = (x, y) => {
    if (img.hidden) return false;
    const r = img.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && !img.hidden) {
      const [mx, my] = rel(...mid());
      g = { kind: 'pinch', d0: dist(), s0: s, mx, my, tx0: tx, ty0: ty };
      dragY = 0;
    } else if (pts.size === 1) {
      g = { kind: 'one', x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty, moved: false, t0: performance.now(), onImg: onImg(e.clientX, e.clientY) };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.kind === 'pinch' && pts.size >= 2) {
      const [mx, my] = rel(...mid());
      const ns = Math.min(MAX_S, Math.max(MIN_S, g.s0 * dist() / g.d0));
      // zoom about the pinch start point, then follow the fingers' midpoint
      s = g.s0; tx = g.tx0; ty = g.ty0;
      zoomAt(ns, g.mx, g.my);
      tx += mx - g.mx; ty += my - g.my;
      clampPan(); apply(false);
    } else if (g.kind === 'one') {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
      if (!g.moved) return;
      if (s > 1) { tx = g.tx0 + dx; ty = g.ty0 + dy; clampPan(); }
      else if (!img.hidden) dragY = Math.max(0, dy);   // swipe down to close
      apply(false);
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size === 1) {   // one finger left: continue as a pan without a jump
        const [p] = [...pts.values()];
        g = { kind: 'one', x0: p.x, y0: p.y, tx0: tx, ty0: ty, moved: true, t0: 0, onImg: true };
      } else { g = null; if (s < 1.05) reset(true); }
      return;
    }
    if (pts.size) return;
    const cur = g; g = null;
    if (e.type === 'pointercancel') { dragY = 0; apply(true); return; }
    if (cur.moved) {
      const fast = dragY > 40 && dragY / Math.max(1, performance.now() - cur.t0) > 0.6;
      if (s <= 1 && (dragY > CLOSE_PX || fast)) { api.close(); return; }
      dragY = 0; apply(true);
      return;
    }
    // a tap: double-tap on the photo toggles 1x / 2x, a tap beside it closes
    const now = performance.now();
    if (cur.onImg) {
      if (lastTap && now - lastTap.t < TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < TAP_PX) {
        lastTap = null;
        if (s > 1) reset(true);
        else { zoomAt(2, ...rel(e.clientX, e.clientY)); apply(true); }
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    } else if (s <= 1) api.close();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    if (img.hidden) return;
    e.preventDefault();
    zoomAt(s * Math.exp(-e.deltaY / 300), ...rel(e.clientX, e.clientY)); apply(false);
  }, { passive: false });
  // iOS Safari: keep the page itself from scrolling, rubber-banding or zooming under the viewer.
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };
  box.addEventListener('touchmove', stop, { passive: false });
  box.addEventListener('gesturestart', stop);
  box.addEventListener('gesturechange', stop);
  box.addEventListener('dblclick', stop);

  // ---------- keyboard: Esc closes, Tab stays inside ----------
  const onKey = (e) => {
    if (document.querySelector('.dialog')) return;   // a confirm dialog on top handles itself
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); api.close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button')].filter((b) => !b.disabled && !b.hidden && b.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  };
  const onFocusIn = (e) => {
    if (!box.contains(e.target) && !e.target.closest?.('.dialog')) closeBtn.focus();
  };

  // ---------- open / close ----------
  const root = document.documentElement;
  const scrollY = window.scrollY;
  const api = {
    box,
    close(instant) {
      if (active !== api) return;
      active = null; token++;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      root.classList.remove('pv-lock');
      document.body.style.top = '';
      window.scrollTo(0, scrollY);
      const done = () => box.remove();
      if (instant || reducedMotion()) done();
      else { box.classList.add('closing'); setTimeout(done, 180); }
      if (prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
    },
  };
  document.body.style.top = `-${scrollY}px`;
  root.classList.add('pv-lock');
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn);
  document.body.append(box);
  active = api;
  sync();
  apply(false);
  closeBtn.focus({ preventScroll: true });
  load();
  return api;
}
export const closeProofViewer = () => active?.close();
