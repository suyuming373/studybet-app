// Delivery core shared by send-push and tick.
// Everything that touches the database goes through `Store`, and the push
// service through `Sender`, so both can be faked in tests (test/push_test.ts).
import webpush from 'npm:web-push@3.6.7';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { render, TEST_COPY, type Ctx } from './copy.ts';

export interface OutboxRow { id: number; recipient_id: string; kind: string; payload: Record<string, unknown>; attempts: number }
export interface Sub { id: string; endpoint: string; p256dh: string; auth: string }

export interface Store {
  claim(id: number | null, limit?: number): Promise<OutboxRow[]>;
  context(outboxId: number): Promise<Ctx | null>;
  finish(outboxId: number, ok: boolean, error?: string | null): Promise<void>;
  subscriptions(memberId: string): Promise<Sub[]>;
  markDisabled(subId: string): Promise<void>;
  markSuccess(subId: string): Promise<void>;
  badge(memberId: string): Promise<number>;
  // tick only
  claimDue(): Promise<number>;
  listExpiredProofs(): Promise<{ task_id: string; proof_path: string }[]>;
  removeProofFiles(paths: string[]): Promise<void>;          // throws when the Storage API refuses
  markProofsExpired(taskIds: string[]): Promise<number>;
  nightlyCleanup(): Promise<unknown>;
}

/** Sends one encrypted push; returns the push service's HTTP status. */
export type Sender = (sub: Sub, payload: string, ttl: number, urgency: 'high' | 'normal') => Promise<number>;

// ---------------------------------------------------------------- real store
export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseStore(sb: SupabaseClient = adminClient()): Store {
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  return {
    async claim(id, limit = 25) {
      return must(await sb.rpc('claim_outbox', { p_id: id, p_limit: limit }), 'claim_outbox') ?? [];
    },
    async context(outboxId) {
      return must(await sb.rpc('push_context', { p_outbox_id: outboxId }), 'push_context');
    },
    async finish(outboxId, ok, error = null) {
      must(await sb.rpc('finish_outbox', { p_id: outboxId, p_ok: ok, p_error: error }), 'finish_outbox');
    },
    async subscriptions(memberId) {
      return must(await sb.from('push_subscriptions').select('id, endpoint, p256dh, auth')
        .eq('member_id', memberId).is('disabled_at', null), 'push_subscriptions') ?? [];
    },
    async markDisabled(subId) {
      must(await sb.from('push_subscriptions').update({ disabled_at: new Date().toISOString() }).eq('id', subId), 'disable');
    },
    async markSuccess(subId) {
      must(await sb.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).eq('id', subId), 'last_success');
    },
    async badge(memberId) {
      return must(await sb.rpc('badge_count', { p_member: memberId }), 'badge_count') ?? 0;
    },
    async claimDue() {
      return must(await sb.rpc('claim_due_notifications'), 'claim_due_notifications') ?? 0;   // no arguments (A3)
    },
    async listExpiredProofs() {
      return must(await sb.rpc('list_expired_proofs'), 'list_expired_proofs') ?? [];
    },
    async removeProofFiles(paths) {
      const { error } = await sb.storage.from('proofs').remove(paths);
      if (error) throw new Error(`storage remove: ${error.message}`);
    },
    async markProofsExpired(taskIds) {
      return must(await sb.rpc('mark_proofs_expired', { p_task_ids: taskIds }), 'mark_proofs_expired') ?? 0;
    },
    async nightlyCleanup() {
      return must(await sb.rpc('nightly_cleanup'), 'nightly_cleanup');
    },
  };
}

// ---------------------------------------------------------------- real sender
let vapidReady = false;
function setupVapid() {
  if (vapidReady) return;
  const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT') ?? '';
  if (!pub || !priv || !subject) throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT secret missing');
  webpush.setVapidDetails(subject, pub, priv);
  vapidReady = true;
}

