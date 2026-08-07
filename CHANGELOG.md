# Changelog

All notable changes to `@phlix/syncplay` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-08-07

### ⚠ Read first — the `v0.1.2` tag sits on a **disjoint** history

This repository contains **two root commits** — `702ef1e` and `576d22d`, both
titled "feat: @phlix/syncplay v0.1.0" and both dated the same day. The history
the `v0.1.2` tag points at was at some point replaced wholesale by an equivalent
history carrying different SHAs, and the tag was never moved.
`git merge-base v0.1.2 HEAD` returns **nothing**: the tag and `master` share no
common ancestor at all.

What that means for anyone auditing this release:

- `git log v0.1.2..HEAD` reports ~22 commits. That is **not** the release delta
  — it is the whole replacement history being re-listed because git can find no
  merge base. Do not quote that number as "commits in 0.1.3".
- A GitHub three-dot compare (`v0.1.2...v0.1.3`) is fabricated for the same
  reason and will show far more than actually changed.
- The only meaningful comparison is the **tree** diff:

  ```bash
  git diff v0.1.2 HEAD -- src     # published API + behaviour
  git diff v0.1.2 HEAD -- test .github vite.config.ts
  ```

  Every claim in this entry was derived that way, not from the commit log.

`v0.1.3` is tagged from `master`, so ancestry-based comparisons work normally
from this release onward.

### Added

- **MIT `LICENSE` file.** `package.json` has declared `"license": "MIT"` since
  `0.1.0`, but the repository shipped no license text — so the published tarball
  and the GitHub repo asserted a license they did not include. The MIT text
  (© 2026 Phlix contributors) is now present at the repo root. This matches the
  Phlix licensing split: the apps are MPL-2.0, but interop/protocol packages and
  clients — which this is — are MIT so third parties can implement the SyncPlay
  wire protocol freely. No code change; a packaging correctness fix.

- **Coverage is actually generated and uploaded in CI.** `vite.config.ts` had a
  `coverage` block, but the CI job ran plain `npm run test:run`, so no report was
  ever produced. CI now runs `npm run test:run -- --coverage`, the `lcov`
  reporter was added (it is the only one that writes `./coverage/lcov.info`), and
  a `codacy/codacy-coverage-reporter-action` step uploads that file. Two things a
  reader should know about this step: it is pinned to `@v1.0.0` rather than the
  floating `@v1`, and it carries `continue-on-error: true` so a missing token or
  a Codacy outage can never turn the build red — which also means a **failed**
  upload reports as "success". To confirm an upload really happened, read the
  step log for `Coverage data uploaded`, not the step conclusion. *(No coverage
  percentage is quoted here deliberately — none was measured for this release.)*

- **The CI workflow now runs on its own.** `syncplay-ci` was `workflow_dispatch`
  only, with the `push` / `pull_request` triggers commented out, so no push or PR
  had ever been gated by it. Both triggers are enabled on `master`, making
  lint → typecheck → build → test a real check rather than a manual one.

### Changed

- **Test suite roughly doubled: 66 → 117 cases** across the same three files —
  `test/client.test.ts` grew by 929 lines (19 → 68 cases) and
  `test/time-sync.test.ts` by 76 lines (32 → 34); `test/messages.test.ts` is
  unchanged at 15. The new `client.test.ts` cases exercise the previously untested
  inbound handlers and their guard clauses: `group_state` with a missing/`null`
  group, `group_state` with the optional fields absent, the `buffering` state and
  `group_id`/`group_name` preservation, echo-suppression on the client's own
  playback/seek frames, unknown-type frames being ignored without disturbing a
  subsequent valid one, and the host-transfer / typing / playback-sync /
  time-sync / group-list callbacks added in `0.1.2`. Nothing in `src/` was
  changed to make these pass. *(One of the two commits involved is titled
  `提升测试覆盖率` — "improve test coverage"; besides the tests it also
  regenerated `dist/`, which is how the type-level edits below reached the
  published `.d.ts` files.)*

