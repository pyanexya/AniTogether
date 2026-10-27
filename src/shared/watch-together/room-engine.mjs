/* In-memory authoritative relay. No media URLs, account tokens or persistence. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { VERSION, MAX_MESSAGE_BYTES, isRoomId, isToken, normalizeName, normalizePlayback, normalizeMedia, projectedPosition } from './protocol.mjs';
const secret = () => randomBytes(24).toString('hex');
const equal = (a, b) => isToken(a) && isToken(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class RoomEngine {
  constructor({ now = () => Date.now(), maxRooms = 128, maxMembers = 8, maxAge = 6 * 60 * 60_000, idleTime = 30 * 60_000 } = {}) {
    this.now = now; this.maxRooms = maxRooms; this.maxMembers = maxMembers; this.maxAge = maxAge; this.idleTime = idleTime;
    this.rooms = new Map(); this.sessions = new Map(); this.limits = new Map(); this.blocked = new WeakSet();
  }
  send(peer, message) {
    // Bound per-socket output even when a peer stops reading.
    if (Number.isFinite(peer.bufferedAmount) && peer.bufferedAmount > 64 * 1024) {
      this.blocked.add(peer); this.disconnect(peer);
      try { peer.terminate?.(); } catch {}
      return;
    }
    try { peer.send(JSON.stringify({ v: VERSION, ...message })); } catch {}
  }
  error(peer, code) { this.send(peer, { type: 'error', code }); }
  receive(peer, raw) {
    if (this.blocked.has(peer)) return;
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return this.error(peer, 'INVALID_MESSAGE');
      const time = this.now();
      let limit = this.limits.get(peer);
      if (!limit || time - limit.start >= 10_000) this.limits.set(peer, limit = { start: time, count: 0 });
      if (++limit.count > 80) {
        if (limit.count === 81) this.error(peer, 'RATE_LIMITED');
        if (limit.count >= 84) { this.blocked.add(peer); this.disconnect(peer); try { peer.terminate?.(); } catch {} }
        return;
      }
      const msg = JSON.parse(raw);
      if (!msg || msg.v !== VERSION) return this.error(peer, 'VERSION_MISMATCH');
      if (msg.type === 'ping') {
        if (!Number.isFinite(msg.sentAt)) return this.error(peer, 'INVALID_MESSAGE');
        return this.send(peer, { type: 'pong', sentAt: msg.sentAt, serverNow: time });
      }
      if (msg.type === 'leave') return this.leave(peer);
      if (['create', 'join', 'resume'].includes(msg.type) && this.sessions.has(peer)) return this.error(peer, 'ALREADY_JOINED');
      if (msg.type === 'create') {
        if (this.rooms.size >= this.maxRooms) return this.error(peer, 'SERVER_FULL');
        const media = normalizeMedia(msg.media);
        const id = randomBytes(6).toString('hex');
        const room = { id, invite: secret(), created: time, touched: time, members: new Map(), state: { media, position: 0, paused: true, buffering: false, rate: 1, sequence: 0, epoch: randomBytes(12).toString('hex'), updatedAt: time, hostOnline: true } };
        this.rooms.set(id, room);
        return this.add(peer, room, 'host', msg.name);
      }
      if (msg.type === 'join') {
        const room = isRoomId(msg.roomId) && this.rooms.get(msg.roomId);
        if (!room || !equal(room.invite, msg.inviteToken)) return this.error(peer, 'ROOM_UNAVAILABLE');
        if (room.members.size >= this.maxMembers) return this.error(peer, 'ROOM_FULL');
        return this.add(peer, room, 'guest', msg.name);
      }
      if (msg.type === 'resume') {
        const room = isRoomId(msg.roomId) && this.rooms.get(msg.roomId);
        const member = room && isToken(msg.memberToken) && [...room.members.values()].find(m => equal(m.token, msg.memberToken));
        if (!member) return this.error(peer, 'ROOM_UNAVAILABLE');
        if (member.peer && member.peer !== peer) { this.sessions.delete(member.peer); this.send(member.peer, { type: 'replaced' }); }
        member.peer = peer; member.disconnectedAt = null; room.touched = time;
        this.sessions.set(peer, { room, member });
        if (member.role === 'host') this.update(room, { hostOnline: true });
        this.welcome(peer, room, member); this.broadcast(room); return;
      }
      const session = this.sessions.get(peer);
      if (!session) return this.error(peer, 'NOT_JOINED');
      const { room, member } = session;
      room.touched = time;
      if (msg.type === 'control') {
        if (member.role !== 'host') return this.error(peer, 'HOST_ONLY');
        if (msg.epoch !== room.state.epoch || !Number.isSafeInteger(msg.commandSequence) || msg.commandSequence <= member.commandSequence) return this.error(peer, 'STALE_COMMAND');
        const state = normalizePlayback(msg.state);
        member.commandSequence = msg.commandSequence;
        this.update(room, state); this.broadcast(room); return;
      }
      if (msg.type === 'snapshot') return this.send(peer, { type: 'state', state: room.state, serverNow: time, members: this.publicMembers(room) });
      this.error(peer, 'INVALID_MESSAGE');
    } catch { this.error(peer, 'INVALID_MESSAGE'); }
  }
  add(peer, room, role, name) {
    const member = { id: randomBytes(6).toString('hex'), token: secret(), name: normalizeName(name), role, peer, commandSequence: 0, disconnectedAt: null };
    room.members.set(member.id, member); room.touched = this.now();
    this.sessions.set(peer, { room, member }); this.welcome(peer, room, member); this.broadcast(room);
  }
  welcome(peer, room, member) {
    this.send(peer, { type: 'welcome', roomId: room.id, memberId: member.id, memberToken: member.token, role: member.role, ...(member.role === 'host' ? { inviteToken: room.invite } : {}), commandSequence: member.commandSequence, state: room.state, serverNow: this.now(), members: this.publicMembers(room) });
  }
  publicMembers(room) { return [...room.members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, online: !!m.peer })); }
  update(room, changes) {
    const time = this.now();
    room.state = { ...room.state, position: projectedPosition(room.state, time), ...changes, sequence: room.state.sequence + 1, updatedAt: time };
  }
  broadcast(room) {
    const message = { type: 'state', state: room.state, serverNow: this.now(), members: this.publicMembers(room) };
    for (const member of room.members.values()) if (member.peer) this.send(member.peer, message);
  }
  disconnect(peer) {
    this.limits.delete(peer);
    const session = this.sessions.get(peer); this.sessions.delete(peer);
    if (!session || session.member.peer !== peer) return;
    const { room, member } = session; member.peer = null; member.disconnectedAt = this.now();
    if (member.role === 'host') this.update(room, { paused: true, buffering: false, hostOnline: false });
    this.broadcast(room);
  }
  leave(peer) {
    const session = this.sessions.get(peer);
    if (!session) return;
    const { room, member } = session;
    this.sessions.delete(peer); member.peer = null;
    if (member.role === 'host') return this.destroy(room, 'HOST_LEFT');
    room.members.delete(member.id); this.broadcast(room);
    this.send(peer, { type: 'left' });
  }
  destroy(room, reason) {
    for (const member of room.members.values()) if (member.peer) { this.send(member.peer, { type: 'closed', reason }); this.sessions.delete(member.peer); }
    this.rooms.delete(room.id);
  }
  sweep() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (now - room.created > this.maxAge || now - room.touched > this.idleTime) { this.destroy(room, 'EXPIRED'); continue; }
      for (const member of room.members.values()) if (member.role === 'guest' && member.disconnectedAt != null && now - member.disconnectedAt > 2 * 60_000) room.members.delete(member.id);
    }
  }
}