/** web-push only builds the encrypted request (RFC 8291 + VAPID); fetch sends it. */
export const webPushSender: Sender = async (sub, payload, ttl, urgency) => {
  setupVapid();
  const d = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload,
    { TTL: ttl, urgency, contentEncoding: 'aes128gcm' },
  );
  const res = await fetch(d.endpoint, {
    method: d.method,
    headers: d.headers as Record<string, string>,
    body: d.body ? new Uint8Array(d.body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  await res.body?.cancel();
  return res.status;
};

// ---------------------------------------------------------------- delivery
const TTL: Record<string, number> = {
  due_15m: 15 * 60, due_1h: 45 * 60, overdue: 6 * 3600, daily: 3 * 3600,
  partner_done: 24 * 3600, partner_dispute: 24 * 3600, dispute_cleared: 24 * 3600, settlement_request: 24 * 3600, settlement_result: 24 * 3600, test: 600,
};
const URGENT = new Set(['due_15m', 'due_1h', 'overdue']);
const GONE = new Set([404, 410]);
const PERMANENT = new Set([400, 403, 404, 410, 413]);   // retrying cannot help

export interface PushMessage {
  title: string; body: string; url: string; badge: number; tag: string; kind: string;
  task_id?: string; settlement_id?: string; outbox_id?: number; sent_at: string;
}

/** Send to every active subscription of a member. */
export async function sendToMember(store: Store, sender: Sender, memberId: string, msg: PushMessage) {
  const subs = await store.subscriptions(memberId);
  const payload = JSON.stringify(msg);
  const results = await Promise.all(subs.map(async (s) => {
    try {
      const status = await sender(s, payload, TTL[msg.kind] ?? 3600, URGENT.has(msg.kind) ? 'high' : 'normal');
      if (status >= 200 && status < 300) { await store.markSuccess(s.id).catch(() => {}); return { status, ok: true }; }
      if (GONE.has(status)) await store.markDisabled(s.id).catch(() => {});
      return { status, ok: false };
    } catch (e) {
      return { status: 0, ok: false, err: String((e as Error)?.message ?? e) };
    }
  }));
  return { subs: subs.length, results };
}

/** Deliver one claimed outbox row and record the outcome. */
export async function deliverRow(store: Store, sender: Sender, row: OutboxRow) {
  try {
    const ctx = await store.context(row.id);
    if (!ctx) { await store.finish(row.id, true, 'RECIPIENT_GONE'); return { id: row.id, ok: true, note: 'RECIPIENT_GONE' }; }
    const { title, body } = render(ctx);
    const p = ctx.payload ?? {};
    const msg: PushMessage = {
      title, body,
      url: typeof p.url === 'string' ? p.url : './',
      badge: ctx.badge,
      tag: typeof p.tag === 'string' ? p.tag : `${row.kind}:${p.task_id ?? p.settlement_id ?? row.id}`,
      kind: row.kind,
      task_id: p.task_id as string | undefined,
      settlement_id: p.settlement_id as string | undefined,
      outbox_id: row.id,
      sent_at: new Date().toISOString(),
    };
    const r = await sendToMember(store, sender, ctx.recipient_id, msg);
    if (r.subs === 0) { await store.finish(row.id, true, 'NO_SUBSCRIPTION'); return { id: row.id, ok: true, note: 'NO_SUBSCRIPTION' }; }
    const delivered = r.results.filter((x) => x.ok).length;
    const failures = r.results.filter((x) => !x.ok);
    const errText = failures.length ? failures.map((f) => f.err ?? `HTTP ${f.status}`).join('; ') : null;
    // Done when at least one device got it (never resend to it), or when every failure is permanent.
    const done = delivered > 0 || failures.every((f) => PERMANENT.has(f.status));
    await store.finish(row.id, done, errText);
    return { id: row.id, ok: done, delivered, error: errText };
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    await store.finish(row.id, false, m).catch(() => {});
    return { id: row.id, ok: false, error: m };
  }
}

export async function sendTestPush(store: Store, sender: Sender, memberId: string) {
  const msg: PushMessage = {
    ...TEST_COPY, url: './?debug=1', badge: await store.badge(memberId),
    tag: `test:${Date.now()}`, kind: 'test', sent_at: new Date().toISOString(),
  };
  return sendToMember(store, sender, memberId, msg);
}
