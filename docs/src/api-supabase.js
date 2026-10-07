// Real backend adapter. Only contract RPCs, select on `tasks`, the `proofs` bucket
// and Realtime are used. mock.js implements the same interface.
//
// Interface (both adapters):
//   hasSession() → bool          signIn(captchaToken?)
//   rpc(name, args) → data       (throws AppError with a stable code)
//   activeTasks() → task rows    (status 'active', deleted_at is null)
//   upload(path, blob)           signedUrl(path) → url (60 s)
//   openChannel(roomId, onChange(table, payload), onStatus(status)) → close()

// Keep in sync with CDN_FILES in ../sw.js (precached for offline use).
export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';

import { toAppError } from './errors.js';

export async function createApi(cfg) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'studybet-auth' },
  });
  const fail = (error, fallback) => { throw toAppError(error, fallback); };

  return {
    mode: 'supabase',
    sb,
    async hasSession() {
      const { data } = await sb.auth.getSession();
      return !!data.session;
    },
    async signIn(captchaToken) {
      const { error } = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
      if (error) fail(error);
    },
    async rpc(name, args) {
      const { data, error } = await sb.rpc(name, args || {});
      if (error) fail(error);   // pairing BAD_CODE / CODE_TAKEN arrive here too (A1)
      return data;
    },
    async activeTasks() {
      const { data, error } = await sb.from('tasks').select('*')
        .is('deleted_at', null).eq('status', 'active').order('due_at', { ascending: true });
      if (error) fail(error);
      return data || [];
    },
    async upload(path, blob) {
      const { error } = await sb.storage.from('proofs').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (error) fail(error, 'UPLOAD_FAILED');
    },
    async signedUrl(path) {
      const { data, error } = await sb.storage.from('proofs').createSignedUrl(path, 60);
      if (error) fail(error);
      return data.signedUrl;
    },
    openChannel(roomId, onChange, onStatus) {
      const ch = sb.channel(`room-${roomId}-${Date.now()}`);
      for (const table of ['tasks', 'settlements', 'members']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `room_id=eq.${roomId}` },
          (payload) => onChange(table, payload));
      }
      ch.subscribe((status) => onStatus(status));
      return () => { sb.removeChannel(ch); };
    },
  };
}
