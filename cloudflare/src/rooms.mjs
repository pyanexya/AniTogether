/* AnixArtix watch-together relay. GPL-2.0; see ../../LICENSE.
 * Single named SQLite Durable Object preserves the native /watch v1 handshake.
 * No media URLs, account credentials or video bytes are accepted or forwarded.
 */
import { VERSION, MAX_MESSAGE_BYTES, isRoomId, isToken, normalizeName, normalizeMedia, normalizePlayback, projectedPosition } from '../../src/shared/watch-together/protocol.mjs';
const hex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => { if (!isToken(a) || !isToken(b)) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; };
export const ROOM_LIMITS = Object.freeze({ rooms: 128, members: 8, sockets: 128, age: 21600000, idle: 1800000, reconnect: 120000, handshake: 30000, socketIdle: 90000 });
const validClientKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
const boundedLimit = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max ? Number(value) : fallback;
export class WatchRooms {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.rooms = new Map(); this.sockets = new Map(); this.quotas = new Map();
    this.clientLimits = { sockets: boundedLimit(env.ROOM_CLIENT_SOCKETS, 16, 64), creates: boundedLimit(env.ROOM_CLIENT_CREATES_PER_HOUR, 8, 64), opens: boundedLimit(env.ROOM_CLIENT_OPENS_PER_HOUR, 128, 1024) };
    ctx.blockConcurrencyWhile(async () => {
      this.rooms = await ctx.storage.list({ prefix: 'room:' });
      this.rooms = new Map([...this.rooms.values()].map(room => [room.id, room]));
      this.quotas = new Map([...(await ctx.storage.list({ prefix: 'quota:' })).values()].map(q => [q.key, q]));
      for (const ws of ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a?.id && !a.closed) this.sockets.set(a.id, ws); }
      // Hibernation retains sockets. A full runtime restart may not: mark lost members offline.
      this.dirty = new Set(); this.deleted = new Set(); this.quotaDirty = new Set(); this.quotaDeleted = new Set(); this.outbox = [];
      for (const room of this.rooms.values()) for (const member of room.members) if (member.connection && !this.sockets.has(member.connection)) this.detach(room, member);
      await this.commit();
    });
  }
  async fetch(request) {
    return this.event(async () => {
      const url = new URL(request.url);
      if (url.pathname === '/internal/friend-invite' && request.method === 'POST') {
        let data; try { data = await request.json(); } catch { return new Response(null, {status:400}); }
        const room = isRoomId(data?.roomId) && this.rooms.get(data.roomId);
        const host = room?.members.find(m => m.role === 'host');
        if (!host || !host.connection || !equal(host.token, data.hostToken)) return new Response(null, {status:404});
        return Response.json({inviteToken:room.invite}, {headers:{'Cache-Control':'no-store'}});
      }

      const allowed = new Set(['http://tauri.localhost', 'tauri://localhost', this.env.APP_ORIGIN || 'https://aniartix.pyanexy.cc']);
      if (url.pathname !== '/watch' || url.search || request.method !== 'GET' || !allowed.has(request.headers.get('Origin'))) return new Response('Forbidden', { status: 403 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
      const clientKey = request.headers.get('X-AnixArtix-Client-Key');
      // Internal header is overwritten by the only public entrypoint, using platform client IP.
      if (!validClientKey(clientKey)) return new Response('Client identity unavailable', { status: 503 });
      const active = [...this.sockets.values()].filter(ws => ws.deserializeAttachment()?.clientKey === clientKey).length;
      if (active >= this.clientLimits.sockets) return new Response('Client connection limit', { status: 429 });
      if (this.sockets.size >= ROOM_LIMITS.sockets) return new Response('Relay full', { status: 503 });
      if (!this.quota(clientKey, 'opens', this.clientLimits.opens)) return new Response('Client connection rate limit', { status: 429 });
      const [client, server] = Object.values(new WebSocketPair());
      const now = Date.now(); const attachment = { id: hex(12), clientKey, start: now, count: 0, connected: now, last: now, joined: false, closed: false };
      server.serializeAttachment(attachment); this.ctx.acceptWebSocket(server); this.sockets.set(attachment.id, server);
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now + 30000);
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async event(fn) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.dirty = new Set(); this.deleted = new Set(); this.quotaDirty = new Set(); this.quotaDeleted = new Set(); this.outbox = [];
      this.sweep(); const result = await fn(); await this.commit(); return result;
    });
  }
  async commit() {
    await this.ctx.storage.transaction(async tx => {
      for (const id of this.deleted) await tx.delete(`room:${id}`);
      for (const key of this.quotaDeleted) await tx.delete(`quota:${key}`);
      for (const key of this.quotaDirty) if (this.quotas.has(key)) await tx.put(`quota:${key}`, this.quotas.get(key));
      for (const id of this.dirty) if (this.rooms.has(id)) await tx.put(`room:${id}`, this.rooms.get(id));
      if (this.rooms.size || this.sockets.size || this.quotas.size) await tx.setAlarm(Date.now() + 30000);
      else await tx.deleteAlarm();
    });
    // Never acknowledge a command before its state is durably committed.
    for (const [ws, msg] of this.outbox) { try { ws.send(JSON.stringify({ v: VERSION, ...msg })); } catch { /* close/error event performs durable cleanup */ } }
    this.outbox = [];
  }
  quota(key, kind, limit) {
    if (!validClientKey(key)) return false;
    const now = Date.now(); let q = this.quotas.get(key);
    if (!q || now >= q.expires) {
      if (!q && this.quotas.size >= 2048) return false; // Fail closed, never an unbounded attacker-controlled map.
      q = { key, opens: 0, creates: 0, expires: now + 3600000 }; this.quotas.set(key, q);
    }
    if (q[kind] >= limit) return false;
    q[kind]++; this.quotaDirty.add(key); return true;
  }
  send(ws, message) { this.outbox.push([ws, message]); }
  error(ws, code) { this.send(ws, { type: 'error', code }); }
  session(ws) { const id = ws.deserializeAttachment()?.id; for (const room of this.rooms.values()) { const member = room.members.find(m => m.connection === id); if (member) return { room, member }; } return null; }
  touch(room) { room.touched = Date.now(); this.dirty.add(room.id); }
  update(room, changes) { const now = Date.now(); room.state = { ...room.state, position: projectedPosition(room.state, now), ...changes, sequence: room.state.sequence + 1, updatedAt: now }; this.dirty.add(room.id); }
  publicMembers(room) { return room.members.map(m => ({ id: m.id, name: m.name, role: m.role, online: !!m.connection })); }
  broadcast(room) { const message = { type: 'state', state: room.state, members: this.publicMembers(room), serverNow: Date.now() }; for (const m of room.members) { const ws = this.sockets.get(m.connection); if (ws) this.send(ws, message); } }
  welcome(ws, room, member) { this.send(ws, { type: 'welcome', roomId: room.id, memberId: member.id, memberToken: member.token, role: member.role, ...(member.role === 'host' ? { inviteToken: room.invite } : {}), commandSequence: member.commandSequence, state: room.state, members: this.publicMembers(room), serverNow: Date.now() }); }
  bind(ws, room, member) {
    const a = ws.deserializeAttachment(); a.joined = true; ws.serializeAttachment(a);
    member.connection = a.id; member.disconnectedAt = null; this.touch(room);
  }
  add(ws, room, role, name) { const member = { id: hex(6), token: hex(24), name: normalizeName(name), role, commandSequence: 0, connection: null, disconnectedAt: null }; room.members.push(member); this.bind(ws, room, member); this.welcome(ws, room, member); this.broadcast(room); }
  webSocketMessage(ws, raw) {
    return this.event(() => {
      const a = ws.deserializeAttachment(); if (!a || a.closed) return;
      const now = Date.now(); a.last = now;
      if (now - a.start >= 10000) { a.start = now; a.count = 0; }
      a.count++; ws.serializeAttachment(a); // survives hibernation, including invalid-message floods
      if (a.count > 80) { if (a.count === 81) this.error(ws, 'RATE_LIMITED'); if (a.count >= 84) this.close(ws, 1008, 'Rate limit'); return; }
      if (typeof raw !== 'string') return this.close(ws, 1003, 'Text required');
      if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return this.close(ws, 1009, 'Message too large');
      let msg; try { msg = JSON.parse(raw); } catch { return this.error(ws, 'INVALID_MESSAGE'); }
      if (!msg || msg.v !== VERSION) return this.error(ws, 'VERSION_MISMATCH');
      try { this.receive(ws, msg); } catch { this.error(ws, 'INVALID_MESSAGE'); }
    });
  }
  receive(ws, msg) {
    const session = this.session(ws);
    if (msg.type === 'ping') { if (!Number.isFinite(msg.sentAt)) return this.error(ws, 'INVALID_MESSAGE'); return this.send(ws, { type: 'pong', sentAt: msg.sentAt, serverNow: Date.now() }); }
    if (msg.type === 'leave') { if (!session) return; const { room, member } = session; member.connection = null; if (member.role === 'host') return this.destroy(room, 'HOST_LEFT'); room.members = room.members.filter(m => m !== member); this.dirty.add(room.id); this.broadcast(room); this.send(ws, { type: 'left' }); return; }
    if (['create', 'join', 'resume'].includes(msg.type) && session) return this.error(ws, 'ALREADY_JOINED');
    if (msg.type === 'create') {
      if (this.rooms.size >= ROOM_LIMITS.rooms) return this.error(ws, 'SERVER_FULL');
      const media = normalizeMedia(msg.media);
      if (!this.quota(ws.deserializeAttachment()?.clientKey, 'creates', this.clientLimits.creates)) return this.error(ws, 'RATE_LIMITED');
      let id; do { id = hex(6); } while (this.rooms.has(id)); const now = Date.now();
      const room = { id, invite: hex(24), created: now, touched: now, members: [], state: { media, position: 0, paused: true, buffering: false, rate: 1, sequence: 0, epoch: hex(12), updatedAt: now, hostOnline: true } };
      this.rooms.set(id, room); return this.add(ws, room, 'host', msg.name);
    }
    if (msg.type === 'join' || msg.type === 'resume') {
      const room = isRoomId(msg.roomId) && this.rooms.get(msg.roomId);
      if (!room) return this.error(ws, 'ROOM_UNAVAILABLE');
      if (msg.type === 'join') { if (!equal(room.invite, msg.inviteToken)) return this.error(ws, 'ROOM_UNAVAILABLE'); if (room.members.length >= ROOM_LIMITS.members) return this.error(ws, 'ROOM_FULL'); return this.add(ws, room, 'guest', msg.name); }
      const member = room.members.find(m => equal(m.token, msg.memberToken));
      if (!member) return this.error(ws, 'ROOM_UNAVAILABLE');
      const old = this.sockets.get(member.connection); if (old && old !== ws) this.send(old, { type: 'replaced' });
      this.bind(ws, room, member); if (member.role === 'host') this.update(room, { hostOnline: true }); this.welcome(ws, room, member); this.broadcast(room); return;
    }
    if (!session) return this.error(ws, 'NOT_JOINED');
    const { room, member } = session; this.touch(room);
    if (msg.type === 'control') {
      if (member.role !== 'host') return this.error(ws, 'HOST_ONLY');
      if (msg.epoch !== room.state.epoch || !Number.isSafeInteger(msg.commandSequence) || msg.commandSequence <= member.commandSequence) return this.error(ws, 'STALE_COMMAND');
      const state = normalizePlayback(msg.state); member.commandSequence = msg.commandSequence; this.update(room, state); this.broadcast(room); return;
    }
    if (msg.type === 'snapshot') return this.send(ws, { type: 'state', state: room.state, members: this.publicMembers(room), serverNow: Date.now() });
    this.error(ws, 'INVALID_MESSAGE');
  }
  detach(room, member) { member.connection = null; member.disconnectedAt = Date.now(); this.dirty.add(room.id); if (member.role === 'host') this.update(room, { paused: true, buffering: false, hostOnline: false }); this.broadcast(room); }
  disconnect(ws) { const session = this.session(ws); const a = ws.deserializeAttachment(); if (a) { this.sockets.delete(a.id); a.closed = true; ws.serializeAttachment(a); } if (session) this.detach(session.room, session.member); }
  close(ws, code, reason) { this.disconnect(ws); try { ws.close(code, reason); } catch {} }
  webSocketClose(ws, code) { return this.event(() => this.close(ws, code === 1005 || code === 1006 ? 1000 : code, 'Disconnected')); }
  webSocketError(ws) { return this.event(() => this.close(ws, 1011, 'Connection error')); }
  destroy(room, reason) { for (const member of room.members) { const ws = this.sockets.get(member.connection); if (ws) this.send(ws, { type: 'closed', reason }); } this.rooms.delete(room.id); this.deleted.add(room.id); }
  sweep() {
    const now = Date.now();
    for (const [key, q] of this.quotas) if (now >= q.expires) { this.quotas.delete(key); this.quotaDeleted.add(key); }
    for (const room of this.rooms.values()) {
      if (now - room.created >= ROOM_LIMITS.age || now - room.touched >= ROOM_LIMITS.idle) { this.destroy(room, 'EXPIRED'); continue; }
      const kept = room.members.filter(m => m.role === 'host' || m.disconnectedAt === null || now - m.disconnectedAt < ROOM_LIMITS.reconnect);
      if (kept.length !== room.members.length) { room.members = kept; this.dirty.add(room.id); this.broadcast(room); }
    }
    for (const ws of this.sockets.values()) { const a = ws.deserializeAttachment(); if (now - a.last >= ROOM_LIMITS.socketIdle || (!a.joined && now - a.connected >= ROOM_LIMITS.handshake)) this.close(ws, 1008, 'Idle connection'); }
  }
  alarm() { return this.event(() => {}); }
}
