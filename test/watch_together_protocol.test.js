import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoomEngine } from '../src/shared/watch-together/room-engine.mjs';
import { normalizeMedia, normalizePlayback, sameMedia, validateServerUrl, projectedPosition } from '../src/shared/watch-together/protocol.mjs';
import { WatchTogetherClient, parseInvitation } from '../src/shared/watch-together/client.mjs';
import { attachMediaSync } from '../src/shared/watch-together/media-sync.mjs';
const media = { releaseId: 50, episodePosition: 1, sourceId: 20, dubberId: 30 };
const playback = { media, position: 10, paused: false, buffering: false, rate: 1 };
const peer = () => ({ messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } });
const send = (engine, socket, value) => engine.receive(socket, JSON.stringify({ v: 1, ...value }));
const welcome = socket => socket.messages.find(m => m.type === 'welcome');
function setup(options) { const engine = new RoomEngine(options); const host = peer(); send(engine, host, { type: 'create', media, name: 'Host' }); return { engine, host, auth: welcome(host) }; }
function join(engine, auth) { const guest = peer(); send(engine, guest, { type: 'join', roomId: auth.roomId, inviteToken: auth.inviteToken, name: 'Guest' }); return guest; }
describe('real room engine and protocol', () => {
  it('keeps only minimal validated media fields', () => expect(normalizeMedia({ ...media, url: 'secret', token: 'private' })).toEqual(media));
  it('rejects incomplete, nonnumeric and nonfinite identities', () => { for (const value of [{}, { ...media, releaseId: '50' }, { ...media, dubberId: null }, { ...media, episodePosition: Infinity }]) expect(() => normalizeMedia(value)).toThrow(); });
  it('distinguishes dubbers and sources', () => { expect(sameMedia(media, { ...media, dubberId: 31 })).toBe(false); expect(sameMedia(media, { ...media, sourceId: 21 })).toBe(false); });
  it('rejects malformed timelines', () => { for (const state of [{ ...playback, position: NaN }, { ...playback, rate: 99 }, { ...playback, paused: 'false' }]) expect(() => normalizePlayback(state)).toThrow(); });
  it('requires TLS except loopback and excludes credentials/query', () => { expect(validateServerUrl('ws://localhost:8787/watch')).toBe('ws://localhost:8787/watch'); expect(validateServerUrl('wss://example.org/watch')).toBe('wss://example.org/watch'); for (const value of ['https://example.org', 'ws://example.org', 'wss://x:y@example.org', 'wss://example.org/?token=x']) expect(() => validateServerUrl(value)).toThrow(); });
  it('projects playing but not paused or buffering position', () => { expect(projectedPosition({ ...playback, updatedAt: 1000 }, 3000)).toBe(12); expect(projectedPosition({ ...playback, buffering: true, updatedAt: 1000 }, 3000)).toBe(10); });
  it('requires secret invitation and never shares member tokens in snapshots', () => { const { engine, auth } = setup(); const bad = peer(); send(engine, bad, { type: 'join', roomId: auth.roomId, inviteToken: '0'.repeat(48) }); expect(bad.messages.at(-1).code).toBe('ROOM_UNAVAILABLE'); const guest = join(engine, auth); expect(welcome(guest).role).toBe('guest'); expect(welcome(guest).inviteToken).toBeUndefined(); expect(JSON.stringify(guest.messages.filter(m => m.type === 'state'))).not.toContain(auth.memberToken); });
  it('only host may control; rejects duplicate/out-of-epoch commands', () => { const { engine, host, auth } = setup(); const guest = join(engine, auth); const control = { type: 'control', epoch: auth.state.epoch, commandSequence: 1, state: playback }; send(engine, guest, control); expect(guest.messages.at(-1).code).toBe('HOST_ONLY'); send(engine, host, control); expect(guest.messages.at(-1).state.position).toBe(10); send(engine, host, control); expect(host.messages.at(-1).code).toBe('STALE_COMMAND'); send(engine, host, { ...control, epoch: '0'.repeat(24), commandSequence: 2 }); expect(host.messages.at(-1).code).toBe('STALE_COMMAND'); });
  it('pauses when host disconnects and resumes membership with latest sequence', () => { let time = 1000; const { engine, host, auth } = setup({ now: () => time }); const guest = join(engine, auth); send(engine, host, { type: 'control', epoch: auth.state.epoch, commandSequence: 7, state: playback }); time = 3000; engine.disconnect(host); expect(guest.messages.at(-1).state).toMatchObject({ position: 12, paused: true, hostOnline: false }); const reconnect = peer(); send(engine, reconnect, { type: 'resume', roomId: auth.roomId, memberToken: auth.memberToken }); expect(welcome(reconnect)).toMatchObject({ role: 'host', commandSequence: 7, state: { position: 12, paused: true, hostOnline: true } }); });
  it('host leaving closes room for everyone', () => { const { engine, host, auth } = setup(); const guest = join(engine, auth); send(engine, host, { type: 'leave' }); expect(guest.messages.at(-1)).toMatchObject({ type: 'closed', reason: 'HOST_LEFT' }); expect(engine.rooms.size).toBe(0); });
  it('caps membership and releases disconnected guest slots', () => { let time = 0; const { engine, auth } = setup({ now: () => time, maxMembers: 2 }); const guest = join(engine, auth); expect(join(engine, auth).messages.at(-1).code).toBe('ROOM_FULL'); engine.disconnect(guest); time = 120001; engine.sweep(); expect(welcome(join(engine, auth)).role).toBe('guest'); });
  it('expires abandoned rooms', () => { let time = 0; const { engine } = setup({ now: () => time, idleTime: 1000 }); time = 1001; engine.sweep(); expect(engine.rooms.size).toBe(0); });
  it('rate and payload bounds apply before parsing', () => { const { engine } = setup(); const guest = peer(); engine.receive(guest, 'x'.repeat(4097)); expect(guest.messages.at(-1).code).toBe('INVALID_MESSAGE'); for (let i = 0; i < 81; i++) send(engine, guest, { type: 'ping', sentAt: i }); expect(guest.messages.at(-1).code).toBe('RATE_LIMITED'); });
  it('does not reset rate limits by creating and leaving rooms', () => {
    const engine = new RoomEngine(); const socket = peer(); socket.terminate = vi.fn();
    for (let i = 0; i < 50; i++) { send(engine, socket, { type: 'create', media }); send(engine, socket, { type: 'leave' }); }
    expect(socket.messages.filter(m => m.type === 'welcome')).toHaveLength(40);
    expect(socket.messages.filter(m => m.code === 'RATE_LIMITED')).toHaveLength(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(engine.rooms.size).toBe(0);
  });
  it('disconnects a slow consumer and bounds queued output', () => {
    const { engine, host, auth } = setup(); const guest = join(engine, auth);
    guest.bufferedAmount = 65537; guest.terminate = vi.fn(); const count = guest.messages.length;
    send(engine, host, { type: 'control', epoch: auth.state.epoch, commandSequence: 1, state: playback });
    expect(guest.terminate).toHaveBeenCalledOnce(); expect(guest.messages).toHaveLength(count);
    send(engine, guest, { type: 'create', media }); expect(guest.messages).toHaveLength(count);
    expect(engine.sessions.has(guest)).toBe(false);
  });
  it('rejects unrelated invitation schemes', () => { expect(() => parseInvitation('https://malicious.invalid/')).toThrow(); expect(() => parseInvitation('AnixArtix:bad')).toThrow(); });
});
class FakeVideo extends EventTarget {
  constructor() { super(); this.currentTime = 0; this.playbackRate = 1; this.paused = true; this.ended = false; this.readyState = 4; this.duration = 500; this.seeking = false; }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
}
function mockClient(role = 'guest') {
  let callback;
  const client = { view: { role, status: 'connected', snapshot: { ...playback, sequence: 1, epoch: 'a'.repeat(24), updatedAt: 1000, hostOnline: true } }, serverNow: () => 1000, publish: vi.fn(), requestSnapshot: vi.fn(), subscribe(fn) { callback = fn; fn(this.view); return () => { callback = null; }; }, update(patch) { this.view = { ...this.view, ...patch }; callback?.(this.view); } };
  return client;
}
afterEach(() => vi.useRealTimers());
describe('media binding', () => {
  it('applies host timeline without guest broadcasts', async () => { vi.useFakeTimers(); const client = mockClient(), video = new FakeVideo(); const binding = attachMediaSync({ client, video, getMedia: () => media }); await Promise.resolve(); expect(video.currentTime).toBe(10); expect(video.paused).toBe(false); expect(client.publish).not.toHaveBeenCalled(); binding.destroy(); });
  it('does not load a URL or apply mismatching source; notifies only once', () => { vi.useFakeTimers(); const client = mockClient(), video = new FakeVideo(), onMismatch = vi.fn(); const binding = attachMediaSync({ client, video, getMedia: () => ({ ...media, dubberId: 31 }), onMismatch }); vi.advanceTimersByTime(6000); expect(onMismatch).toHaveBeenCalledTimes(1); expect(video.currentTime).toBe(0); expect(video.paused).toBe(true); binding.destroy(); });
  it('does not publish host identity during media loading or suspension', () => { vi.useFakeTimers(); const client = mockClient('host'), video = new FakeVideo(); let identity = null; const binding = attachMediaSync({ client, video, getMedia: () => identity }); vi.advanceTimersByTime(2100); expect(client.publish).not.toHaveBeenCalled(); identity = media; binding.suspend(); const count = client.publish.mock.calls.length; vi.advanceTimersByTime(4100); expect(client.publish).toHaveBeenCalledTimes(count); binding.refresh(); expect(client.publish.mock.calls.length).toBe(count + 1); binding.destroy(); });
  it('pauses guests on disconnect or closed session', () => { vi.useFakeTimers(); const client = mockClient(), video = new FakeVideo(); const binding = attachMediaSync({ client, video, getMedia: () => media }); client.update({ status: 'closed', role: null }); expect(video.paused).toBe(true); binding.destroy(); });
  it('restores guest rate after leave and does not schedule timers after teardown', async () => {
    vi.useFakeTimers(); const client = mockClient(), video = new FakeVideo(); video.playbackRate = 1.5;
    let resolvePlay; video.play = () => new Promise(resolve => { resolvePlay = resolve; });
    const binding = attachMediaSync({ client, video, getMedia: () => media });
    expect(video.playbackRate).not.toBe(1.5); client.update({ status: 'idle', role: null, snapshot: null });
    expect(video.playbackRate).toBe(1.5); binding.destroy(); resolvePlay(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports autoplay block instead of claiming synced playback', async () => { vi.useFakeTimers(); const client = mockClient(), video = new FakeVideo(), onAutoplayBlocked = vi.fn(); video.play = async () => { const error = new Error(); error.name = 'NotAllowedError'; throw error; }; const binding = attachMediaSync({ client, video, getMedia: () => media, onAutoplayBlocked }); await Promise.resolve(); await Promise.resolve(); expect(onAutoplayBlocked).toHaveBeenCalledOnce(); expect(video.paused).toBe(true); binding.destroy(); });
});
