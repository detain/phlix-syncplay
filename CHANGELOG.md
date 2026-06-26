# Changelog

All notable changes to `@phlix/syncplay` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
