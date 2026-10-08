// Local tests for the Edge Functions (no Supabase, no real push service needed).
// Run from the project root:
//   npx -y deno test --allow-env --allow-net=127.0.0.1 --allow-read supabase/tests/push_test.ts
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import webpush from 'npm:web-push@3.6.7';
import { isAuthorized, timingSafeEqual } from '../functions/_shared/auth.ts';
import { render, len, TITLE_MAX, BODY_MAX, type Ctx } from '../functions/_shared/copy.ts';
import { deliverRow, webPushSender, type OutboxRow, type Sender, type Store, type Sub } from '../functions/_shared/deliver.ts';
import { handle as sendPush } from '../functions/send-push/handler.ts';
import { handle as tick } from '../functions/tick/handler.ts';

const SECRET = 'test-secret-1234567890';
Deno.env.set('FUNCTION_SECRET', SECRET);
const vapid = webpush.generateVAPIDKeys();
Deno.env.set('VAPID_PUBLIC_KEY', vapid.publicKey);
Deno.env.set('VAPID_PRIVATE_KEY', vapid.privateKey);
Deno.env.set('VAPID_SUBJECT', 'mailto:test@example.com');

const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`, extra: Record<string, string> = {}) =>
  new Request('http://x/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}), ...extra }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- auth
Deno.test('auth: constant-time compare and Bearer only', () => {
  assert(timingSafeEqual('abc', 'abc'));
  assert(!timingSafeEqual('abc', 'abd'));
  assert(!timingSafeEqual('abc', 'abcd'));
  assert(isAuthorized(post({})));
  assert(!isAuthorized(post({}, 'Bearer wrong')));
  assert(!isAuthorized(post({}, null)));
  assert(!isAuthorized(post({}, null, { 'x-function-secret': SECRET })), 'x-function-secret alone is not enough');
  assert(!isAuthorized(post({}), ''), 'empty FUNCTION_SECRET never authorizes');
});

// ---------------------------------------------------------------- copy
const ctx = (o: Partial<Ctx>): Ctx => ({
  outbox_id: 1, kind: 'due_1h', payload: {}, recipient_id: 'r', me_name: 'Me', partner_name: 'Ming',
  total_net_me: 0, badge: 2, next_title: '英文單字', task_title: '微積分', task_value: 20, ...o,
});
Deno.test('copy: table texts', () => {
  assertEquals(render(ctx({ kind: 'due_1h' })), { title: '賭讀 ⏰ 還剩 1 小時', body: '「微積分」NT$ 20，快去完成！' });
  assertEquals(render(ctx({ kind: 'due_15m' })), { title: '賭讀 🔥 只剩 15 分鐘', body: '「微積分」NT$ 20 快到期了' });
  assertEquals(render(ctx({ kind: 'partner_done', total_net_me: -40 })), { title: 'Ming 剛完成 +20', body: '你現在落後 NT$ 40，輪到你了' });
  assertEquals(render(ctx({ kind: 'partner_done', total_net_me: 10 })).body, '你領先 NT$ 10');
  assertEquals(render(ctx({ kind: 'partner_done', total_net_me: 0 })).body, '平手');
  assertEquals(render(ctx({ kind: 'partner_dispute' })), { title: 'Ming 質疑了你的證明', body: '「微積分」的照片需要再確認' });
  assertEquals(render(ctx({ kind: 'overdue' })), { title: '賭讀 任務已逾期', body: '「微積分」已逾期，不影響分數' });
  assertEquals(render(ctx({ kind: 'daily' })), { title: '賭讀 📚 今天還有 2 件事沒做', body: '最近到期：「英文單字」' });
  assertEquals(render(ctx({ kind: 'settlement_request', total_net_me: -40 })), { title: 'Ming 想結算', body: '同意後總計歸零，目前 NT$ 40' });
  assertEquals(render(ctx({ kind: 'settlement_result', payload: { result: 'confirmed' } })), { title: 'Ming 已同意結算', body: '總計已歸零，可在歷史撤銷' });
  // not in the table → backend text kept
  assertEquals(render(ctx({ kind: 'settlement_result', payload: { result: 'rejected', title: '結算未成立', body: 'Ming 拒絕了結算' } })), { title: '結算未成立', body: 'Ming 拒絕了結算' });
});
Deno.test('copy: limits hold for the longest inputs', () => {
  const long = '一二三四五六七八九十'.repeat(4);   // 40 chars, the title maximum
  for (const kind of ['due_1h', 'due_15m', 'partner_done', 'partner_dispute', 'overdue', 'daily', 'settlement_request', 'settlement_result']) {
    const r = render(ctx({ kind, task_title: long, next_title: long, partner_name: '六個字的名字', task_value: 50, total_net_me: -9999, badge: 99, payload: { result: 'confirmed' } }));
    assert(len(r.title) <= TITLE_MAX, `${kind} title ${len(r.title)}`);
    assert(len(r.body) <= BODY_MAX, `${kind} body ${len(r.body)}`);
  }
});

// ---------------------------------------------------------------- real encryption, decrypted like a browser would
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
type Bytes = Uint8Array<ArrayBuffer>;
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
const cat = (...a: Uint8Array[]): Bytes => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const te = new TextEncoder();

Deno.test('webPushSender: RFC 8291 payload decrypts, VAPID JWT verifies', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  let got: { body: Uint8Array; headers: Headers } | null = null;
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
    got = { body: new Uint8Array(await req.arrayBuffer()), headers: req.headers };
    return new Response(null, { status: 201 });
  });
  const sub: Sub = { id: 's1', endpoint: `http://127.0.0.1:${server.addr.port}/push/abc`, p256dh: b64u(uaPub), auth: b64u(authSecret) };
  const msg = { title: '賭讀 ⏰ 還剩 1 小時', body: '「微積分」NT$ 20，快去完成！', badge: 3 };
  const status = await webPushSender(sub, JSON.stringify(msg), 2700, 'high');
  await server.shutdown();
  assertEquals(status, 201);
  const g = got!;
  assertEquals(g.headers.get('content-encoding'), 'aes128gcm');
  assertEquals(g.headers.get('ttl'), '2700');
  assertEquals(g.headers.get('urgency'), 'high');

  // decrypt (RFC 8188 header + RFC 8291 key schedule)
  const salt = g.body.slice(0, 16), idlen = g.body[20], asPub = g.body.slice(21, 21 + idlen), ct = g.body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  let end = plain.length - 1; while (plain[end] === 0) end--;
  assertEquals(plain[end], 2, 'last-record delimiter');
  assertEquals(JSON.parse(new TextDecoder().decode(plain.slice(0, end))), msg);

  // VAPID: "vapid t=<jwt>, k=<public key>", ES256 signature by our private key
  const m = /vapid t=([^,]+),\s*k=(\S+)/.exec(g.headers.get('authorization') ?? '');
  assert(m, 'vapid authorization header');
  assertEquals(m![2], vapid.publicKey);
  const [h, p, s] = m![1].split('.');
  const claims = JSON.parse(new TextDecoder().decode(unb64u(p)));
  assertEquals(claims.aud, `http://127.0.0.1:${new URL(sub.endpoint).port}`);
  assertEquals(claims.sub, 'mailto:test@example.com');
  const vk = await crypto.subtle.importKey('raw', unb64u(vapid.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, unb64u(s), te.encode(`${h}.${p}`)), 'VAPID signature');
});

