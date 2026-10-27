import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelay } from './watch-together.mjs';
import { WatchTogetherClient, parseInvitation } from '../src/shared/watch-together/client.mjs';
const media = { releaseId: 50, episodePosition: 2, sourceId: 20, dubberId: 30 };
function until(client, predicate, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out: ${client.view.status} ${client.view.error || ''}`)); }, timeout);
    unsubscribe = client.subscribe(view => { if (predicate(view)) { clearTimeout(timer); queueMicrotask(() => unsubscribe()); resolve(view); } });
  });
}
test('real WebSocket host and guest: invitation, play, seek, buffer, reconnect, exit', async () => {
  const relay = createRelay({ port: 0 }); const address = await relay.listen();
  const serverUrl = `ws://127.0.0.1:${address.port}/watch`;
  const host = new WatchTogetherClient({ WebSocketImpl: WebSocket });
  const guest = new WatchTogetherClient({ WebSocketImpl: WebSocket });
  try {
    host.create({ serverUrl, name: 'Host', media }); await until(host, view => view.status === 'connected' && view.snapshot);
    const invitation = host.invitation(); assert.equal(parseInvitation(invitation).serverUrl, serverUrl);
    guest.joinInvitation(invitation, 'Guest'); await until(guest, view => view.status === 'connected' && view.snapshot);
    assert.equal(guest.view.role, 'guest'); assert.equal(guest.invitation(), '');
    host.publish({ media, position: 12, paused: false, buffering: false, rate: 1 });
    await until(guest, view => view.snapshot.position === 12 && !view.snapshot.paused);
    assert.equal(guest.publish({ media, position: 999, paused: true, buffering: false, rate: 1 }), false);
    host.publish({ media, position: 120, paused: true, buffering: true, rate: 1.25 });
    await until(guest, view => view.snapshot.position === 120 && view.snapshot.buffering);
    const oldToken = guest.memberToken; guest.socket.terminate();
    await until(guest, view => view.status === 'reconnecting');
    host.publish({ media: { ...media, episodePosition: 3 }, position: 0, paused: true, buffering: false, rate: 1 });
    await until(guest, view => view.status === 'connected' && view.snapshot.media.episodePosition === 3);
    assert.equal(guest.memberToken, oldToken); assert.equal(guest.view.members.length, 2);
    host.leave(); await until(guest, view => view.status === 'closed'); assert.equal(guest.view.error, 'HOST_LEFT'); assert.equal(relay.engine.rooms.size, 0);
  } finally { host.destroy(); guest.destroy(); await relay.close(); }
});

test('real host disconnect pauses guests until host reconnects and publishes', async () => {
  const relay = createRelay({ port: 0 }); const address = await relay.listen();
  const serverUrl = `ws://127.0.0.1:${address.port}/watch`;
  const host = new WatchTogetherClient({ WebSocketImpl: WebSocket });
  const guest = new WatchTogetherClient({ WebSocketImpl: WebSocket });
  try {
    host.create({ serverUrl, name: 'Host', media }); await until(host, view => view.status === 'connected' && view.snapshot);
    guest.joinInvitation(host.invitation(), 'Guest'); await until(guest, view => view.status === 'connected' && view.snapshot);
    host.publish({ media, position: 25, paused: false, buffering: false, rate: 1 });
    await until(guest, view => view.snapshot.position === 25);
    host.socket.terminate(); await until(guest, view => view.snapshot.hostOnline === false);
    assert.equal(guest.view.snapshot.paused, true);
    await until(host, view => view.status === 'connected' && view.snapshot.hostOnline);
    assert.equal(host.view.snapshot.paused, true);
    host.publish({ media, position: 30, paused: false, buffering: false, rate: 1 });
    await until(guest, view => view.snapshot.position === 30 && !view.snapshot.paused);
  } finally { host.destroy(); guest.destroy(); await relay.close(); }
});

test('real relay rejects binary and oversized messages without creating rooms', async () => {
  const relay = createRelay({ port: 0 }); const address = await relay.listen();
  const url = `ws://127.0.0.1:${address.port}/watch`;
  async function rejected(payload) {
    const socket = new WebSocket(url);
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const closed = new Promise(resolve => socket.once('close', resolve)); socket.send(payload); return await closed;
    } finally { socket.terminate(); }
  }
  try { assert.equal(await rejected(Buffer.from('binary')), 1003); assert.equal(await rejected('x'.repeat(5000)), 1009); assert.equal(relay.engine.rooms.size, 0); }
  finally { await relay.close(); }
});
