// tick — runs every minute (pg_cron via 99_enable_notification_cron.sql, or the Cloudflare fallback).
//   1. claim_due_notifications()   → due_1h / due_15m / overdue / daily outbox rows (deduped in SQL)
//   2. sweep unsent outbox rows older than 30 s (max 3 attempts, claimed so none is sent twice)
//   3. proof cleanup: list_expired_proofs → Storage remove → mark_proofs_expired (only for removed files)
//   + {"job":"nightly"} (Cloudflare fallback only) also runs nightly_cleanup()
// Deploy: npx supabase functions deploy tick --no-verify-jwt
import { isAuthorized, json, unauthorized } from '../_shared/auth.ts';
import { deliverRow, type Sender, type Store } from '../_shared/deliver.ts';

const SWEEP_LIMIT = 25;
const PROOF_BATCH = 100;

export async function handle(req: Request, store: Store, sender: Sender): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!isAuthorized(req)) return unauthorized('tick', req);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const t0 = Date.now();
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { out[name] = await fn(); } catch (e) { out[name] = { error: String((e as Error)?.message ?? e) }; console.error(`[tick] ${name}`, e); }
  };

  // 1. timed reminders: each new outbox row dispatches itself through the INSERT trigger
  await step('claimed', () => store.claimDue());

  // 2. sweep: rows the trigger could not deliver (pg_net hiccup, function cold start failure, transient 5xx)
  await step('sweep', async () => {
    const rows = await store.claim(null, SWEEP_LIMIT);
    const res = await Promise.all(rows.map((r) => deliverRow(store, sender, r)));
    return { retried: rows.length, delivered: res.filter((r) => r.ok).length };
  });

  // 3. proofs older than 30 days
  await step('proofs', async () => {
    const list = await store.listExpiredProofs();
    let removed = 0, marked = 0, failedBatches = 0;
    for (let i = 0; i < list.length; i += PROOF_BATCH) {
      const batch = list.slice(i, i + PROOF_BATCH);
      try {
        await store.removeProofFiles(batch.map((x) => x.proof_path));
      } catch (e) {
        failedBatches++;                       // not marked: the same rows come back next tick
        console.error('[tick] proof remove failed', e);
        continue;
      }
      removed += batch.length;
      marked += await store.markProofsExpired([...new Set(batch.map((x) => x.task_id))]);
    }
    return { found: list.length, removed, marked, failedBatches };
  });

  if (body.job === 'nightly') await step('nightly', () => store.nightlyCleanup());

  out.ms = Date.now() - t0;
  console.log('[tick]', JSON.stringify(out));
  return json(out);
}
