// 賭讀 / StudyBet — install & permission onboarding (Part C).
// showOnboarding(): Safari tab → 5-step "add to Home Screen" guide, rendered into #app.
// showPermissionStep(root, { onDone }): in the installed app, after pairing.
// deniedGuide(): how to re-enable notifications in iOS Settings.
import { h, svg } from './src/dom.js';
import { enablePush, getPushStatus, iosTooOld, iosVersion, isIOS, isOtherIOSBrowser } from './push.js';

const SEEN = 'studybet.onboardSeen';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// Phone outline shared by all five pictures (viewBox 0 0 200 260).
const PHONE = '<rect x="40" y="6" width="120" height="248" rx="22" fill="#F7F7F7" stroke="#3C3C3C" stroke-width="5"/><rect x="82" y="14" width="36" height="8" rx="4" fill="#3C3C3C"/>';
const S = (inner) => `<svg viewBox="0 0 200 260" width="200" height="260" role="img" xmlns="http://www.w3.org/2000/svg" font-family="ui-rounded,system-ui,sans-serif">${PHONE}${inner}</svg>`;

export const STEP_SVGS = [
  // 1 Safari: compass + address bar
  S('<rect x="52" y="34" width="96" height="20" rx="10" fill="#fff" stroke="#AFAFAF" stroke-width="2"/><text x="100" y="48" font-size="10" text-anchor="middle" fill="#777">github.io</text>'
    + '<circle cx="100" cy="130" r="38" fill="#1CB0F6"/><circle cx="100" cy="130" r="31" fill="#fff"/><path d="M100 102l9 28-9 28-9-28z" fill="#FF9600"/><path d="M100 130l9 0-9 28-9-28z" fill="#AFAFAF"/>'
    + '<text x="100" y="196" font-size="15" font-weight="800" text-anchor="middle" fill="#3C3C3C">Safari</text>'),
  // 2 Share button, bottom centre, highlighted
  S('<rect x="52" y="34" width="96" height="150" rx="10" fill="#fff"/><rect x="62" y="48" width="60" height="10" rx="5" fill="#D7FFB8"/><rect x="62" y="66" width="76" height="8" rx="4" fill="#E5E5E5"/><rect x="62" y="82" width="70" height="8" rx="4" fill="#E5E5E5"/>'
    + '<rect x="44" y="200" width="112" height="44" fill="#fff"/><circle cx="100" cy="222" r="20" fill="none" stroke="#FF9600" stroke-width="4"><animate attributeName="r" values="18;22;18" dur="1.4s" repeatCount="indefinite"/></circle>'
    + '<path d="M92 218v12h16v-12" fill="none" stroke="#1CB0F6" stroke-width="3" stroke-linejoin="round"/><path d="M100 224v-16m-5 5l5-5 5 5" fill="none" stroke="#1CB0F6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="66" cy="222" r="4" fill="#AFAFAF"/><circle cx="134" cy="222" r="4" fill="#AFAFAF"/>'),
  // 3 Share sheet → 加入主畫面
  S('<rect x="46" y="92" width="108" height="152" rx="14" fill="#fff"/><rect x="58" y="104" width="84" height="22" rx="8" fill="#F7F7F7"/><rect x="58" y="132" width="84" height="22" rx="8" fill="#F7F7F7"/>'
    + '<rect x="54" y="162" width="92" height="30" rx="10" fill="#DDF4FF" stroke="#1CB0F6" stroke-width="3"/><rect x="62" y="169" width="16" height="16" rx="4" fill="none" stroke="#3C3C3C" stroke-width="2"/><path d="M70 172v10m-5-5h10" stroke="#3C3C3C" stroke-width="2"/>'
    + '<text x="84" y="182" font-size="11" font-weight="800" fill="#3C3C3C">加入主畫面</text><rect x="58" y="200" width="84" height="22" rx="8" fill="#F7F7F7"/><path d="M150 186l-12-4 4 12z" fill="#FF9600"/>'),
  // 4 Confirm: web-app toggle on, 新增 highlighted
  S('<rect x="52" y="34" width="96" height="112" rx="12" fill="#fff"/><text x="62" y="54" font-size="10" fill="#1CB0F6">取消</text><text x="118" y="54" font-size="11" font-weight="800" fill="#1CB0F6">新增</text>'
    + '<rect x="112" y="41" width="32" height="18" rx="9" fill="none" stroke="#FF9600" stroke-width="3"/><rect x="62" y="66" width="26" height="26" rx="7" fill="#58CC02"/><text x="96" y="84" font-size="12" font-weight="800" fill="#3C3C3C">賭讀</text>'
    + '<text x="62" y="118" font-size="8.5" fill="#3C3C3C">以網頁 App 形式開啟</text><rect x="114" y="126" width="28" height="16" rx="8" fill="#58CC02"/><circle cx="134" cy="134" r="6" fill="#fff"/>'),
  // 5 Home screen icon + bell
  S('<g fill="#E5E5E5"><rect x="58" y="40" width="22" height="22" rx="6"/><rect x="89" y="40" width="22" height="22" rx="6"/><rect x="120" y="40" width="22" height="22" rx="6"/><rect x="58" y="78" width="22" height="22" rx="6"/><rect x="120" y="78" width="22" height="22" rx="6"/></g>'
    + '<rect x="86" y="75" width="28" height="28" rx="8" fill="#58CC02"/><rect x="82" y="71" width="36" height="36" rx="11" fill="none" stroke="#FF9600" stroke-width="3"/><path d="M93 84q7-3 7 1v12q0-4-7-1zM107 84q-7-3-7 1v12q0-4 7-1z" fill="#fff"/>'
    + '<text x="100" y="118" font-size="9" font-weight="800" text-anchor="middle" fill="#3C3C3C">賭讀</text>'
    + '<path d="M100 150a18 18 0 0 1 18 18v14l6 8H76l6-8v-14a18 18 0 0 1 18-18z" fill="#FFC800"/><circle cx="100" cy="196" r="5" fill="#FFC800"/><circle cx="120" cy="152" r="8" fill="#FF9600"/><text x="120" y="156" font-size="10" font-weight="800" text-anchor="middle" fill="#fff">1</text>'),
];

