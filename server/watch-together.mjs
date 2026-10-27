import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomEngine } from '../src/shared/watch-together/room-engine.mjs';
import { MAX_MESSAGE_BYTES } from '../src/shared/watch-together/protocol.mjs';

export function createRelay({ host = '127.0.0.1', port = 8787, allowedOrigins = [], maxConnections = 128, engine = new RoomEngine() } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // A reverse proxy must terminate TLS for Internet deployment. No credentials in URLs.
    const origin = req.headers.origin;
    if (req.url !== '/watch' || wss.clients.size >= maxConnections || (allowedOrigins.length && !allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, peer => wss.emit('connection', peer, req));
  });
  wss.on('connection', peer => {
    peer.alive = true;
    peer.on('pong', () => { peer.alive = true; });
    peer.on('message', (data, binary) => { if (binary) return peer.close(1003, 'Text required'); engine.receive(peer, data.toString()); });
    peer.on('close', () => engine.disconnect(peer));
    peer.on('error', () => engine.disconnect(peer));
  });
  const heartbeat = setInterval(() => {
    engine.sweep();
    for (const peer of wss.clients) { if (!peer.alive) { peer.terminate(); continue; } peer.alive = false; peer.ping(); }
  }, 30_000);
  heartbeat.unref();
  return {
    server, wss, engine,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }),
    close: () => new Promise(resolve => { clearInterval(heartbeat); for (const peer of wss.clients) peer.terminate(); wss.close(() => server.close(resolve)); })
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const relay = createRelay({ host: process.env.HOST || '127.0.0.1', port, allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
  await relay.listen();
  console.log('AnixArtix relay ready. Playback metadata only; rooms are ephemeral.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}
