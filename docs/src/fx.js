// Feel: Web Audio sounds, iOS haptic tick, confetti, floating "+NT$", number count-up.
import { h, reducedMotion } from './dom.js';

// ---------- sound ----------
let ctx = null;
const soundKey = 'studybet.sound';
export const soundOn = () => { try { return localStorage.getItem(soundKey) !== 'off'; } catch { return true; } };
export const setSound = (on) => { try { localStorage.setItem(soundKey, on ? 'on' : 'off'); } catch {} };

/** iOS only lets audio start inside a user gesture: unlock on the first tap. */
export function installAudioUnlock() {
  const unlock = () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx ||= new AC();
      if (ctx.state === 'suspended') ctx.resume();
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch {}
  };
  for (const ev of ['pointerdown', 'touchend']) document.addEventListener(ev, unlock, { once: true, capture: true, passive: true });
}

function tone(freq, start, dur, peak, type = 'sine') {
  const t0 = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
/** Two rising tones, ~250 ms, peak gain 0.18. */
export function playComplete() {
  if (!soundOn() || !ctx) return;
  try { if (ctx.state === 'suspended') ctx.resume(); tone(784, 0, 0.12, 0.18, 'triangle'); tone(1175, 0.11, 0.14, 0.18, 'triangle'); } catch {}
}
/** One soft low tone. */
export function playWarn() {
  if (!soundOn() || !ctx) return;
  try { tone(220, 0, 0.22, 0.1, 'sine'); } catch {}
}

// ---------- haptics (iOS 17.4+: clicking the label of an <input switch> ticks) ----------
const hapticOK = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;
export function haptic() {
  if (!hapticOK) return;
  try { document.getElementById('haptic')?.click(); } catch {}
}

// ---------- visual ----------
export function squish(el) {
  if (reducedMotion()) return;
  el.classList.remove('squish'); void el.offsetWidth; el.classList.add('squish');
  setTimeout(() => el.classList.remove('squish'), 140);
}

export function floatGain(anchor, text) {
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'float-gain num', style: `left:${r.left + r.width / 2}px;top:${r.top - 8}px` }, text);
  if (reducedMotion()) el.style.animation = 'fadeOut .2s forwards';
  document.body.append(el);
  setTimeout(() => el.remove(), 900);
}

const COLORS = ['#58CC02', '#FF9600', '#1CB0F6', '#FFC800', '#CE82FF'];
/** ≤ 30 particles, ≤ 1.2 s, canvas only. */
export function confetti(anchor) {
  if (reducedMotion()) return;
  const r = anchor.getBoundingClientRect();
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = h('canvas', { id: 'confetti' });
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.append(c);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const ps = Array.from({ length: 28 }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const v = 260 + Math.random() * 300;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, s: 5 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, c: COLORS[(Math.random() * COLORS.length) | 0] };
  });
  const DUR = 1100;
  let start = 0, last = 0;
  const step = (t) => {
    if (!start) { start = last = t; }
    const dt = Math.min(0.033, (t - last) / 1000); last = t;
    const life = (t - start) / DUR;
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (life >= 1) { c.remove(); return; }
    g.globalAlpha = life > 0.7 ? (1 - life) / 0.3 : 1;
    for (const p of ps) {
      p.vy += 900 * dt; p.vx *= 0.985;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.66);
      g.restore();
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Count el's text from `from` to `to` over 600 ms (fade instead with reduced motion). */
export function countTo(el, from, to, format = String, ms = 600) {
  cancelAnimationFrame(el._raf);
  if (reducedMotion() || from === to) {
    el.textContent = format(to);
    if (from !== to) { el.classList.remove('fade-swap'); void el.offsetWidth; el.classList.add('fade-swap'); }
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(Math.round(from + (to - from) * e));
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