const STEPS = [
  { title: '用 Safari 打開這個網頁', caption: '只有 Safari 能把賭讀加到主畫面。' },
  { title: '點下方中間的「分享」', caption: '就是那個方框加上箭頭的按鈕。' },
  { title: '往下滑，點「加入主畫面」', caption: '在分享選單的清單裡，可能要往下捲。' },
  { title: '確認後點「新增」', caption: '「以網頁 App 形式開啟」要保持開啟（綠色）。' },
  { title: '從主畫面打開賭讀', caption: '配對完成後，點「開啟通知」就能收到提醒。' },
];

export function showOnboarding() {
  const root = document.getElementById('app');
  if (!root) return;
  const seen = ls.get(SEEN) === '1';
  let index = seen ? 4 : 0;

  const notes = [];
  if (iosTooOld()) {
    notes.push(h('div', { class: 'msg warn' },
      h('b', null, `請先更新 iOS（目前 ${iosVersion().join('.')}）`), h('br'),
      '通知需要 iOS 16.4 以上。到「設定 › 一般 › 軟體更新」更新後再回來。'));
  }
  if (isOtherIOSBrowser()) {
    notes.push(h('div', { class: 'msg warn' }, '你現在不是在 Safari 裡。Chrome 和 LINE / Facebook / IG 內建的瀏覽器都無法安裝。請複製網址，改用 Safari 打開。',
      copyButton()));
  } else if (!isIOS()) {
    notes.push(h('div', { class: 'msg info' }, '賭讀是為 iPhone 設計的。請在 iPhone 上用 Safari 打開這個網址：', copyButton()));
  }
  if (seen) notes.push(h('div', { class: 'msg info' }, '已經加到主畫面了嗎？請從主畫面的「賭讀」圖示打開。通知只能在那裡開啟。'));

  const track = h('div', { class: 'ob-track' });
  const dots = h('div', { class: 'ob-dots', 'aria-hidden': 'true' });
  STEPS.forEach((s, i) => {
    track.append(h('section', { class: `ob-slide${i === 4 ? ' ob-key' : ''}`, 'aria-label': `第 ${i + 1} 步，共 5 步` },
      h('div', { class: 'ob-card' },
        h('div', { class: 'ob-step' }, `${i + 1} / 5`),
        svg(STEP_SVGS[i]),
        h('h2', null, s.title),
        h('p', { class: 'ob-cap' }, s.caption))));
    dots.append(h('span'));
  });
  const back = h('button', { class: 'btn ghost', onclick: () => go(index - 1) }, '上一步');
  const next = h('button', { class: 'btn', onclick: () => go(index + 1) }, '下一步');

  function paint() {
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === index));
    back.disabled = index === 0;
    next.disabled = index === STEPS.length - 1;
    if (index === STEPS.length - 1) ls.set(SEEN, '1');
  }
  function go(i, smooth = true) {
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    paint();
  }
  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== index) { index = i; paint(); }
    });
  }, { passive: true });

  root.replaceChildren(h('div', { class: 'screen ob' },
    h('h1', null, '賭讀', h('small', null, 'StudyBet')),
    h('p', null, '先把賭讀加到主畫面，才能收到提醒和對方的進度。'),
    ...notes, track, dots,
    h('div', { class: 'row-btns ob-nav' }, back, next)));
  requestAnimationFrame(() => go(index, false));
  paint();
}

