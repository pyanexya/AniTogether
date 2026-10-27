# AnixArtix relay

A small, self-hosted WebSocket coordination service. It transmits only canonical
release/episode/source/dubber identifiers, playback position, rate, pause/buffering
state and user-chosen display names. Each participant fetches the video through
its own client and account. The relay never receives or retransmits video,
streaming URLs, Anixart credentials or account tokens.

## Local test

Node.js 22 or newer is required.

```sh
npm ci --prefix server
node server/watch-together.mjs
```

Enter `ws://localhost:8787/watch` in two clients running on the same computer.
Create a room in the host player, copy its invitation and join from the guest.
The default loopback endpoint is intentionally **not usable by a friend on a
different computer**. For remote viewing both clients need a reachable TLS relay.

## Internet deployment

Deploy this repository's `server/` and `src/shared/watch-together/` together.
Run `HOST=0.0.0.0 PORT=8787 node server/watch-together.mjs` behind a trusted HTTPS
reverse proxy that supports WebSocket upgrade at `/watch`; use
`wss://your-domain/watch` in the clients. `/health` provides an unauthenticated
liveness response. The client rejects plain `ws://` except localhost/loopback.

Do not expose the unencrypted Node port publicly. Configure reverse-proxy
connection/rate limits, TLS and an explicit deployment access policy. For a
private instance, set `ALLOWED_ORIGINS` to comma-separated exact origins of your
packaged/development clients after inspecting their actual Origin headers.
Leaving it empty permits all origins; the random invitation remains necessary.
Origin filtering is not user authentication and non-browser clients can forge it.
No hosting is provisioned by this source distribution.

Invitations are bearer secrets: anyone with one may join until the room ends.
Do not post them publicly. Member reconnect tokens live only in process memory;
the service stores no files or database and intentionally does not log messages.
A trusted relay operator can observe the playback metadata and invitation, so
use a server you trust. WebSocket TLS encrypts transport, not against the server.

## Behavior and limits

- Host controls playback. Guests cannot overwrite the shared timeline.
- The host's buffer/pause state pauses guests; guest buffering catches up later.
- The exact source and dubber must match, to avoid syncing different edits.
- Host disconnect pauses the room. Reconnection restores membership and state.
- Explicit host exit ends the room; there is no implicit leadership transfer.
- At most eight members, 128 rooms and 128 live sockets by default.
- Messages are at most 4096 bytes; per-socket commands are rate-limited.
- Rooms expire after six hours or 30 minutes without state/member activity.
- Disconnected guest slots expire after two minutes. Closing/restarting the
  relay loses all rooms. This version is single-process, not horizontally scaled.
- Browser autoplay refusal is shown in the UI and needs a user play gesture.
- No public relay, cross-network latency result or production uptime is implied.

## Tests

```sh
node --test server/relay.integration.test.mjs
npm test -- test/watch_together_protocol.test.js
```

The first test opens a real loopback WebSocket relay and two clients, exercises
create/join, host commands, guest rejection, reconnect, state restoration and
room termination, then closes all sockets and the server.

License: GPL-2.0-only, see the repository LICENSE. AnixArtix derives from
MjKey/AniXFlow; upstream attribution is retained.