// ---------------------------------------------------------------- delivery with a fake store
function fakeStore(over: Partial<Store> = {}) {
  const log: string[] = [];
  const store: Store = {
    claim: async (id) => (id === 7 ? [{ id: 7, recipient_id: 'r', kind: 'partner_done', payload: { task_id: 't', tag: 'partner_done:t', url: './#history' }, attempts: 1 }] : []),
    context: async () => ctx({ kind: 'partner_done', total_net_me: -40, payload: { task_id: 't', tag: 'partner_done:t', url: './#history' } }),
    finish: async (id, ok, err) => { log.push(`finish ${id} ${ok} ${err ?? ''}`.trim()); },
    subscriptions: async () => [{ id: 'a', endpoint: 'e1', p256dh: '', auth: '' }, { id: 'b', endpoint: 'e2', p256dh: '', auth: '' }],
    markDisabled: async (id) => { log.push(`disable ${id}`); },
    markSuccess: async (id) => { log.push(`success ${id}`); },
    badge: async () => 2,
    claimDue: async () => 3,
    listExpiredProofs: async () => [],
    removeProofFiles: async () => {},
    markProofsExpired: async (ids) => ids.length,
    nightlyCleanup: async () => { log.push('nightly'); return {}; },
    ...over,
  };
  return { store, log };
}
const senderWith = (codes: Record<string, number>, seen: string[] = []): Sender => async (sub, payload) => {
  seen.push(payload);
  return codes[sub.endpoint] ?? 201;
};
const row: OutboxRow = { id: 7, recipient_id: 'r', kind: 'partner_done', payload: {}, attempts: 1 };

