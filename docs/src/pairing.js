// Pairing: create a room (name + code) or join one (name + code, "I'm back" slot reclaim).
// BAD_CODE means "wrong code OR room full" (CONTRACT A1), so "I'm back" is always offered.
import { h } from './dom.js';
import { errText, toAppError, AppError } from './errors.js';
import * as fx from './fx.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o, 1/l/i
export function generateCode() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

let tsScript = null;
function loadTurnstile() {
  tsScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { tsScript = null; reject(new AppError('NETWORK')); };
    document.head.append(s);
  });
  return tsScript;
}

export async function showPairing(root, { api, cfg, mock, onPaired }) {
  const siteKey = (cfg && cfg.TURNSTILE_SITE_KEY) || '';
  let mode = 'create';
  let token = null, widget = null;
  const needCaptcha = !!siteKey && !(await api.hasSession());

  const msgBox = h('div', { class: 'msg warn', role: 'alert', hidden: true });
  const say = (text, kind = 'warn') => { msgBox.className = `msg ${kind}`; msgBox.textContent = text; msgBox.hidden = !text; };

  const nameIn = () => h('input', { class: 'input', maxlength: '6', placeholder: '例如：小明', autocomplete: 'nickname', 'aria-label': '你的名字' });
  const codeIn = (ph) => h('input', { class: 'input', maxlength: '64', placeholder: ph, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': '配對碼' });

  // create form
  const cName = nameIn();
  const cCode = codeIn('至少 8 個字元');
  const genBtn = h('button', { class: 'btn ghost small', type: 'button', onclick: () => { cCode.value = generateCode(); } }, '產生');
  const cBtn = h('button', { class: 'btn block', type: 'submit' }, '建立房間');
  const createForm = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('label', { class: 'field' }, h('span', null, '你的名字（1–6 字）'), cName),
    h('label', { class: 'field' }, h('span', null, '配對碼'), h('div', { class: 'input-row' }, cCode, genBtn),
      h('small', null, '建議按「產生」取得 12 個隨機字元，再私下傳給對方。知道配對碼的人就能進房間。')),
    cBtn);

  // join form
  const jName = nameIn();
  const jCode = codeIn('對方給你的配對碼');
  let slot = null;
  const slotBtns = [1, 2].map((s) => h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => pickSlot(s) },
    s === 1 ? '1 號（建立房間的人）' : '2 號（加入的人）'));
  const back = h('div', { class: 'field', hidden: true },
    h('span', null, '我回來了：我之前是…'),
    h('div', { class: 'slot-pick' }, ...slotBtns),
    h('small', null, '換手機或清除了 Safari 資料時用。選回你原本的位置，紀錄會跟著你。'));
  const backLink = h('button', { class: 'link', type: 'button', onclick: () => { back.hidden = !back.hidden; if (back.hidden) pickSlot(null); } }, '我回來了（以前在這個房間）');
  const jBtn = h('button', { class: 'btn block', type: 'submit' }, '加入房間');
  const joinForm = h('form', { hidden: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('label', { class: 'field' }, h('span', null, '你的名字（1–6 字）'), jName),
    h('label', { class: 'field' }, h('span', null, '配對碼'), jCode),
    backLink, back, jBtn);
  function pickSlot(s) {
    slot = s;
    slotBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(s === i + 1)));
    jBtn.textContent = s ? `以 ${s} 號回到房間` : '加入房間';
  }

  const segC = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => setMode('create') }, '建立房間');
  const segJ = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setMode('join') }, '加入房間');
  function setMode(m) {
    mode = m;
    segC.setAttribute('aria-pressed', String(m === 'create'));
    segJ.setAttribute('aria-pressed', String(m === 'join'));
    createForm.hidden = m !== 'create';
    joinForm.hidden = m !== 'join';
    say('');
  }

  const tsBox = h('div', { id: 'turnstile', hidden: !needCaptcha });

  root.replaceChildren(h('div', { class: 'screen' },
    h('h1', null, '賭讀', h('small', null, 'StudyBet')),
    h('p', null, '和讀書夥伴互相下注：完成任務就賺分數，首頁永遠先告訴你誰領先。', mock ? '（mock 模式：加入請用配對碼 studybet-demo）' : ''),
    h('div', { class: 'seg' }, segC, segJ),
    msgBox, createForm, joinForm, tsBox));

  if (needCaptcha) {
    loadTurnstile().then((ts) => {
      widget = ts.render(tsBox, {
        sitekey: siteKey, language: 'zh-tw',
        callback: (t) => { token = t; },
        'expired-callback': () => { token = null; },
        'error-callback': () => { token = null; },
      });
    }, () => say(errText(new AppError('NETWORK'))));
  }

  let busy = false;
  async function submit() {
    if (busy) return;
    say('');
    const create = mode === 'create';
    const name = (create ? cName : jName).value.trim();
    const code = (create ? cCode : jCode).value.trim();
    if (name.length < 1 || name.length > 6) { say(errText(new AppError('BAD_NAME'))); fx.playWarn(); return; }
    if (code.length < 8) { say(errText(new AppError(create ? 'CODE_TOO_SHORT' : 'BAD_CODE'))); fx.playWarn(); return; }
    if (back.hidden === false && !create && !slot) { say(errText(new AppError('BAD_SLOT'))); return; }
    busy = true;
    const btn = create ? cBtn : jBtn;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '連線中…';
    try {
      if (!(await api.hasSession())) {
        if (siteKey && !token) throw new AppError('CAPTCHA_NEEDED');
        try { await api.signIn(token || undefined); }
        finally { token = null; if (widget != null) try { window.turnstile.reset(widget); } catch {} }
        tsBox.hidden = true;
      }
      if (create) {
        await api.rpc('create_room', { p_code: code, p_display_name: name });
        fx.haptic(); fx.playComplete();
        showCreated(root, code, onPaired);
      } else {
        await api.rpc('join_room', { p_code: code, p_display_name: name, p_slot: slot });
        fx.haptic(); fx.playComplete();
        onPaired();
      }
    } catch (e) {
      const ae = toAppError(e);
      fx.playWarn();
      say(errText(ae));
      if (ae.code === 'BAD_CODE' && !create) back.hidden = false;
      if (ae.code === 'CODE_TAKEN') cCode.select?.();
      if (ae.code === 'CAPTCHA' || ae.code === 'CAPTCHA_NEEDED') tsBox.hidden = false;
      if (ae.code === 'ALREADY_IN_ROOM') { onPaired(); return; }
    } finally {
      busy = false;
      btn.disabled = false; btn.textContent = label;
    }
  }
}

function showCreated(root, code, onPaired) {
  const copyBtn = h('button', { class: 'btn ghost block', onclick: async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = '已複製 ✓'; }
    catch { copyBtn.textContent = '請長按上面的配對碼複製'; }
  } }, '複製配對碼');
  root.replaceChildren(h('div', { class: 'screen center-msg' },
    h('div', { class: 'big' }, '🎉'),
    h('h1', null, '房間建立好了！'),
    h('p', null, '把這組配對碼私下傳給你的讀書夥伴，對方在「加入房間」輸入即可。'),
    h('p', { style: 'font-size:22px;font-weight:800;color:var(--text);-webkit-user-select:all;user-select:all;word-break:break-all' }, code),
    copyBtn,
    h('div', { style: 'height:12px' }),
    h('button', { class: 'btn block', onclick: onPaired }, '開始使用')));
}
