# Changelog

All notable changes to `@phlix/syncplay` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`SyncPlayClient.onDisconnect()` + `onDisconnect` callback (B4):** added a
  public `onDisconnect(): void` method that resets all transient connection
  state when the consumer's WebSocket closes or errors — it (1) calls
  `TimeSync.reset()` (clears stale offset samples + drift so a new network path
  cannot corrupt the first post-reconnect sync), (2) sets the current `group` to
  `null` (server-side membership is gone once the socket drops), and (3) clears
  the recorded `lastPingSendTime` so a late `time_pong` from the dead connection
  cannot seed a bogus sample. A new optional `onDisconnect?` option on
  `SyncPlayClientOptions` is invoked afterwards as a consumer UI hook. The
  library still owns **no socket and no timers** — reconnect/backoff is the
  consumer's transport concern. **No wire field, message-type string, or
  time-sync math changed.** Added tests asserting that after seeding samples + a
  group, `onDisconnect()` leaves `getGroup() === null`,
  `getTimeSync().getSampleCount() === 0`, `getDriftRate() === 1.0`, the callback
  fires once, and a subsequent stray pong (no `client_time`) is ignored
  (verifying `lastPingSendTime` was cleared); plus a no-group/no-callback safety
  case and the documented re-join recovery sequence.

### Changed

- **Memoize time-sync window aggregates (P3):** `TimeSync` now caches the
  computed `{offset, latency, isStable}` keyed by a monotonic "samples version"
  integer bumped in `addSample` (accept) and `reset()`. `getOffset` /
  `getLatency` / `isStable` recompute lazily on the first access after a version
  bump and return the cached value otherwise (the pure computations moved into
  private `computeOffset` / `computeLatency` / `computeIsStable`). `getStatus`
  calls all three per accepted pong, so this avoids re-slicing and re-iterating
  the recent window three times for an unchanged dataset. **Pure performance
  optimization — the returned numbers/booleans are byte-for-byte identical to
  recomputing on every call;** public signatures are unchanged. Added tests
  asserting cached values equal freshly-computed ones, that a value read before
  an `addSample` differs after it (cache invalidates), and that `reset()` does
  not leave stale aggregates.

- **Clamp `driftRate` into `[0.99, 1.01]` (B1):** `TimeSync.updateDriftRate` now
  clamps the EMA result into `[DRIFT_RATE_MIN = 0.99, DRIFT_RATE_MAX = 1.01]`
  (both newly exported constants). A noisy or forged offset sequence could
  previously drive `driftRate` far outside this range; a value `< 1.0` in
  particular would let `getAdjustedPosition` move the playhead *backwards* for a
  forward-elapsed interval. The clamp prevents that. **Client-side hardening
  only:** no wire field, message-type string, or wire-math changed — the clamp
  is applied locally to the multiplicative drift factor and cannot desync from a
  correct server. `reset()` still restores `driftRate = 1.0`. Added tests for
  the upper/lower clamp, the in-range no-op, the exported constants, and a
  regression test asserting `getAdjustedPosition` never regresses the playhead
  for forward elapsed time after a drift-suppressing offset sequence.
- **Reject non-positive-time / negative RTT samples (B3):** `TimeSync.addSample`
  now rejects any sample whose computed `rtt < 0` (in addition to the existing
  `rtt > MAX_ACCEPTABLE_RTT` rejection). A negative rtt — e.g. a pong whose
  `clientReceive < clientSend`, or a server gap `t3 - t2` larger than the
  round-trip — would yield a negative one-way latency and a corrupt offset, so
  it is now discarded (`addSample` returns `false`, no sample stored). The guard
  is strict (`< 0`), so `rtt === 0` (the same-process / test path) is still
  accepted. **Client-side hardening only:** no wire field, message-type string,
  or time-sync math changed; this only drops bad samples and cannot desync from
  a correct server. Added tests covering the negative-rtt rejection, the
  `rtt === 0` acceptance, and an explicit high-RTT (`rtt > MAX`) rejection,
  bringing `addSample` to full branch coverage.

### Documentation

- **Epoch-ms clock contract (B8 — comment/contract only, no math change):** made
  the `now()` units contract explicit across the library. `NowFn`'s JSDoc
  (`src/framing.ts`) now states `now()` MUST return **epoch milliseconds**; the
  `TimeSync` class gains a "Clock contract" note and the constructor JSDoc,
  `OffsetSample` doc, and the previously misleading `now() / 1000` comment
  (which read "Seconds, mirroring PHP microtime(true)") are corrected to clarify
  that the stored sample `timestamp` is `now() / 1000` purely to put the drift
  `timeDelta` on the server's per-second `microtime(true)` scale, and that the
  `/ 1000` is a units bridge that presumes a ms clock and must not be removed.
  `SPEC.md` §5 gains the same clock-contract note. The `/ 1000` is unchanged and
  no numeric behavior changed; added a test documenting (via a known epoch-ms
  clock) that the drift `timeDelta` is in seconds.
- **Security model (S1):** added `SPEC.md` §8 "Security model" stating that this
  library performs no auth/authz, that the WebSocket connection MUST be
  authenticated **before** any `syncplay_*` frame, and that `password_hash` is an
  unsalted, **replayable** SHA-256 group gate (not an identity). `README.md` gains
  a Security section linking to the new SPEC sections. No source behavior change.
