// ?debug=1 (or tap the version in Settings 5 times): push diagnostics.
import { h, toast } from './dom.js';
import { debugInfo, repairPush, showLocalTest, enablePush } from '../push.js';
import { fmtWhen } from './time.js';
import { APP_VERSION } from './version.js';

const when = (ms) => (ms ? `${fmtWhen(ms, Date.now())}（${Math.round((Date.now() - ms) / 60000)} 分鐘前）` : '—');
const STATUS = { subscribed: '已訂閱 ✅', default: '尚未開啟', denied: '被拒絕', 'needs-install': '需先加到主畫面', unsupported: '不支援 / 未設定 VAPID' };

export async function showDebug(root, { onClose }) {
  const box = h('div');
  const screen = h('div', { class: 'screen dbg' },
    h('h1', null, '推播診斷', h('small', null, `賭讀 v${APP_VERSION}`)),
    box,
    h('div', { class: 'row-btns', style: 'margin-top:16px' },
      h('button', { class: 'btn ghost', onclick: () => draw() }, '重新整理'),
      h('button', { class: 'btn', onclick: onClose }, '回到 App')));
  root.replaceChildren(screen);

  async function draw() {
    const d = await debugInfo();
    const secretHint = '<FUNCTION_SECRET>';
    const ps = `$secret = "${secretHint}"\nInvoke-RestMethod -Method Post `
      + '-Uri "https://rqlgldutexfozaatpypd.supabase.co/functions/v1/send-push" '
      + '-Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" '
      + `-Body '{"action":"send_test_push","member_id":"${d.memberId || '<member id>'}"}'`;
    box.replaceChildren(
      h('dl', null,
        h('dt', null, '狀態'), h('dd', null, STATUS[d.status] || d.status),
        h('dt', null, '通知權限'), h('dd', null, d.permission),
        h('dt', null, '主畫面模式'), h('dd', null, d.standalone ? '是' : '否（Safari 分頁）'),
        h('dt', null, 'iOS'), h('dd', null, d.ios),
        h('dt', null, 'VAPID 金鑰'), h('dd', null, d.vapid ? '已設定' : '未設定（config.js）'),
        h('dt', null, '訂閱'), h('dd', null, d.endpointHash ? `${d.endpointHash}… @ ${d.endpointHost}` : '—'),
        h('dt', null, '已存到伺服器'), h('dd', null, d.savedMatches == null ? '—' : d.savedMatches ? '是' : '否（下次開啟會自動修復）'),
        h('dt', null, '最後收到推播'), h('dd', null, d.lastPush ? `${when(d.lastPush.at)} ${d.lastPush.kind || ''}` : '—'),
        h('dt', null, '徽章數字'), h('dd', null, Number.isFinite(d.badge) ? String(d.badge) : '—'),
        h('dt', null, '離線佇列'), h('dd', null, String(d.queue)),
        h('dt', null, '會員 ID'), h('dd', null, d.memberId || '—')),
      d.pushOff ? h('p', { class: 'msg warn' }, '通知已關閉：自動修復失敗。按「重新訂閱」。') : '',   // replaceChildren would print false
      h('div', { class: 'row-btns', style: 'margin-top:12px' },
        h('button', { class: 'btn blue small', onclick: () => {
          // Inside the tap: asks for permission first if needed.
          (d.permission === 'granted' ? repairPush() : enablePush()).then(() => { toast('已重新檢查訂閱'); draw(); }, () => toast('訂閱失敗', { kind: 'warn' }));
        } }, '重新訂閱'),
        h('button', { class: 'btn ghost small', onclick: () => showLocalTest().then(() => toast('已送出本機通知（App 在前景時可能不顯示橫幅）'), () => toast('無法顯示通知', { kind: 'warn' })) }, '本機測試通知'),
        d.memberId && h('button', { class: 'btn ghost small', onclick: () => navigator.clipboard.writeText(d.memberId).then(() => toast('已複製會員 ID'), () => {}) }, '複製會員 ID')),
      h('p', { style: 'margin-top:16px;font-weight:700' }, '從電腦送一則測試推播（PowerShell，詳見 README-push.md）：'),
      h('pre', null, ps),
      h('p', null, '提示：送出後把 App 關到背景或鎖定螢幕，才會看到系統通知；App 在前景時會顯示 App 內提示。'));
  }
  await draw();
}