Deno.test('deliver: success on both devices', async () => {
  const { store, log } = fakeStore();
  const seen: string[] = [];
  const r = await deliverRow(store, senderWith({}, seen), row);
  assert(r.ok);
  assertEquals(log.sort(), ['finish 7 true', 'success a', 'success b']);
  const msg = JSON.parse(seen[0]);
  assertEquals([msg.title, msg.body, msg.badge, msg.tag, msg.url], ['Ming 剛完成 +20', '你現在落後 NT$ 40，輪到你了', 2, 'partner_done:t', './#history']);
});
Deno.test('deliver: 410 disables that subscription; partly delivered counts as sent', async () => {
  const { store, log } = fakeStore();
  const r = await deliverRow(store, senderWith({ e2: 410 }), row);
  assert(r.ok);
  assert(log.includes('disable b') && log.includes('success a'));
  assert(log.some((l) => l.startsWith('finish 7 true HTTP 410')));
});
Deno.test('deliver: transient 500 everywhere → released for retry', async () => {
  const { store, log } = fakeStore();
  const r = await deliverRow(store, senderWith({ e1: 500, e2: 503 }), row);
  assert(!r.ok);
  assert(log.some((l) => l.startsWith('finish 7 false')));
  assert(!log.some((l) => l.startsWith('disable')));
});
Deno.test('deliver: all gone (404/410) → done, both disabled', async () => {
  const { store, log } = fakeStore();
  assert((await deliverRow(store, senderWith({ e1: 404, e2: 410 }), row)).ok);
  assert(log.includes('disable a') && log.includes('disable b'));
});
Deno.test('deliver: no subscription → marked sent with NO_SUBSCRIPTION', async () => {
  const { store, log } = fakeStore({ subscriptions: async () => [] });
  await deliverRow(store, senderWith({}), row);
  assertEquals(log, ['finish 7 true NO_SUBSCRIPTION']);
});
Deno.test('deliver: database error → released, not lost', async () => {
  const { store, log } = fakeStore({ context: async () => { throw new Error('db down'); } });
  assert(!(await deliverRow(store, senderWith({}), row)).ok);
  assertEquals(log, ['finish 7 false db down']);
});

// ---------------------------------------------------------------- handlers
Deno.test('send-push: 401 on wrong secret, skip when not claimable, delivers when claimed', async () => {
  const { store } = fakeStore();
  assertEquals((await sendPush(post({ outbox_id: 7 }, 'Bearer nope'), store, senderWith({}))).status, 401);
  assertEquals((await sendPush(post({ outbox_id: 7 }, null, { 'x-function-secret': SECRET }), store, senderWith({}))).status, 401);
  assertEquals(await (await sendPush(post({ outbox_id: 8 }), store, senderWith({}))).json(), { id: 8, skipped: true });
  const ok = await (await sendPush(post({ outbox_id: 7 }), store, senderWith({}))).json();
  assertEquals([ok.ok, ok.delivered], [true, 2]);
});
Deno.test('send-push: send_test_push', async () => {
  const { store } = fakeStore();
  const seen: string[] = [];
  const r = await (await sendPush(post({ action: 'send_test_push', member_id: '00000000-0000-4000-8000-000000000001' }), store, senderWith({}, seen))).json();
  assertEquals([r.ok, r.subscriptions], [true, 2]);
  assertMatch(JSON.parse(seen[0]).title, /測試通知/);
  assertEquals((await sendPush(post({ action: 'send_test_push' }), store, senderWith({}))).status, 400);
});
Deno.test('tick: reminders, sweep, proof cleanup marks only removed batches, nightly only on request', async () => {
  const proofs = Array.from({ length: 150 }, (_, i) => ({ task_id: `t${i}`, proof_path: `r/t${i}.jpg` }));
  let calls = 0;
  const marked: string[] = [];
  const { store, log } = fakeStore({
    claim: async (id) => (id === null ? [{ ...row, id: 9 }] : []),
    listExpiredProofs: async () => proofs,
    removeProofFiles: async () => { if (++calls === 2) throw new Error('storage 500'); },
    markProofsExpired: async (ids) => { marked.push(...ids); return ids.length; },
  });
  const r = await (await tick(post({ source: 'pg_cron' }), store, senderWith({}))).json();
  assertEquals(r.claimed, 3);
  assertEquals(r.sweep, { retried: 1, delivered: 1 });
  assertEquals(r.proofs, { found: 150, removed: 100, marked: 100, failedBatches: 1 });
  assertEquals(marked.length, 100);
  assert(!marked.includes('t120'), 'second batch failed → not marked');
  assert(!log.includes('nightly'));
  const n = await (await tick(post({ job: 'nightly' }), store, senderWith({}))).json();
  assert('nightly' in n && log.includes('nightly'));
  assertEquals((await tick(post({}, 'Bearer x'), store, senderWith({}))).status, 401);
});
