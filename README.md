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

```bash
npm install @phlix/syncplay
```

## Usage

```ts
import { SyncPlayClient } from '@phlix/syncplay';

const ws = new WebSocket('wss://server/api/v1/syncplay/ws');

const client = new SyncPlayClient({
  send: (message) => ws.send(JSON.stringify(message)),
  now: () => Date.now(),
  memberId: 'member_123',
  memberName: 'Alice',
  onState: (group, yourId) => { /* render group; you are yourId */ },
  onSync: ({ offset, latency, isStable }) => { /* time-sync status */ },
  onPlaybackCommand: ({ type, position, serverTime }) => { /* apply locally */ },
  onMemberJoined: ({ id, name }) => {},
  onHostChanged: (hostId) => {},
  onError: (code, message) => {},
  onMemberTyping: (memberId, isTyping) => {},
  onHostTransfer: (currentHostId, newHostId) => {},
  onPlaybackSync: (memberId, position, isPlaying, serverTime) => {},
  onTimeSync: (serverTime, clientTime) => {},
  onGroupList: (groups) => { /* [{ group_id, group_name, has_password }] */ },
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
```

### Reconnect recovery

This library owns **no socket and no timers** — your transport opens, closes, and
reconnects the WebSocket. When the socket drops, call `client.onDisconnect()`
*before* reconnecting. It resets the time-sync samples + drift, forgets the
current group, and drops the outstanding ping so a late pong from the dead
connection cannot seed a bogus sample (then fires the optional `onDisconnect`
callback for your UI). It does NOT reconnect or re-join.

The required ordering (also in [`SPEC.md` §10](./SPEC.md#10-reconnect--resume-recovery)):

```
socket close → client.onDisconnect() → reconnect → joinGroup(...) → resume pingTime()
```

**Backoff is your transport's job** (this lib schedules no timers). Recommended
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
  const ws = new WebSocket(URL);
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