- **Server-derived identity contract (S2):** added `SPEC.md` §9 documenting that
  `member_id` / host ids are self-asserted on the wire and that a correct server
  MUST derive the effective identity from the authenticated connection, authorize
  host-only actions by connection identity (not the claimed id), and set the true
  sender id on rebroadcast. Added doc-comments in `src/client.ts` above
  `createGroup` / `joinGroup` / the playback senders and at both echo-suppression
  sites (`handlePlayback` / `handleSeek`) noting the §9.1 dependency on the
  server-set sender id. Comment-only; no behavioral source change.
- **Reconnect & resume recovery (B4 / P2-as-DOC):** added `SPEC.md` §10
  documenting the WS-reconnect recovery sequence — `socket close →
  client.onDisconnect() → reconnect → joinGroup(...) → resume pingTime()` — and
  what transient state a disconnect invalidates. `README.md` gains a "Reconnect
  recovery" section with the same ordering plus a recommended **exponential
  backoff with full jitter** recipe; the usage example wires the new
  `onDisconnect` callback. The reconnect *backoff timer* is explicitly a
  consumer/transport concern (this library schedules no timers) — flagged as
  documentation-only for P2 in this repo.

## [0.1.1] - 2026-06-26

### Fixed

- **GROUP_STATE interop (critical):** `SyncPlayGroup` now uses `group_id` /
  `group_name` to match the server's `GroupState::getState()`, which emits the
  group identity under those keys (NOT `id` / `name` — those belong to the
  members). Previously `client.ts` read `group.id` / `group.name`, which are
  `undefined` against the live server, silently losing group identity and the
  display name. The `group_state` handler now reads `group.group_id` /
  `group.group_name` and also surfaces `member_count`, `current_media_duration`
  (useful for clamping positions), `created_at`, and `last_activity_at` — all
  always-emitted by `getState()`. `SPEC.md` updated to the exact emitted shape.
- **`buffering` playback state:** added `'buffering'` to the `PlaybackState`
  union to mirror `GroupState::STATE_BUFFERING = 'buffering'`, which a
  `playback_state` can legitimately carry.
- Documented that `SyncPlayGroup.has_password` is a `listGroups()`-only summary
  field and is never present on a `group_state` message.

## [0.1.0]

Initial release — the single shared, canonical SyncPlay protocol + NTP
time-sync for Phlix JS clients (mobile, windows, tizen). The PHP server is the
source of truth; this package mirrors it exactly.

### Added

- `messages.ts` — `SYNCPLAY_MESSAGE_TYPES` (all 19 underscore-prefixed type
  strings mirroring `Messages.php`), `PROTOCOL_VERSION = 1`, `ALL_MESSAGE_TYPES`,
  `isValidMessageType()`, and per-message payload interfaces with exact
  snake_case wire fields plus the `SyncPlayMember` / `SyncPlayGroup` models.
- `framing.ts` — `encodeMessage(type, payload, now)` producing the canonical
  flat RAW JSON envelope (`{ type, protocol_version, timestamp, ...payload }`),
  `decodeMessage(raw)` (tolerates and unwraps the deprecated Tizen
  `{ type, data, timestamp }` wrapper), and `serializeMessage()`. The clock is
  injected — no `Date.now()` at module scope.
- `time-sync.ts` — `TimeSync` class faithfully porting `TimeSync.php`:
  `addSample(t1,t2,t3,t4)` with RTT rejection, 1/rtt-weighted-mean `getOffset()`,
  `getLatency()`, `isStable()` (variance < 50, ≥5 samples), EMA `updateDriftRate()`
  / `getDriftRate()`, `getSynchronizedTime()`, `getAdjustedPosition()`, and
  exported constants (`OFFSET_SAMPLE_COUNT`, `MAX_ACCEPTABLE_RTT`,
  `DRIFT_CORRECTION_FACTOR`, `TIME_SYNC_PROTOCOL_VERSION`). Restores the drift
  calculation that the Windows and Mobile clients omitted.
- `client.ts` — `SyncPlayClient`, a framework-agnostic orchestrator with
  injected `send` + `now`; group create/join/leave, host-only play/pause/seek,
  `reportPosition`, `pingTime`, and `handleIncoming(raw)` routing (feeds
  time-sync on pong, applies nested `group_state`, surfaces playback commands,
  host election, member joins via INFO, and errors). No WebSocket/Date deps.
- `SPEC.md` — full wire-protocol spec (all 19 types + exact JSON shapes + NTP
  algorithm + framing rule + member-event handling) and the normalized client
  divergences, so Roku/BrightScript and the PHP server can be checked against
  one document.
- Tooling matched to `@phlix/tokens`: strict TS (no `any`), Vite lib build
  (ES + CJS), Vitest (node env, v8 coverage), flat ESLint, CI workflow.

### Normalized away

- Windows: missing message types, flat `group_state` read, absent drift, buggy
  RTT formula, non-protocol `syncplay_position_report`, fake password hash.
- Tizen: invented `syncplay_member_joined` / `syncplay_member_left`, the
  `{ type, data, timestamp }` send wrapper, fake password hash.
- Roku: `syncplay.` dot prefix and HTTP-POST (canonical is underscore
  `syncplay_` over WebSocket).
