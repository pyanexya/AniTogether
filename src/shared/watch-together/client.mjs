import { VERSION, MAX_MESSAGE_BYTES, isToken, isRoomId, normalizeMedia, normalizePlayback, normalizeName, validateServerUrl, validSnapshot } from './protocol.mjs';

const INVITATION_PREFIX = 'AnixArtix:';

export function parseInvitation(text) {
  if (typeof text !== 'string' || text.length > 2048 || !text.startsWith(INVITATION_PREFIX)) throw new Error('Неверное приглашение');
  const value = JSON.parse(atob(text.slice(INVITATION_PREFIX.length)));
  if (!isRoomId(value.roomId) || !isToken(value.inviteToken)) throw new Error('Неверное приглашение');
  return { serverUrl: validateServerUrl(value.serverUrl), roomId: value.roomId, inviteToken: value.inviteToken };
}
export class WatchTogetherClient {
  constructor({ WebSocketImpl = globalThis.WebSocket, now = () => Date.now() } = {}) {
    this.WebSocketImpl = WebSocketImpl; this.now = now; this.listeners = new Set();
    this.view = { status: 'idle', role: null, roomId: null, members: [], snapshot: null, error: null };
    this.socket = null; this.generation = 0; this.offset = 0; this.commandSequence = 0; this.attempts = 0;
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.view); return () => this.listeners.delete(fn); }
  emit(patch) { this.view = { ...this.view, ...patch }; for (const fn of this.listeners) fn(this.view); }
  serverNow() { return this.now() + this.offset; }
  create({ serverUrl, name, media }) { this.begin(serverUrl, { type: 'create', name: normalizeName(name), media: normalizeMedia(media) }); }
  join({ serverUrl, name, roomId, inviteToken }) {
    if (!isRoomId(roomId) || !isToken(inviteToken)) throw new Error('Неверное приглашение');
    this.begin(serverUrl, { type: 'join', name: normalizeName(name), roomId, inviteToken });
  }
  joinInvitation(text, name) { this.join({ ...parseInvitation(text), name }); }
  begin(serverUrl, initial) {
    const url = validateServerUrl(serverUrl);
    this.leave(); this.serverUrl = url; this.initial = initial; this.attempts = 0;
    this.emit({ status: 'connecting', error: null }); this.connect();
  }
  connect() {
    const generation = ++this.generation;
    let socket;
    try { socket = new this.WebSocketImpl(this.serverUrl); } catch { this.emit({ status: 'error', error: 'CONNECTION_FAILED' }); return; }
    this.socket = socket;
    const active = () => generation === this.generation && this.socket === socket;
    this.connectTimeout = setTimeout(() => { if (active()) socket.close(); }, 12_000);
    socket.onopen = () => {
      if (!active()) return;
      clearTimeout(this.connectTimeout);
      this.send(this.memberToken ? { type: 'resume', roomId: this.view.roomId, memberToken: this.memberToken } : this.initial);
      this.ping(); this.pingTimer = setInterval(() => this.ping(), 5000);
      this.welcomeTimeout = setTimeout(() => { if (active() && this.view.status !== 'connected') socket.close(); }, 10_000);
    };
    socket.onmessage = event => {
      if (!active() || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return;
      try { this.receive(JSON.parse(event.data)); } catch { this.emit({ error: 'INVALID_SERVER_MESSAGE' }); }
    };
    socket.onerror = () => { if (active()) this.emit({ error: 'CONNECTION_FAILED' }); };
    socket.onclose = () => {
      if (!active()) return;
      clearTimeout(this.connectTimeout); clearTimeout(this.welcomeTimeout); clearInterval(this.pingTimer);
      this.socket = null;
      if (!this.memberToken || this.attempts >= 6) { this.emit({ status: 'error', error: 'DISCONNECTED' }); return; }
      this.emit({ status: 'reconnecting', error: null });
      this.retryTimer = setTimeout(() => this.connect(), Math.min(15_000, 1000 * 2 ** this.attempts++));
    };
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify({ v: VERSION, ...message })); return true; } catch { return false; }
  }
  ping() { this.lastPing = this.now(); this.send({ type: 'ping', sentAt: this.lastPing }); }
  receive(message) {
    if (!message || message.v !== VERSION) throw new Error('Invalid protocol');
    if (message.type === 'pong') {
      if (message.sentAt !== this.lastPing || !Number.isFinite(message.serverNow)) return;
      const rtt = this.now() - message.sentAt;
      if (rtt >= 0 && rtt < 10_000) this.offset = message.serverNow - (message.sentAt + rtt / 2);
      return;
    }
    if (message.type === 'welcome' || message.type === 'state') {
      if (!validSnapshot(message.state) || !Number.isFinite(message.serverNow) || !Array.isArray(message.members) || message.members.length > 8) throw new Error('Invalid snapshot');
      if (message.type === 'welcome') {
        if (!isRoomId(message.roomId) || !isToken(message.memberToken) || !['host', 'guest'].includes(message.role) || !Number.isSafeInteger(message.commandSequence) || message.commandSequence < 0) throw new Error('Invalid membership');
        if (message.role === 'host' && !isToken(message.inviteToken)) throw new Error('Invalid invitation');
        this.memberToken = message.memberToken; this.inviteToken = message.inviteToken; this.commandSequence = message.commandSequence;
        this.offset = message.serverNow - this.now(); this.attempts = 0; clearTimeout(this.welcomeTimeout);
        this.emit({ role: message.role, roomId: message.roomId, status: 'connected', error: null });
      } else if (!this.memberToken) return;
      const previous = this.view.snapshot;
      if (previous && (message.state.epoch !== previous.epoch || message.state.sequence < previous.sequence)) return;
      const members = message.members.map(m => ({ id: String(m.id).slice(0, 24), name: normalizeName(m.name), role: m.role === 'host' ? 'host' : 'guest', online: m.online === true }));
      this.emit({ snapshot: { ...normalizePlayback(message.state), epoch: message.state.epoch, sequence: message.state.sequence, updatedAt: message.state.updatedAt, hostOnline: message.state.hostOnline }, members }); return;
    }
    if (message.type === 'closed' || message.type === 'replaced') {
      const reason = message.type === 'replaced' ? 'SESSION_REPLACED' : ['HOST_LEFT', 'EXPIRED'].includes(message.reason) ? message.reason : 'ROOM_CLOSED';
      this.stopConnection(); this.memberToken = null; this.inviteToken = null;
      this.emit({ status: 'closed', error: reason, role: null, members: [] }); return;
    }
    if (message.type === 'error') {
      const known = ['INVALID_MESSAGE','VERSION_MISMATCH','RATE_LIMITED','ALREADY_JOINED','SERVER_FULL','ROOM_UNAVAILABLE','ROOM_FULL','NOT_JOINED','HOST_ONLY','STALE_COMMAND'];
      this.emit({ error: known.includes(message.code) ? message.code : 'SERVER_ERROR' });
      if (['ROOM_UNAVAILABLE','ROOM_FULL','SERVER_FULL','VERSION_MISMATCH'].includes(message.code)) { this.stopConnection(); this.emit({ status: 'error' }); }
    }
  }
  publish(state) {
    if (this.view.role !== 'host' || this.view.status !== 'connected' || !this.view.snapshot) return false;
    return this.send({ type: 'control', epoch: this.view.snapshot.epoch, commandSequence: ++this.commandSequence, state: normalizePlayback(state) });
  }
  requestSnapshot() { return this.send({ type: 'snapshot' }); }
  invitation() {
    if (this.view.role !== 'host' || !this.inviteToken) return '';
    return `${INVITATION_PREFIX}${btoa(JSON.stringify({ serverUrl: this.serverUrl, roomId: this.view.roomId, inviteToken: this.inviteToken }))}`;
  }
  stopConnection() {
    ++this.generation; clearTimeout(this.retryTimer); clearTimeout(this.connectTimeout); clearTimeout(this.welcomeTimeout); clearInterval(this.pingTimer);
    if (this.socket) { const socket = this.socket; this.socket = null; socket.onclose = socket.onmessage = socket.onopen = socket.onerror = null; try { socket.close(); } catch {} }
  }
  leave() {
    this.send({ type: 'leave' }); this.stopConnection(); this.memberToken = null; this.inviteToken = null; this.initial = null;
    this.emit({ status: 'idle', role: null, roomId: null, members: [], snapshot: null, error: null });
  }
  destroy() { this.leave(); this.listeners.clear(); }
}
