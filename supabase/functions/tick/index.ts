// tick — runs every minute (pg_cron via 99_enable_notification_cron.sql, or the Cloudflare fallback).
//   1. claim_due_notifications()   → due_1h / due_15m / overdue / daily outbox rows (deduped in SQL)
//   2. sweep unsent outbox rows older than 30 s (max 3 attempts, claimed so none is sent twice)
//   3. proof cleanup: list_expired_proofs → Storage remove → mark_proofs_expired (only for removed files)
//   + {"job":"nightly"} (Cloudflare fallback only) also runs nightly_cleanup()
// Deploy: npx supabase functions deploy tick --no-verify-jwt
import { json } from '../_shared/auth.ts';
import { supabaseStore, webPushSender } from '../_shared/deliver.ts';
import { handle } from './handler.ts';

Deno.serve((req) => handle(req, supabaseStore(), webPushSender).catch((e) => {
  console.error('[tick] crash', e);
  return json({ error: 'internal' }, 500);
}));
