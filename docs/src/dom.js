// Tiny DOM helpers.
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : String(k));
  }
  return el;
}
/** Static SVG markup (constants only, never user data). */
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Keyed list update: reuses rows whose signature is unchanged, animates enter/leave. */
export function reconcile(box, items, animate) {
  const old = new Map();
  for (const el of [...box.children]) {
    if (el.dataset.key && !el.classList.contains('leave')) old.set(el.dataset.key, el);
    else if (!el.dataset.key) el.remove();
  }
  let prev = null;
  const keep = new Set();
  for (const it of items) {
    let el = old.get(it.key);
    if (el && el.dataset.sig !== it.sig) {
      const n = it.render();
      n.dataset.key = it.key; n.dataset.sig = it.sig;
      el.replaceWith(n); el = n;
    } else if (!el) {
      el = it.render();
      el.dataset.key = it.key; el.dataset.sig = it.sig;
      if (animate && it.enter !== false) el.classList.add('enter');
    }
    keep.add(it.key);
    const ref = prev ? prev.nextSibling : box.firstChild;
    if (el !== ref) box.insertBefore(el, ref);
    prev = el;
  }
  for (const [k, el] of old) {
    if (keep.has(k)) continue;
    if (animate && el.classList.contains('row')) {
      el.classList.add('leave');
      const done = () => el.remove();
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 600);
    } else el.remove();
  }
}

let toastBox;
/** toast(text, { kind: 'warn'|'good', action: { label, fn }, ms }) */
export function toast(text, opts = {}) {
  toastBox ||= document.getElementById('toasts');
  if (!toastBox) return;
  while (toastBox.children.length >= 3) toastBox.firstChild.remove();
  const el = h('div', { class: `toast ${opts.kind || ''}`, role: 'status' });
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.append(h('span', { class: 't-msg' }, text));
  if (opts.action) el.append(h('button', { onclick: () => { close(); opts.action.fn(); } }, opts.action.label));
  toastBox.append(el);
  setTimeout(close, opts.ms || (opts.action ? 6000 : 3800));
}
