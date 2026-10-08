// Notification copy (zh-TW). The single source of the texts users see.
// The backend's outbox payload still carries its own title/body; send-push
// replaces them with these, worded from the recipient's point of view at send
// time. Kinds/results not covered by the table (settlement rejected / expired /
// undone) keep the backend's text. Limits: title ≤ 24, body ≤ 60 characters.

export interface Ctx {
  outbox_id: number;
  kind: string;
  payload: Record<string, unknown>;
  recipient_id: string;
  me_name: string | null;
  partner_name: string | null;
  total_net_me: number;
  badge: number;
  next_title: string | null;
  task_title: string | null;
  task_value: number | null;
}

export const TITLE_MAX = 24;
export const BODY_MAX = 60;

const chars = (s: string) => [...s];
export const len = (s: string) => chars(s).length;
export function cut(s: string, n: number): string {
  const c = chars(s);
  return c.length <= n ? s : c.slice(0, Math.max(1, n - 1)).join('') + '…';
}
/** prefix「title」suffix, shortening only the task title so the whole line fits. */
function quoted(prefix: string, title: string, suffix: string, max = BODY_MAX): string {
  const room = max - len(prefix) - len(suffix) - 2;
  return `${prefix}「${cut(title, Math.max(4, room))}」${suffix}`;
}

export function render(ctx: Ctx): { title: string; body: string } {
  const p = ctx.payload ?? {};
  const N = ctx.partner_name ?? '對方';
  const t = ctx.task_title;
  const v = ctx.task_value;
  const gap = Math.abs(ctx.total_net_me ?? 0);
  const fallback = { title: String(p.title ?? '賭讀'), body: String(p.body ?? '') };
  let out = fallback;

  switch (ctx.kind) {
    case 'due_1h':
      if (t != null && v != null) out = { title: '賭讀 ⏰ 還剩 1 小時', body: quoted('', t, `NT$ ${v}，快去完成！`) };
      break;
    case 'due_15m':
      if (t != null && v != null) out = { title: '賭讀 🔥 只剩 15 分鐘', body: quoted('', t, `NT$ ${v} 快到期了`) };
      break;
    case 'partner_done':
      if (v != null) {
        const n = ctx.total_net_me ?? 0;
        out = {
          title: `${N} 剛完成 +${v}`,
          body: n < 0 ? `你現在落後 NT$ ${gap}，輪到你了` : n > 0 ? `你領先 NT$ ${gap}` : '平手',
        };
      }
      break;
    case 'partner_dispute':
      if (t != null) out = { title: `${N} 質疑了你的證明`, body: quoted('', t, '的照片需要再確認') };
      break;
    case 'overdue':
      if (t != null) out = { title: '賭讀 任務已逾期', body: quoted('', t, '已逾期，不影響分數') };
      break;
    case 'daily':
      out = ctx.badge > 0
        ? { title: `賭讀 📚 今天還有 ${ctx.badge} 件事沒做`, body: ctx.next_title ? quoted('最近到期：', ctx.next_title, '') : '打開賭讀看看吧' }
        : { title: '賭讀 📚 今天的任務都完成了', body: '好樣的！明天繼續' };
      break;
    case 'settlement_request':
      out = { title: `${N} 想結算`, body: `同意後總計歸零，目前 NT$ ${gap}` };
      break;
    case 'settlement_result':
      if (p.result === 'confirmed') out = { title: `${N} 已同意結算`, body: '總計已歸零，可在歷史撤銷' };
      break;
  }
  return { title: cut(out.title, TITLE_MAX), body: cut(out.body, BODY_MAX) };
}

/** Test push (send-push {"action":"send_test_push"}). */
export const TEST_COPY = { title: '賭讀 測試通知', body: '看到這則通知，代表推播設定成功 ✅' };