function copyButton() {
  const b = h('button', { class: 'btn ghost small', style: 'margin-top:8px;display:flex', onclick: async () => {
    try { await navigator.clipboard.writeText(location.href.split('?')[0]); b.textContent = '已複製 ✓'; }
    catch { b.textContent = location.href.split('?')[0]; }
  } }, '複製網址');
  return b;
}

// ---------- permission step (installed app, right after pairing) ----------
const BELL = '<svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true"><circle cx="60" cy="60" r="56" fill="#FFF0D6"/><path d="M60 26a22 22 0 0 1 22 22v18l8 10H30l8-10V48a22 22 0 0 1 22-22z" fill="#FFC800"/><circle cx="60" cy="84" r="7" fill="#FFC800"/><circle cx="84" cy="32" r="12" fill="#FF9600"/><text x="84" y="37" font-size="14" font-weight="800" text-anchor="middle" fill="#fff" font-family="ui-rounded,system-ui">1</text></svg>';

/** Shows the "開啟通知" step if notifications are still undecided; calls onDone() when finished or skipped. */
export async function showPermissionStep(root, { onDone }) {
  const status = await getPushStatus().catch(() => 'unsupported');
  if (status !== 'default') { onDone(); return; }
  const msg = h('div', { hidden: true });
  const go = h('button', { class: 'btn block', onclick: () => {
    go.disabled = true;
    enablePush().then((s) => {   // called inside the tap (iOS permission rule)
      if (s === 'subscribed') { onDone(); return; }
      go.disabled = false;
      msg.hidden = false;
      msg.replaceChildren(s === 'denied' ? deniedGuide() : h('p', { class: 'msg warn' }, '沒有開啟通知。之後可以在「設定」再開。'));
    }, () => {
      go.disabled = false;
      msg.hidden = false;
      msg.replaceChildren(h('p', { class: 'msg warn' }, '開啟通知失敗，請檢查網路後再試一次。'));
    });
  } }, '🔔 開啟通知');
  root.replaceChildren(h('div', { class: 'screen center-msg' },
    svg(BELL),
    h('h1', null, '開啟通知'),
    h('p', null, '截止前 1 小時和 15 分鐘提醒你；對方完成任務、想結算時也會通知你。'),
    go, msg,
    h('div', { style: 'height:8px' }),
    h('button', { class: 'link', onclick: onDone }, '稍後再說')));
}

// ---------- re-enable guide ----------
const SETTINGS_SVG = '<svg viewBox="0 0 260 150" width="260" height="150" role="img" aria-label="設定 › 通知 › 賭讀 › 允許通知" font-family="ui-rounded,system-ui,sans-serif">'
  + '<rect x="2" y="2" width="256" height="146" rx="16" fill="#F7F7F7" stroke="#E5E5E5" stroke-width="2"/>'
  + '<rect x="14" y="14" width="232" height="34" rx="10" fill="#fff"/><rect x="22" y="21" width="20" height="20" rx="5" fill="#AFAFAF"/><text x="50" y="36" font-size="13" font-weight="700" fill="#3C3C3C">設定 › 通知</text>'
  + '<rect x="14" y="58" width="232" height="34" rx="10" fill="#fff" stroke="#1CB0F6" stroke-width="3"/><rect x="22" y="65" width="20" height="20" rx="5" fill="#58CC02"/><text x="50" y="80" font-size="13" font-weight="800" fill="#3C3C3C">賭讀</text><text x="232" y="80" font-size="13" fill="#AFAFAF" text-anchor="end">›</text>'
  + '<rect x="14" y="102" width="232" height="34" rx="10" fill="#fff"/><text x="24" y="124" font-size="13" font-weight="700" fill="#3C3C3C">允許通知</text><rect x="196" y="109" width="40" height="22" rx="11" fill="#58CC02"/><circle cx="225" cy="120" r="9" fill="#fff"/></svg>';

export function deniedGuide() {
  return h('div', { class: 'msg warn denied-guide' },
    h('b', null, '通知被關掉了'),
    h('p', { style: 'margin:6px 0' }, '到 iPhone 的「設定 › 通知 › 賭讀」，打開「允許通知」，再回到賭讀。'),
    svg(SETTINGS_SVG));
}
