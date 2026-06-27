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
