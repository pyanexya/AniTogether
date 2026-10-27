# Watch-together Durable Object

`src/rooms.mjs` exports `WatchRooms`. The Worker forwards **GET /watch** upgrades to
`env.ROOMS.get(env.ROOMS.idFromName('anixartix-rooms-v1')).fetch(request)`.
Wrangler must bind `ROOMS` to `WatchRooms`, export that class from the entry module,
and create it with a `new_sqlite_classes` migration. No Node compatibility flag is
required by this module. Deploy from this repository: it imports the existing
shared protocol module outside `cloudflare/`, rather than maintaining a divergent
copy. GPL-2.0 project attribution/license remains applicable.

## Compatibility and security

The native v1 first-frame `create` / `join` / `resume`, `AnixArtix:` invitation,
member capabilities, monotonic host command sequence, play/seek/pause/buffering,
and source/dubber identities remain unchanged. The Worker handles only playback
metadata, **never video, stream URLs, or provider account credentials**. Anonymous
invitation rooms work even when OAuth providers are unconfigured. Display names
are not verified account identities. Room/invitation/member tokens are capabilities:
keep invitations private, use WSS, do not put tokens in URLs or access logs.

An exact Origin allow-list admits Windows Tauri (`http://tauri.localhost`), Tauri's
custom origin, and `APP_ORIGIN` (default `https://aniartix.pyanexy.cc`). Missing
Origin is denied. No query parameters are accepted. Tokens are random Web Crypto
192-bit secrets. Guest clients cannot publish; stale commands are rejected. Input
frames are at most 4096 UTF-8 bytes, text only; values are normalized using the
existing shared protocol, so unknown fields cannot relay arbitrary payloads.

## Persistence, hibernation and limits

Rooms are separate SQLite-backed DO storage keys (not Worker-global memory).
State/command sequence is committed before broadcasts/acknowledgements. Socket
attachments preserve connection IDs, rate counters and last activity across DO
hibernation; the constructor rebuilds socket mappings using `getWebSockets()`.
A full runtime restart that loses sockets pauses the host, but membership and
resume capabilities survive. Resume does not silently start playback. Expiry runs
before each message and via an alarm, not an interval preventing hibernation.

Limits: 128 concurrent sockets, 128 rooms, 8 members per room, 6-hour room lifetime,
30-minute room inactivity, 2-minute disconnected guest grace. Unjoined sockets
have 30 seconds to handshake; sockets without application messages expire after
90 seconds (native client pings every 5 seconds). Per-socket limit is 80 messages
per 10 seconds, including malformed input; repeated excess disconnects. Counters
survive leave/create and hibernation. The public Worker overwrites
`X-AnixArtix-Client-Key` using SHA-256 of Cloudflare's platform-supplied
`CF-Connecting-IP` plus the UTC day; clients cannot choose this internal key.
Missing IP or missing/invalid internal key fails closed. The DO binding is not a
separate public endpoint. Do not publish a debug endpoint that forwards arbitrary
client keys or bypasses this ingress.

Per daily pseudonymous client key, defaults are **16 simultaneous sockets,
128 connection upgrades/hour, 8 room creates/hour**. These are deliberately
NAT-friendly but users sharing one public IP share their allowance. Configure
`ROOM_CLIENT_SOCKETS` (1–64), `ROOM_CLIENT_OPENS_PER_HOUR` (1–1024), and
`ROOM_CLIENT_CREATES_PER_HOUR` (1–64); invalid values use safe defaults. Counters
are stored in SQLite and survive reconnect, DO hibernation and runtime replacement.
A fixed one-hour window begins with the first accepted event; UTC-day key rotation
can grant a new allowance at midnight. Old already-open sockets retain their key
until disconnect, so this is abuse mitigation, not a strict person/device quota.
The bounded counter registry holds at most 2048 keys and fails closed when full;
expired keys are removed before events and by alarms. Raw IP is never persisted
or logged by this code. Daily hashes are **pseudonymous, not anonymous** (IP spaces
can be enumerated). Persisted counter records expire after one hour, while active
socket attachments retain their key until closed; Cloudflare itself still sees
connection IPs. Distributed attackers or changing IPs are not solved by this cap.

The browser/Worker WebSocket API does not expose Node `ws`
`bufferedAmount`, so there is no equivalent custom 64 KiB outgoing queue check;
input/room/member caps bound amplification, not total slow-reader memory. Do not
present this as an unrestricted public relay or unlimited-free service.

One named DO intentionally preserves the existing handshake, where the room ID
is only known after upgrade. This is a modest-capacity deployment, not horizontal
room sharding. A future per-room actor architecture needs a versioned routing
handshake/gateway and client changes. Do not independently select random DOs in
the Worker: that would make create/join land on different room registries.

Official implementation references:
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

Tests: `node --test test/rooms.test.mjs` reconstructs the actor against durable
storage/socket doubles and verifies security/expiry/reconnect/rate behavior. It
is not proof of real platform hibernation. `node --test test/rooms.runtime.test.mjs`
runs actual Miniflare/workerd WebSocket and SQLite integration checks, including
full runtime replacement using persistent storage. Neither test suite establishes
production hibernation eviction behavior or live-cloud operation. Production deployment,
custom-domain TLS and real two-device playback still need verification after
account access/DNS setup.
