# @phlix/syncplay

[![CI](https://github.com/detain/phlix-syncplay/actions/workflows/ci.yml/badge.svg)](https://github.com/detain/phlix-syncplay/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/detain/phlix-syncplay/graph/badge.svg)](https://codecov.io/gh/detain/phlix-syncplay)
[![Version](https://img.shields.io/github/v/tag/detain/phlix-syncplay?label=version&sort=semver)](https://github.com/detain/phlix-syncplay/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

The single shared, canonical implementation of the **Phlix SyncPlay** wire
protocol + NTP time-sync for JavaScript clients (mobile / React Native,
windows / Electron, tizen / webpack).

It eliminates the protocol drift that accumulated across clients (Windows
missing message types and reading `group_state` flat; Tizen inventing
`member_joined`/`member_left` and wrapping sends as `{type,data,timestamp}`;
Roku using a wrong `syncplay.` dot prefix over HTTP-POST). **The PHP server is
the source of truth** — this package mirrors it exactly.

- **No framework deps.** Pure TypeScript, usable in RN/Metro, Electron
  renderer, and Tizen webpack.
- **Transport-agnostic.** WebSocket is *injected* — you pass a `send` function
  and call `handleIncoming(raw)` per frame. The library never imports a WS lib.
- **Deterministic.** The clock is injected (`now: () => number`); no
  `Date.now()` / `Math.random()` at module scope.

See [`SPEC.md`](./SPEC.md) for the full wire-protocol documentation.

## Security

**This library performs NO authentication and NO authorization** — it is a
transport-agnostic protocol codec with no socket and no view of credentials.
All security is a **server responsibility**:

- The server MUST authenticate the WebSocket connection **before** accepting any
  `syncplay_*` frame.
- `password_hash` (on `createGroup` / `joinGroup`) is an unsalted SHA-256 hex
  string that is **replayable** — a weak *group gate*, never an identity.
- `member_id` / host ids are **self-asserted on the wire**; the server MUST
  derive the effective identity from the authenticated connection and authorize
  host-only actions by connection identity, not by the client-claimed id.
- Peer-supplied display strings (`group_name`, `member_name`, chat/info
  `message`) are passed through unescaped — **consumers MUST sanitize before
  rendering**.

See [`SPEC.md` §8 Security model](./SPEC.md#8-security-model) and
[§9 Server-derived identity contract](./SPEC.md#9-server-derived-identity-contract-member_id--host_id)
for the full contract.

## Install

`@phlix/syncplay` is distributed as a **git-tagged dependency** (not published to
npm). Pin an exact tag:

```jsonc
// package.json
{
  "dependencies": {
    "@phlix/syncplay": "github:detain/phlix-syncplay#v0.1.5"
  }
}
```

```sh
npm install
```

## Connecting

The library owns no socket — you dial the WebSocket, and the handshake must
carry your credential: both listeners reject the upgrade **before the 101**
without it (nothing is ever read on an unauthenticated connection). Browsers
(and React Native) cannot set an `Authorization` header on a WebSocket
upgrade, so the bearer token rides as the second `WebSocket` constructor
value. See [`SPEC.md` §8.4](./SPEC.md#84-websocket-credential-carrier-server-8097-vs-hub-relay-8804)
for the full carrier law.

**Direct — server `:8097`:**

```ts
const ws = new WebSocket('wss://phlix.example:8097/api/v1/syncplay/ws', ['bearer', jwt]);
```

`:8097` is the SyncPlay listener — the HTTP API port has no WebSocket upgrade.
The `Sec-WebSocket-Protocol: bearer, <jwt>` two-entry subprotocol is the
estate target carrier; the server answers the 101 with the `bearer` marker
only, never the token. The legacy `?token=<jwt>` query is still accepted on
`:8097` for older client builds but **must never be added to new code paths**
— a URL-borne credential leaks into access/proxy logs and handshake
diagnostics.

**Via hub relay — `:8804`:**

```ts
const ws = new WebSocket(`wss://hub.example:8804/syncplay/${serverId}`, ['bearer', relayToken]);
```

The hub relay speaks the same protocol but accepts the bearer subprotocol
**only** — a `?token=` query is refused there by design. Each relay socket is
scoped to one server (`{server_id}` in the path) and one hub account.

## Usage

```ts
import { SyncPlayClient } from '@phlix/syncplay';

// Dial per "Connecting" above (SPEC §8.4): the credential rides the bearer
// subprotocol, never in the URL.
const ws = new WebSocket('wss://phlix.example:8097/api/v1/syncplay/ws', ['bearer', jwt]);

const client = new SyncPlayClient({
  send: (message) => ws.send(JSON.stringify(message)),
  now: () => Date.now(),
  memberId: 'member_123',
  memberName: 'Alice',
  onState: (group, yourId) => { /* render group (`group.members` normalized to an array; `group.queue` delivered per producer — SPEC §4); you are yourId */ },
  onSync: ({ offset, latency, isStable }) => { /* time-sync status */ },
  onPlaybackCommand: ({ type, position, serverTime }) => { /* apply locally */ },
  onMemberJoined: ({ id, name }) => {},
  onHostChanged: (hostId) => {},
  onError: (code, message) => {},
  onMemberTyping: (memberId, isTyping) => {},
  onChat: (memberId, memberName, message, timestampMs) => { /* every accepted message, INCLUDING your own echo (fan-out includes the sender) — render chat from here only */ },
  onQueueChanged: (queue) => { /* wholesale queue replacement; also folded into getGroup().queue; [] = cleared */ },
  onHostTransfer: (currentHostId, newHostId) => {},
  onPlaybackSync: (memberId, position, isPlaying, serverTime, nudge) => { /* `nudge` = server-directed S446 soft correction ({drift_ms, direction, suggested_rate, tolerance_ms, cooldown_ms}); undefined unless the `:8097` server unicasted it to THIS member — apply suggested_rate, never seek (SPEC §4) */ },
  onTimeSync: (state) => { /* { memberId, groupId, serverTimeSec, offsetMs, latencyMs, driftRate, isStable } */ },
  onGroupList: (groups) => { /* [{ id, name, member_count, has_password, current_media, is_playing }] — live producer row, SPEC §4 */ },
  onUnknownFrame: (frame) => { /* non-SyncPlay types only, e.g. the hub relay's `pending_command` */ },
  onDisconnect: () => { /* UI hook, e.g. show a "reconnecting…" banner */ },
});

ws.onmessage = (e) => client.handleIncoming(e.data);
ws.onopen = () => {
  client.pingTime();                 // schedule this every ~10–30s
  client.createGroup('Movie Night'); // or joinGroup(groupId)
};

// Host-only controls (the server rejects non-hosts with NOT_HOST):
client.sendPlay(positionMs);
client.sendPause(positionMs);
client.sendSeek(fromMs, toMs);
client.reportPosition(positionMs, isPlaying);

// Party surface (any member; identity is server-derived, SPEC §4/§9):
client.sendChat('popcorn tonight?');   // your message arrives back via onChat
client.sendTyping(true);               // peers see it on THEIR onMemberTyping
```

### Command repeat policy

A TV remote key held on a seek bar emits **10–30 repeat events/s**, and every
playback command is a broadcast: the server rebroadcasts each accepted
`syncplay_playback_play` / `_pause` / `_seek` to **every member** of the group
(phlix-server `SyncPlayManager.php:1182`). The server absorbs none of this
rate: its only WebSocket limiter guards the CONNECT handshake (30 conns / 60 s,
`RateLimitProfiles::WS_CONNECT`), `JoinPasswordThrottle` guards wrong group
passwords, and `queue_limit_exceeded` caps media-QUEUE depth — none of them
throttle command repeat. The law for senders is therefore: **commands are
per-intent, not per-key-event.** How that is met per sender:

- **`sendSeek` — the library coalesces it for you (default on).** A leading +
  trailing throttle windowed by the `seekThrottleMs` constructor option
  (default 250 ms): the first call of a burst dispatches **synchronously**
  (single-press UX is byte-identical to the raw path, so every existing call
  pattern keeps working), repeats inside the window merge **latest-wins**
  (an intermediate seek target is meaningless — only the last position
  matters), and the last position always reaches the wire within one window
  of release. A held remote costs the room at most 4 seek frames/s instead of
  10–30 full player seeks. Escape hatch: `seekThrottleMs: 0` restores raw
  per-call dispatch — the seek coalescer is this library's ONLY owned timer,
  and off-mode owns none. `leaveGroup()` / `onDisconnect()` cancel a
  not-yet-flushed trailing seek: you never seek a room you just left.
- **`sendPlay` / `sendPause` — per-intent, consumer-side.** Dispatch stays
  synchronous and un-shaped: each is a state EDGE and latest-wins merging
  would be semantically wrong (it can lose a legitimate pause behind a
  repeat). If your input layer can key-repeat play/pause, gate the repeat
  before calling (a trailing debounce, e.g. the S519 pattern `phlix-ui` uses
  for its own controls).
- **`reportPosition` — cadence is consumer-owned; seconds-scale is sane.**
  The server's S446 out-of-sync nudge judges staleness of exactly these
  reports (`SyncPlayManager.php:1569-1585`), so flooding them mis-signals as
  surely as long silence does. Remember background-tab timer clamping:
  resume your interval on visibility change.

### Party chat and queue (M-SYNCPLAY-11)

- **Render chat from `onChat` only — never also locally on `sendChat`.**
  Both producers fan chat out **including the sender** (phlix-server
  `SyncPlayManager.php:1323` broadcast via `broadcastToGroup`'s default
  `$excludeIds = []` :1932; hub `SyncPlayRelayWorker.php:1795` omits the
  exclusion), so your own message arrives back as a frame. The library
  deliberately does not suppress that echo: suppression would key on the
  ctor-vs-stamped identity gap SPEC §9 documents as unreconciled.
  `onChat` carries `(memberId, memberName, message, timestampMs)` — the
  broadcast's producer bytes (`member_id`/`member_name`/`message`,
  `SyncPlayManager.php:1323-1326`; the envelope `timestamp` is authoritative
  **ms** on both carriers, S417), and `undefined` for the timestamp only on
  hand-built frames. Note the producers drop blank messages **in silence**
  (server :1314-1316, hub :1791-1793) — no error, no echo — so gate empty
  sends yourself.
- **Typing is the exception that proves the law:** its fan-out EXCLUDES the
  sender (server `[$memberId]` :1380, hub :1828), so your own indicator never
  comes back to your `onMemberTyping`.
- **`onQueueChanged` is the only live queue signal.** An accepted
  `syncplay_playback_queue` broadcast replaces the queue wholesale and the
  server does NOT re-broadcast `group_state` after it
  (`SyncPlayManager.php:1271-1278` — the `publishSnapshot()` at :1278 is an
  internal HTTP-worker snapshot). The library delivers the normalized items
  (per-carrier item law, SPEC §4: hub items lack `added_*` — absent, never
  zeroed), **folds them into `getGroup().queue`**, and does not re-fire
  `onState`. A cleared queue arrives as `[]`, distinct from a frame that
  carried no array (dropped whole). Refusals (`syncplay.queue_limit_exceeded`,
  `NOT_HOST`) come through `onError`, never here.

### Reconnect recovery

This library owns **no socket and no periodic timers** — your transport opens,
closes, and reconnects the WebSocket. When the socket drops, call
`client.onDisconnect()`
*before* reconnecting. It resets the time-sync samples + drift, forgets the
current group, and drops the outstanding ping so a late pong from the dead
connection cannot seed a bogus sample (then fires the optional `onDisconnect`
callback for your UI). It does NOT reconnect or re-join.

The required ordering (also in [`SPEC.md` §10](./SPEC.md#10-reconnect--resume-recovery)):

```
socket close → client.onDisconnect() → reconnect → joinGroup(...) → resume pingTime()
```

**Backoff is your transport's job** (this lib schedules no periodic timers —
the one owned-timer exception is the `sendSeek` coalescing flush, see "Command
repeat policy"). Recommended
recipe — exponential backoff with full jitter, capped, reset on a clean open:

```ts
const BASE_MS = 1000;   // first retry delay
const MAX_MS = 30_000;  // cap
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect() {
  const expo = Math.min(MAX_MS, BASE_MS * 2 ** attempt);
  const delay = Math.random() * expo;        // full jitter
  attempt += 1;
  timer = setTimeout(connect, delay);
}

function connect() {
  // Carrier on every dial, reconnects included (SPEC §8.4):
  const ws = new WebSocket(URL, ['bearer', token]);
  ws.onmessage = (e) => client.handleIncoming(e.data);
  ws.onopen = () => {
    attempt = 0;                              // reset backoff on success
    client.joinGroup(savedGroupId, savedPasswordHash);
    // resume your periodic pingTime() scheduler here
  };
  const onDrop = () => {
    client.onDisconnect();                    // reset client state FIRST
    scheduleReconnect();
  };
  ws.onclose = onDrop;
  ws.onerror = onDrop;
}
```

### Lower-level pieces

```ts
import {
  SYNCPLAY_MESSAGE_TYPES, // the 19 canonical type strings
  PROTOCOL_VERSION,       // 1
  encodeMessage,          // (type, payload, now) -> flat RAW JSON object
  decodeMessage,          // (raw) -> flat RawMessage | null (unwraps Tizen envelope)
  TimeSync,               // NTP offset/latency/stability/drift
} from '@phlix/syncplay';
```

Types for the two `group_state` shapes are exported too: `SyncPlayGroupWire` /
`SyncPlayMembersWire` (the frame as received — `members` is a dict keyed by
member id) and `SyncPlayGroup` (the normalized model with `members: SyncPlayMember[]`).

## Time sync

`TimeSync` reproduces the server's `TimeSync.php` math:

```
rtt    = t4 - t1 - (t3 - t2)      // server pong has no t3 → pass t3 = t2
offset = t2 - t1 + rtt/2          // add to local time to get server time
```

Offset is a low-RTT-weighted mean over the last 5 samples; sync is "stable" when
≥5 samples and offset variance < 50ms; drift is an EMA with factor 0.1.

## Develop

```bash
npm install
npm run lint
npm run typecheck
npm run build       # ES + CJS + d.ts into dist/
npm run test:run    # vitest
```

## License

MIT
