// send-push — delivers one notification_outbox row as Web Push.
// Called by the outbox INSERT trigger (pg_net) with {"outbox_id": n}.
// Admin test: {"action": "send_test_push", "member_id": "<uuid>"}.
// Deploy: npx supabase functions deploy send-push --no-verify-jwt
import { isAuthorized, json, unauthorized } from '../_shared/auth.ts';
import { deliverRow, sendTestPush, type Sender, type Store } from '../_shared/deliver.ts';

export async function handle(req: Request, store: Store, sender: Sender): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!isAuthorized(req)) return unauthorized('send-push', req);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'body must be JSON' }, 400); }

  if (body.action === 'send_test_push') {
    const member = String(body.member_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(member)) return json({ error: 'member_id (uuid) required' }, 400);
    const r = await sendTestPush(store, sender, member);
    return json({ ok: r.results.some((x) => x.ok), subscriptions: r.subs, results: r.results });
  }

  const id = Number(body.outbox_id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'outbox_id required' }, 400);
  const t0 = Date.now();
  const rows = await store.claim(id, 1);
  // Already sent, owned by another sender, or out of attempts: nothing to do (never send twice).
  if (!rows.length) return json({ id, skipped: true });
  const r = await deliverRow(store, sender, rows[0]);
  console.log(`[send-push] outbox ${id} kind=${rows[0].kind} attempt=${rows[0].attempts} ok=${r.ok} ${Date.now() - t0}ms${r.error ? ' err=' + r.error : ''}`);
  return json({ ...r, ms: Date.now() - t0 });
}
