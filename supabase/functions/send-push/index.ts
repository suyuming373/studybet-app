// send-push — delivers one notification_outbox row as Web Push.
// Called by the outbox INSERT trigger (pg_net) with {"outbox_id": n}.
// Admin test: {"action": "send_test_push", "member_id": "<uuid>"}.
// Deploy: npx supabase functions deploy send-push --no-verify-jwt
import { json } from '../_shared/auth.ts';
import { supabaseStore, webPushSender } from '../_shared/deliver.ts';
import { handle } from './handler.ts';

Deno.serve((req) => handle(req, supabaseStore(), webPushSender).catch((e) => {
  console.error('[send-push] crash', e);
  return json({ error: 'internal' }, 500);
}));
