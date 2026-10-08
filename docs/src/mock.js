// ?mock=1 — in-memory fake of the contract's RPCs, table reads, Storage and Realtime.
// Same interface as api-supabase.js. Mirrors backend/02_rls_and_rpc.sql closely
// (validation order, error codes, scoring windows, history paging).
import { mockServerNow } from './clock.js';
import { AppError } from './errors.js';
import { weekStart, parts, zoned, dayKey, endOfDay } from './time.js';
import { fakePhoto } from './image.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
const H = 36e5, MIN = 6e4, DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => (s ? Date.parse(s) : NaN);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const fail = (code) => { throw new AppError(code); };

export function createMockApi({ pair = false, batch2 = false } = {}) {
  const now = () => mockServerNow();
  const T = now();

  // ---------- seed: "Me" (slot 1) + "Ming" (slot 2), 5 tasks, 1 settlement ----------
  const room = { id: uuid(), code: 'studybet-demo', timezone: 'Asia/Taipei', daily_reminder_time: '21:00:00', created_at: iso(T - 30 * DAY) };
  const ME = uuid(), MING = uuid();
  const db = {
    rooms: [room],
    members: [
      { id: ME, room_id: room.id, slot: 1, display_name: 'Me', created_at: iso(T - 30 * DAY) },
      { id: MING, room_id: room.id, slot: 2, display_name: 'Ming', created_at: iso(T - 30 * DAY) },
    ],
    tasks: [],
    settlements: [],
    storage: new Map(),
    failures: [],
    settingsCalls: [],   // every update_settings args object, for tests
  };
  let uid = pair ? null : ME;   // the anonymous user of this "phone"
  let offline = false;

  const task = (o) => ({
    id: uuid(), room_id: room.id, requires_proof: false, status: 'active', completed_at: null, abandoned_at: null,
    deleted_at: null, proof_path: null, disputed: false, disputed_at: null, proof_expired: false, ...o,
  });
  const todayEnd = endOfDay(0, T);
  db.tasks.push(
    task({ owner_id: ME, title: '微積分第 3 章習題', value: 20, due_at: iso(T + 40 * MIN), created_at: iso(T - 2 * H) }),
    task({ owner_id: ME, title: '拍讀書桌照片打卡', value: 10, due_at: iso(endOfDay(1, T)), created_at: iso(T - H), requires_proof: true }),
    task({ owner_id: MING, title: '英文單字 50 個', value: 20, due_at: iso(todayEnd - T > 20 * MIN ? todayEnd : T + 3 * H), created_at: iso(T - 3 * H) }),
    task({ owner_id: ME, title: '物理講義讀完', value: 10, status: 'done', created_at: iso(T - 30 * H), completed_at: iso(T - 20 * H), due_at: iso(T - 18 * H) }),
  );
  const mingDone = task({ owner_id: MING, title: '化學實驗報告', value: 50, status: 'done', requires_proof: true, created_at: iso(T - 5 * H), completed_at: iso(T - 2 * H), due_at: iso(T + DAY) });
  mingDone.proof_path = `${room.id}/${mingDone.id}.jpg`;
  db.tasks.push(mingDone);
  db.settlements.push({
    id: uuid(), room_id: room.id, proposed_by: MING, status: 'confirmed', amount_slot1_net: 30,
    proposed_at: iso(T - 3 * DAY - H), confirmed_at: iso(T - 3 * DAY), responded_by: ME, undone_at: null,
  });
  const seededProofs = new Set([mingDone.proof_path]);

  // ---------- realtime ----------
  const channels = new Set();
  function broadcast(table, row) {
    const payload = { eventType: 'UPDATE', schema: 'public', table, new: clone(row), old: { id: row.id } };
    setTimeout(() => {
      for (const ch of channels) if (ch.alive && ch.roomId === row.room_id) ch.onChange(table, payload);
    }, 60 + Math.random() * 80);
  }
  function dropChannels() {
    for (const ch of [...channels]) { ch.alive = false; channels.delete(ch); ch.onStatus('CHANNEL_ERROR'); }
  }

  // ---------- helpers mirroring the SQL ----------
  const memberOf = (id) => db.members.find((m) => m.id === id) || null;
  function me() { if (!uid) fail('NOT_AUTHENTICATED'); return memberOf(uid) || fail('NOT_IN_ROOM'); }
  const roomOf = (id) => db.rooms.find((r) => r.id === id);
  const partnerOf = (m) => db.members.find((x) => x.room_id === m.room_id && x.id !== m.id) || null;
  // ?batch2=1: members.daily_reminder_enabled exists (default on). Without it the field is absent, like the deployed backend.
  const memberJson = (m) => {
    if (!m) return null;
    const j = clone(m);
    if (batch2) j.daily_reminder_enabled = m.daily_reminder_enabled ?? true;
    else delete j.daily_reminder_enabled;
    return j;
  };
  const roomJson = (r) => ({ id: r.id, timezone: r.timezone, daily_reminder_time: r.daily_reminder_time, created_at: r.created_at });
  const roomTasks = (rid) => db.tasks.filter((t) => t.room_id === rid && !t.deleted_at);
  const slotOf = (id) => memberOf(id)?.slot;

  function boundary(rid) {
    const c = db.settlements.filter((s) => s.room_id === rid && s.status === 'confirmed').sort((a, b) => ms(b.confirmed_at) - ms(a.confirmed_at))[0];
    return c ? ms(c.confirmed_at) : null;
  }
  function netSlot1(rid, from, exclusive) {
    let n = 0;
    for (const t of roomTasks(rid)) {
      if (t.status !== 'done') continue;
      const c = ms(t.completed_at);
      if (from != null && (exclusive ? c <= from : c < from)) continue;
      n += slotOf(t.owner_id) === 1 ? t.value : -t.value;
    }
    return n;
  }
  const totalNetSlot1 = (rid) => netSlot1(rid, boundary(rid), true);
  function streak(memberId) {
    const days = new Set(db.tasks.filter((t) => t.owner_id === memberId && t.status === 'done' && !t.deleted_at).map((t) => dayKey(ms(t.completed_at))));
    const p = parts(now());
    const key = (k) => dayKey(zoned(p.y, p.mo, p.d - k, 12, 0));
    let k = days.has(key(0)) ? 0 : 1, n = 0;
    while (days.has(key(k))) { n++; k++; }
    return n;
  }
  const badge = (memberId) => db.tasks.filter((t) => t.owner_id === memberId && t.status === 'active' && !t.deleted_at && ms(t.due_at) > now()).length;
  function expireStale(rid) {
    for (const s of db.settlements) {
      if (s.room_id === rid && s.status === 'pending' && ms(s.proposed_at) <= now() - 7 * DAY) { s.status = 'rejected'; broadcast('settlements', s); }
    }
  }
  function taskFor(rid, id) {
    return db.tasks.find((t) => t.id === id && t.room_id === rid && !t.deleted_at) || fail('TASK_NOT_FOUND');
  }
  function pairingCheck() {
    db.failures = db.failures.filter((f) => f > now() - 10 * MIN);
    if (db.failures.length >= 5) fail('RATE_LIMITED');
  }
  const softFail = (code) => { db.failures.push(now()); fail(code); };
  function reassign(oldId, newId) {
    for (const t of db.tasks) if (t.owner_id === oldId) { t.owner_id = newId; broadcast('tasks', t); }
    for (const s of db.settlements) {
      if (s.proposed_by === oldId) s.proposed_by = newId;
      if (s.responded_by === oldId) s.responded_by = newId;
    }
  }

  function getState() {
    const m = me();
    const r = roomOf(m.room_id);
    const p = partnerOf(m);
    const sign = m.slot === 1 ? 1 : -1;
    const ws = weekStart(now());
    const wp = parts(ws);
    const bound = boundary(r.id);
    const counts = (id) => {
      const done = roomTasks(r.id).filter((t) => t.owner_id === id && t.status === 'done');
      return { week: done.filter((t) => ms(t.completed_at) >= ws).length, total: done.filter((t) => bound == null || ms(t.completed_at) > bound).length };
    };
    const pend = db.settlements.find((s) => s.room_id === r.id && s.status === 'pending' && ms(s.proposed_at) > now() - 7 * DAY);
    const last = db.settlements.filter((s) => s.room_id === r.id && s.status === 'confirmed').sort((a, b) => ms(b.confirmed_at) - ms(a.confirmed_at))[0];
    return {
      server_now: iso(now()),
      room: roomJson(r),
      me: memberJson(m),
      partner: memberJson(p),
      week_start: iso(ws),
      week_end: iso(zoned(wp.y, wp.mo, wp.d + 7, 0, 0)),
      week_net_me: sign * netSlot1(r.id, ws, false),
      total_net_me: sign * totalNetSlot1(r.id),
      done_counts: { me: counts(m.id), partner: p ? counts(p.id) : { week: 0, total: 0 } },
      streaks: { me: streak(m.id), partner: p ? streak(p.id) : 0 },
      active_task_count: badge(m.id),
      pending_settlement: pend ? {
        id: pend.id, proposed_by: pend.proposed_by, proposed_by_me: pend.proposed_by === m.id,
        proposed_at: pend.proposed_at, expires_at: iso(ms(pend.proposed_at) + 7 * DAY),
      } : null,
      last_confirmed_settlement: last ? {
        id: last.id, amount_slot1_net: last.amount_slot1_net, amount_me: sign * last.amount_slot1_net,
        confirmed_at: last.confirmed_at, proposed_by: last.proposed_by, responded_by: last.responded_by,
        can_undo: now() <= ms(last.confirmed_at) + DAY, undo_until: iso(ms(last.confirmed_at) + DAY),
      } : null,
    };
  }

  function listHistory({ p_before, p_limit }) {
    const m = me();
    const before = p_before ? ms(p_before) : Infinity;
    const limit = Math.min(Math.max(p_limit || 30, 1), 100);
    const sign = m.slot === 1 ? 1 : -1;
    const items = [];
    for (const t of roomTasks(m.room_id)) {
      if (!(t.status === 'done' || t.status === 'abandoned' || ms(t.due_at) <= now())) continue;
      const at = t.status === 'done' ? t.completed_at : t.status === 'abandoned' ? t.abandoned_at : t.due_at;
      if (ms(at) >= before) continue;
      items.push({
        type: 'task', id: t.id, status: t.status === 'active' ? 'overdue' : t.status,
        owner_id: t.owner_id, owner_slot: slotOf(t.owner_id), mine: t.owner_id === m.id,
        title: t.title, value: t.value, due_at: t.due_at, created_at: t.created_at,
        completed_at: t.completed_at, abandoned_at: t.abandoned_at, requires_proof: t.requires_proof,
        proof_path: t.proof_path, proof_expired: t.proof_expired, disputed: t.disputed, disputed_at: t.disputed_at, at,
      });
    }
    for (const s of db.settlements) {
      if (s.room_id !== m.room_id) continue;
      if (!(s.status !== 'pending' || ms(s.proposed_at) <= now() - 7 * DAY)) continue;
      const at = s.undone_at || s.confirmed_at || s.proposed_at;
      if (ms(at) >= before) continue;
      items.push({
        type: 'settlement', id: s.id, status: s.status, proposed_by: s.proposed_by, responded_by: s.responded_by,
        amount_slot1_net: s.amount_slot1_net, amount_me: s.amount_slot1_net == null ? null : sign * s.amount_slot1_net,
        proposed_at: s.proposed_at, confirmed_at: s.confirmed_at, undone_at: s.undone_at, at,
      });
    }
    items.sort((a, b) => ms(b.at) - ms(a.at) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    if (items.length <= limit) return items;
    const edge = ms(items[limit - 1].at);
    return items.filter((x) => ms(x.at) >= edge);   // same-timestamp items stay together
  }

  const RPC = {
    get_state: () => getState(),
    list_history: (a) => listHistory(a),

    create_room({ p_code, p_display_name }) {
      if (!uid) fail('NOT_AUTHENTICATED');
      pairingCheck();
      const code = (p_code || '').trim(), name = (p_display_name || '').trim();
      if (memberOf(uid)) fail('ALREADY_IN_ROOM');
      if (code.length < 8) fail('CODE_TOO_SHORT');
      if (code.length > 64) fail('CODE_TOO_LONG');
      if (name.length < 1 || name.length > 6) fail('BAD_NAME');
      if (db.rooms.some((r) => r.code === code)) softFail('CODE_TAKEN');
      const r = { id: uuid(), code, timezone: 'Asia/Taipei', daily_reminder_time: '21:00:00', created_at: iso(now()) };
      db.rooms.push(r);
      const m = { id: uid, room_id: r.id, slot: 1, display_name: name, created_at: iso(now()) };
      db.members.push(m);
      return { room: roomJson(r), member: clone(m) };
    },
    join_room({ p_code, p_display_name, p_slot = null }) {
      if (!uid) fail('NOT_AUTHENTICATED');
      pairingCheck();
      const code = (p_code || '').trim(), name = (p_display_name || '').trim();
      if (name.length < 1 || name.length > 6) fail('BAD_NAME');
      if (p_slot != null && p_slot !== 1 && p_slot !== 2) fail('BAD_SLOT');
      const r = code.length >= 8 && code.length <= 64 ? db.rooms.find((x) => x.code === code) : null;
      if (!r) softFail('BAD_CODE');
      const existing = memberOf(uid);
      if (existing) {
        if (existing.room_id !== r.id) fail('ALREADY_IN_ROOM');
        existing.display_name = name; broadcast('members', existing);
        return clone(existing);
      }
      const taken = db.members.filter((m) => m.room_id === r.id).map((m) => m.slot);
      const free = [p_slot, 1, 2].find((s) => s && !taken.includes(s));
      if (free) {
        const m = { id: uid, room_id: r.id, slot: free, display_name: name, created_at: iso(now()) };
        db.members.push(m); broadcast('members', m);
        return clone(m);
      }
      if (p_slot == null) softFail('BAD_CODE');
      const m = db.members.find((x) => x.room_id === r.id && x.slot === p_slot);
      const old = m.id;
      m.id = uid; m.display_name = name;
      reassign(old, uid);
      broadcast('members', m);
      return clone(m);
    },

    create_task({ p_title, p_value, p_due_at, p_requires_proof }) {
      const m = me();
      const title = (p_title || '').trim();
      if (title.length < 1 || title.length > 40) fail('BAD_TITLE');
      if (!Number.isInteger(p_value) || p_value < 1 || p_value > 50) fail('BAD_VALUE');
      const due = ms(p_due_at);
      if (!Number.isFinite(due) || due < now() + 5 * MIN || due > now() + 7 * DAY) fail('BAD_DUE');
      const t = task({ room_id: m.room_id, owner_id: m.id, title, value: p_value, due_at: iso(due), requires_proof: !!p_requires_proof, created_at: iso(now()) });
      db.tasks.push(t); broadcast('tasks', t);
      return clone(t);
    },
    complete_task({ p_task_id, p_proof_path = null }) {
      const m = me();
      const t = taskFor(m.room_id, p_task_id);
      if (t.owner_id !== m.id) fail('NOT_OWNER');
      if (t.status !== 'active') fail('TASK_NOT_ACTIVE');
      if (!(now() < ms(t.due_at))) fail('TASK_OVERDUE');
      if (p_proof_path == null) { if (t.requires_proof) fail('PROOF_REQUIRED'); }
      else {
        if (p_proof_path !== `${t.room_id}/${t.id}.jpg`) fail('BAD_PROOF_PATH');
        if (!db.storage.has(p_proof_path)) fail('PROOF_MISSING');
      }
      Object.assign(t, { status: 'done', completed_at: iso(now()), proof_path: p_proof_path });
      broadcast('tasks', t);
      return clone(t);
    },
    abandon_task({ p_task_id }) {
      const m = me();
      const t = taskFor(m.room_id, p_task_id);
      if (t.owner_id !== m.id) fail('NOT_OWNER');
      if (t.status !== 'active') fail('TASK_NOT_ACTIVE');
      if (ms(t.due_at) <= now()) fail('TASK_OVERDUE');
      Object.assign(t, { status: 'abandoned', abandoned_at: iso(now()) });
      broadcast('tasks', t);
      return clone(t);
    },
    delete_task({ p_task_id }) {
      const m = me();
      const t = taskFor(m.room_id, p_task_id);
      if (t.owner_id !== m.id) fail('NOT_OWNER');
      if (t.status !== 'active') fail('TASK_NOT_ACTIVE');
      if (now() > ms(t.created_at) + 5 * MIN) fail('DELETE_WINDOW_PASSED');
      t.deleted_at = iso(now());
      broadcast('tasks', t);
      return clone(t);
    },
    dispute_task({ p_task_id, p_disputed }) {
      const m = me();
      const t = taskFor(m.room_id, p_task_id);
      if (t.owner_id === m.id) fail('NOT_ALLOWED');
      if (t.status !== 'done') fail('TASK_NOT_DONE');
      t.disputed = !!p_disputed;
      t.disputed_at = t.disputed ? (t.disputed_at || iso(now())) : null;
      broadcast('tasks', t);
      return clone(t);
    },

    propose_settlement() {
      const m = me();
      expireStale(m.room_id);
      if (!partnerOf(m)) fail('NO_PARTNER');
      if (db.settlements.some((s) => s.room_id === m.room_id && s.status === 'pending')) fail('SETTLEMENT_PENDING');
      if (totalNetSlot1(m.room_id) === 0) fail('NOTHING_TO_SETTLE');
      const s = { id: uuid(), room_id: m.room_id, proposed_by: m.id, status: 'pending', amount_slot1_net: null, proposed_at: iso(now()), confirmed_at: null, responded_by: null, undone_at: null };
      db.settlements.push(s); broadcast('settlements', s);
      return clone(s);
    },
    respond_settlement({ p_id, p_accept }) {
      const m = me();
      expireStale(m.room_id);
      const s = db.settlements.find((x) => x.id === p_id && x.room_id === m.room_id) || fail('SETTLEMENT_NOT_FOUND');
      if (s.status !== 'pending') fail('SETTLEMENT_NOT_PENDING');
      if (s.proposed_by === m.id) fail('NOT_ALLOWED');
      if (p_accept) Object.assign(s, { status: 'confirmed', amount_slot1_net: totalNetSlot1(m.room_id), confirmed_at: iso(now()), responded_by: m.id });
      else Object.assign(s, { status: 'rejected', responded_by: m.id });
      broadcast('settlements', s);
      return clone(s);
    },
    undo_settlement({ p_id }) {
      const m = me();
      const s = db.settlements.find((x) => x.id === p_id && x.room_id === m.room_id) || fail('SETTLEMENT_NOT_FOUND');
      if (s.status !== 'confirmed') fail('SETTLEMENT_NOT_CONFIRMED');
      if (db.settlements.some((x) => x.room_id === s.room_id && x.status === 'confirmed' && ms(x.confirmed_at) > ms(s.confirmed_at))) fail('NOT_LATEST_SETTLEMENT');
      if (now() > ms(s.confirmed_at) + DAY) fail('UNDO_WINDOW_PASSED');
      Object.assign(s, { status: 'undone', undone_at: iso(now()) });
      broadcast('settlements', s);
      return clone(s);
    },
    update_settings(args) {
      const { p_display_name = null, p_daily_reminder_time = null, p_daily_reminder_enabled } = args;
      db.settingsCalls.push(clone(args));
      // Pre-batch-2 server: PostgREST finds no function with this parameter.
      if (p_daily_reminder_enabled !== undefined && !batch2) fail('UNKNOWN');
      const m = me();
      if (p_daily_reminder_enabled != null) m.daily_reminder_enabled = !!p_daily_reminder_enabled;
      if (p_display_name != null) {
        const n = p_display_name.trim();
        if (n.length < 1 || n.length > 6) fail('BAD_NAME');
        m.display_name = n; broadcast('members', m);
      }
      if (p_daily_reminder_time != null) {
        const [hh, mm] = String(p_daily_reminder_time).split(':');
        roomOf(m.room_id).daily_reminder_time = `${hh.padStart(2, '0')}:${(mm || '00').padStart(2, '0')}:00`;
      }
      return getState();
    },
    save_push_subscription() { me(); return uuid(); },
    remove_push_subscription() { me(); return null; },
  };

  const net = async () => {
    await sleep(110 + Math.random() * 140);
    if (offline) throw new AppError('NETWORK');
  };

  return {
    mode: 'mock',
    db,
    async hasSession() { return !!uid; },
    async signIn() { await net(); uid ||= uuid(); },
    async rpc(name, args) {
      await net();
      const fn = RPC[name];
      if (!fn) throw new AppError('UNKNOWN');
      return clone(fn(args || {}));
    },
    async activeTasks() {
      await net();
      const m = me();
      return clone(roomTasks(m.room_id).filter((t) => t.status === 'active').sort((a, b) => ms(a.due_at) - ms(b.due_at)));
    },
    async upload(path, blob) {
      await net();
      const m = me();
      if (!blob || blob.type !== 'image/jpeg') fail('UPLOAD_FAILED');
      if (blob.size > 307200) fail('PROOF_TOO_BIG');
      const [rid, file] = path.split('/');
      const t = db.tasks.find((x) => `${x.id}.jpg` === file && x.room_id === rid);
      if (rid !== m.room_id || !t || t.owner_id !== m.id || t.status !== 'active' || t.deleted_at) fail('PERMISSION');
      db.storage.set(path, blob);
    },
    async signedUrl(path) {
      await net();
      let b = db.storage.get(path);
      if (!b && seededProofs.has(path)) { b = await fakePhoto(); db.storage.set(path, b); }
      if (!b) fail('PERMISSION');
      return URL.createObjectURL(b);
    },
    async pushRows() { await net(); return []; },
    async memberId() { return uid; },
    openChannel(roomId, onChange, onStatus) {
      const ch = { roomId, onChange, onStatus, alive: true };
      setTimeout(() => {
        if (!ch.alive) return;
        if (offline) { ch.alive = false; onStatus('CHANNEL_ERROR'); return; }
        channels.add(ch); onStatus('SUBSCRIBED');
      }, 150);
      return () => { ch.alive = false; channels.delete(ch); };
    },

    // ---------- test hooks (wired into window.__studybet by app.js) ----------
    hooks: {
      setOffline(on) { offline = !!on; if (offline) dropChannels(); },
      dropRealtime: dropChannels,
      partnerComplete(value = 20) {
        const m = memberOf(uid);
        const p = m && partnerOf(m);
        if (!p) return null;
        const v = Math.min(50, Math.max(1, Math.round(value)));
        const t = task({ room_id: m.room_id, owner_id: p.id, title: `${p.display_name} 的模擬任務`, value: v, status: 'done', created_at: iso(now() - H), completed_at: iso(now()), due_at: iso(now() + H) });
        db.tasks.push(t); broadcast('tasks', t);
        return clone(t);
      },
      partnerPropose() {
        const m = memberOf(uid);
        const p = m && partnerOf(m);
        if (!p || db.settlements.some((s) => s.room_id === m.room_id && s.status === 'pending') || totalNetSlot1(m.room_id) === 0) return null;
        const s = { id: uuid(), room_id: m.room_id, proposed_by: p.id, status: 'pending', amount_slot1_net: null, proposed_at: iso(now()), confirmed_at: null, responded_by: null, undone_at: null };
        db.settlements.push(s); broadcast('settlements', s);
        return clone(s);
      },
      partnerRespond(accept = true) {
        const m = memberOf(uid);
        const p = m && partnerOf(m);
        const s = m && db.settlements.find((x) => x.room_id === m.room_id && x.status === 'pending' && x.proposed_by === m.id);
        if (!s) return null;
        if (accept) Object.assign(s, { status: 'confirmed', amount_slot1_net: totalNetSlot1(m.room_id), confirmed_at: iso(now()), responded_by: p.id });
        else Object.assign(s, { status: 'rejected', responded_by: p.id });
        broadcast('settlements', s);
        return clone(s);
      },
    },
  };
}