- **Removed the redundant `?? 0` / `?? 'stopped'` fallbacks in
  `handleGroupState`** (a Codacy finding). `playback_position` and
  `playback_state` are now read straight off the incoming group object:

  ```ts
  playback_position: group.playback_position,   // was: ?? 0
  playback_state:    group.playback_state,      // was: ?? 'stopped'
  ```

  This was checked against the server rather than accepted on the strength of the
  TypeScript types, because the value being mapped comes from
  `msg as Partial<GroupStatePayload>` — an unvalidated wire object, where a
  "required" property is an assertion, not a guarantee. All five production
  emitters of `syncplay_group_state` in `phlix-server`
  (`SyncPlayManager` lines 371, 452, 972, 1126, 1161) serialise
  `GroupState::getState()`, which writes both keys unconditionally from
  non-nullable typed properties (`private int $playbackPosition = 0`,
  `private string $playbackState = self::STATE_STOPPED`). Neither
  `Connection::sendFlat()` nor `broadcastToGroup()` filters keys — both are a
  plain `array_merge` followed by a flag-less `json_encode` — and both snapshot
  restore paths (`GroupState::deserialize()` and
  `SyncPlaySnapshotService::getRawSnapshot()`) coerce to `0` / `'stopped'` rather
  than omitting. The one server helper that *can* omit these fields,
  `Messages::groupState()`, has **no production callers** (only three test files)
  and emits a flat frame with no `group` key at all, so it can never reach this
  code path — the handler returns early on `typeof group !== 'object'`. The two
  fields therefore cannot be absent or `null` on the wire, and the fallbacks were
  genuinely dead. The sibling `?? null` on `host_id`, `current_media_id` and
  `current_media_duration` was correctly **kept**: those are nullable in
  `SyncPlayGroup`, so the coalesce there normalises a possible `undefined` into
  the declared `null`, which is a real conversion rather than dead defence.
  **No observable behaviour change against any Phlix server.**

- **Type-only tidy-ups — these are NOT API changes.** They alter the emitted
  `.d.ts` text, so a reader diffing `dist/*.d.ts` between `0.1.2` and `0.1.3`
  will see churn that does not correspond to any contract movement:
  - Callback parameters in `SyncPlayClientOptions` were renamed with a leading
    underscore (`onState?: (_group: SyncPlayGroup, yourId: …)`) to satisfy an
    unused-parameter rule. These are names in a **type position** only — they are
    documentation, not bindings. No call site, argument order, or argument type
    changed, and callers never referenced them. (The renaming is partial: some
    parameters, e.g. `yourId`, `isTyping`, `position`, were left unprefixed.)
  - `Array<T>` was rewritten as `T[]` in `onGroupList`, `handleGroupList`'s local
    type, and `GroupListResponsePayload.groups`. Identical types, different
    spelling.
  - `GroupListPayload` changed from `interface GroupListPayload { [key: string]:
    never }` to `export type GroupListPayload = Record<string, never>`. Same
    structural type — still "a bare request with no fields".

- **Dev-dependency lockfile bump** from the Dependabot `npm_and_yarn` security
  group: `brace-expansion` (1.1.15 → 1.1.16, and 5.0.6 → 5.0.8 under
  `@typescript-eslint/typescript-estree`), `js-yaml` (4.2.0 → 4.3.0), `nanoid`
  (3.3.15 → 3.3.16) and `postcss` (8.5.15 → 8.5.23). `package-lock.json` only —
  all transitive **dev** dependencies of the toolchain. This package still ships
  with zero runtime dependencies and none of this reaches `dist/`.

### Documentation

- `README.md` now documents the four callbacks added in `0.1.2` that had shipped
  undocumented — `onMemberTyping`, `onHostTransfer`, `onPlaybackSync`,
  `onTimeSync` — plus `onGroupList`, wired into the README's usage example with
  their real signatures. Example-only; no behaviour change.

## [0.1.2] - 2026-07-09

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

## [Unreleased]

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
