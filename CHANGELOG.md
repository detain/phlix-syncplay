# Changelog

All notable changes to `@phlix/syncplay` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
- **SPEC §4 is now the SINGLE time-unit law with the named `:8097` seconds
  exception; every mention-site and §8.4/§2 delegate to it (fix lane
  M-SYNCPLAY-15, review `syncplay__writer` MAJ-1; docs + tests only — zero
  executable surface change: the emitted bundle is byte-ident, `dist/`
  untouched, no `.d.ts` movement; v0.1.6 wave rider).** The law and §8.4's
  quirk disclosure used to be two separate law-statements about the same
  `server_time` field — the contract-text hazard that shipped mobile's
  2×-undercorrect bug class. Shipped: §4's UNIT LAW block (ms is the rule;
  `server_time` on the `:8097` server-stamped arms — `playback_sync` group
  echo + S446 nudge unicast, `time_sync` advisory, play/pause/seek echo
  fallback — is the ONE named per-carrier exception; the hub NEVER stamps a
  seconds `server_time`; `time_pong` is ruled ms on both carriers), the honest DELIVERY
  POLICY (playback arms normalize at parse via `serverTimeToMs`; the
  `time_sync` advisory is the one arm delivered VERBATIM as the unit-named
  `serverTimeSec` — curing a live docs-lie: the previous §4 text claimed EVERY
  delivered `server_time` was normalized, which `handleTimeSync` never did),
  §8.4 and the §2 footnote re-pointed to §4 as the single authority, all five
  §4 `server_time` mention-sites annotated inline, and unit labels added to
  `group_state.created_at`/`last_activity_at` (verified `time()` on server
  `GroupState.php:241-242`, UNIX seconds on hub `SyncPlayRelayWorker.php:1367`
  too). r2 — review `syncplay__writer` M15r1 RF-1: the re-pointed §2
  footnote's BODY initially kept a hub-wide-ms universal that contradicted
  §4 (ii)'s roster seconds (and grouped the JWT `exp` claim as ms); the
  footnote is now a roster-consistent detail site — every `:8804`
  §3-catalog unit is delegated to §4 (hub `server_time` ms; roster/lifecycle
  stamps UNIX seconds there too, hub bytes cited), and only the out-of-band
  `pending_command.issued_at` metadata stamp is stated as fact, expressly as
  outside §4's field scope; this bullet's NEVER-stamps claim is bounded to
  `server_time` accordingly.
  Producer bytes re-verified at phlix-server `c22b9d2e`
  (`:1076`/`:1128`/`:1175` `?? time()`, echo `:1517-1524`, nudge
  `:1569-1585`, `handleTimeSync` `:1652-1660`, `TimeSync::processPing()` ms)
  and phlix-hub `5731fc79` (`nowMs()` stamps, `canonicalInt` pass-through).
  New `test/specUnitLaw.test.ts` (10): 8 SPEC-text pins (law heading, named
  exception arms, docs-lie tripwire, mention-site coverage, no-second-authority
  tripwires — all red on parent `a09506f` — plus the r2 footnote-BODY
  roster-consistency pin, red on the r1 head `3672447`) + 2 behavioral pins of
  the documented delivery policy. vitest 195 → 205 (+10 exact).**
- **`memberId` ↔ `your_id` identity contract DOCUMENTED; README example cured
  to join-response truth (fix lane M-SYNCPLAY-12, review `syncplay__gameux`
  M5; semver PATCH — documentation + tests only, zero executable surface
  change: the emitted bundle is byte-ident, only `.d.ts` doc comments and the
  maps moved; no API change, and the considered warn-once dead-host detector
  was deliberately NOT shipped — routing a non-wire code through `onError`
  would pollute the contracts-governed code namespace and the lib owns no
  logger seam, so the coupling is pinned by tests on the existing surface
  instead).** The three local identity decisions (`isHost()`, the
  play/pause/seek echo suppressions) compare the ctor `memberId` against
  server-stamped ids, but nothing stated they are ONE identity — and the
  README taught the fabricated-literal shape that made mobile's dead-host bug
  (true host reads `isHost()` false forever; own echoes arrive stamped with
  the derived id, miss suppression, double-apply). Shipped: the full law on
  `SyncPlayClientOptions.memberId` with both-sides producer cites (`:8097`
  stamps the JWT subject — phlix-server `SyncPlayManager.php:1799`/`:1855`,
  REST `SyncPlayController.php:173`/`:267`/`:305`, rebroadcast
  `:1084-1093`/`:1182-1187`; `:8804` stamps a hub-generated per-connection
  uuid — phlix-hub `SyncPlayRelayWorker.php:423` + `generateClientId()`
  `:2107-2120`, echoed at `:1486-1491` — with the adopt-from-`yourId` duty and
  the mobile audit-H4 precedent named), `onState`'s `yourId` docblock, the
  surface-verbatim rationale in `handleGroupState`, an `isHost()` coupling
  note, SPEC §9.2 (client-side coupling — additive § to the section that
  defines the identity contract), a README "Identity contract" section +
  table, and the example sourcing `memberId` from the auth store instead of
  `'member_123'`. New `test/memberIdentity.test.ts` (6): `isHost()` true ONLY
  for the join-stamped id, the permanent-false + double-apply mismatch
  symptoms pinned on fake producer frames, self-vs-other echo suppression, and
  the corrected README flow exercised as code. vitest 189 → 195 (+6 exact).**
- **Watch-party chat and queue frames are ORCHESTRATED — `onChat` /
  `onQueueChanged` + `sendChat` / `sendTyping` (fix lane M-SYNCPLAY-11, review
  `syncplay__gameux` M4; semver MINOR — additive public surface, no existing
  shape changes).** The dispatch arms for inbound `syncplay_chat` and
  `syncplay_playback_queue` were silent ignores: the two party-wire frame
  types SPEC §4 documents could reach a consumer only by sniffing raw frames
  (`syncplay_typing` had an `onMemberTyping` handler but NO sender, making the
  indicator one-way; chat had neither arm reachable). Shipped: two new
  optional callbacks matching the repo options idiom — `onChat(memberId,
  memberName, message, timestampMs)` fed the broadcast's PRODUCER BYTES
  (server `SyncPlayManager.php:1323-1326`, hub
  `SyncPlayRelayWorker.php` :1795-1799: `member_id`/`member_name`/`message`,
  no `group_id`; envelope
  `timestamp` is authoritative ms on both carriers) with per-field coercion
  (absent `member_name` → `''`, never an invented `Unknown` — that fallback
  is the server's record-level law, not the library's) — and
  `onQueueChanged(queue)` reusing `normalizeQueue` verbatim, folding the
  cached group WITHOUT re-firing `onState` (the `handleHostElect` precedent)
  because the producers do NOT re-broadcast `group_state` after a queue
  update (server :1271-1278 — `publishSnapshot()` is internal HTTP-worker
  only): this frame is the ONLY live queue signal. Both handlers REFUSE
  garbage per the `handleGroupList` precedent (chat needs string `member_id`
  + `message`; a queue frame without an array is dropped whole — `[]` means
  "cleared" and never mixes with "no frame"; refusals
  (`queue_limit_exceeded`/`NOT_HOST`) arrive via `onError`, never here).
  Chat fan-out INCLUDES the sender on both carriers (:1932 default
  `$excludeIds = []`; hub call omits it — the server's "excluding sender"
  docblock is stale prose, disk-verified @84e55800/5731fc79) so the library
  surfaces the echo and documents the render-from-callback-only law; typing
  is the documented exception (its broadcast EXCLUDES the sender :1380/
  :1828). New senders `sendChat(message)` / `sendTyping(isTyping)` mirror
  the PHP factories `Messages::chatMessage` (:564-574) / `chatTyping`
  (:590-600) — envelope + `group_id`/`member_id`/payload, no-ops outside a
  group (the `sendPlay` precedent). The `onUnknownFrame` law (S298) holds
  UNCHANGED: no canonical type may reach the hook — the bug-adjacent S298
  pins that fed CHAT/PLAYBACK_QUEUE assert `unknown === 0` and stayed green
  UNMODIFIED (only their stale "not orchestrated" comment cured). New
  exported payload types `ChatBroadcastPayload` / `QueueBroadcastPayload`
  pin the inbound wire shapes. This cure owns NO timers: handlers are
  synchronous folds/dispatches (fake-timer zero-count pin + stray-frames-
  after-teardown safety pin). SPEC §4 amended ONLY where it drifted from the
  producers: the two single-shape blocks rewritten both-directions (the
  broadcast shapes genuinely differ from the outbound factory shapes — no
  `group_id`/`member_id` claim, `member_name`/`added_*` per-carrier law,
  silent blank-drop :1314-1316/:1791-1793), the playback_queue "carried but
  not orchestrated (ignored by design)" law retired; README gained the party
  usage + law section. The `group_state.group.queue` half of the review was
  ALREADY cured at `d687560` (`SyncPlayGroup.queue?` via `normalizeQueue`) —
  untouched, disk-verified. Red-on-parent: 13 of 15 new-file tests fail at
  `87fd030` (the 2 green are the garbage-refusal cases, vacuous on a parent
  that drops everything). Serial suite 7 files / 174 → 8 files / 189 tests
  (+15 exact); typecheck/lint clean; `dist/` rebuilt deterministically
  (aggregate md5 `4fd23470b0856eada8edd9553bcc8f4d` ×2). Consumers pin
  `#v0.1.5` remotely — live for them at the v0.1.6 tag wave (rider note).
- **`server_time` scale trap (M-SYNCPLAY-10) closed-out: carrier-pair age pins +
  docblock currency (semver PATCH — no consumer-visible shape change; doc/test
  only).** The review (`syncplay__gameux` M3) named the playback_sync echo path
  where `:8097` stamps UNIX seconds (phlix-server `SyncPlayManager.php:1506`
  `$serverTime = time();` → broadcast `:1523` — review-era cite `:1508`, 2-line
  drift @84e55800), the hub relay stamps ms (`SyncPlayRelayWorker.php:1679`
  `self::nowMs()` — review-era cite `:1603`, drift @f85f48ec) and the handler's
  own no-stamp fallback is already ms. The `39433e1` normalize (M-SYNCPLAY-04)
  already covers this decode site: at HEAD every `server_time` reaching
  `onPlaybackSync`/`onPlaybackCommand` passes `SyncPlayClient.serverTimeToMs`
  (magnitude heuristic `< 1e12 → ×1000`) and no raw-stamp consumer path remains
  (all decode sites + the ms-pinned TIME_PONG producers on both carriers —
  server `TimeSync::processPing:113` — were re-traced). Shipped here: two
  fake-clock pins locking the item's exact law — seconds-carrier and
  ms-carrier echoes of ONE instant deliver identical ms stamps and identical
  synchronized-clock age/`getAdjustedPosition` extrapolation through the SAME
  handler, and the no-stamp fallback arm stays un-scaled (small-clock vector so
  a wrongful promotion cannot pass the heuristic silently; mutation-proven:
  stripping the decode-site normalize reddens the carrier-pair pin, and 3
  sibling normalization pins move with it). Plus one stale docblock cure:
  `messages.ts` `TimeSyncState.serverTimeSec` claimed "same raw-pass law as
  `onPlaybackSync`'s serverTime" — false since `39433e1` (that stamp is now
  NORMALIZED ms, never raw); rewritten with both-sides producer cites. Rider
  for the server lane (recorded, NOT edited here): the play/pause/seek echo
  fallbacks `?? time()` (`:1076/:1128/:1175`) make the SAME `:8097` handler emit
  TWO scales for one frame type depending on whether the SENDER stamped —
  library-safe under the magnitude heuristic, exposed to non-library wire
  readers; recommended cure is `?? Messages::nowMs()` behind a SPEC producer-
  bytes re-pin. SPEC §4/§8.4 verified current against shipped behavior (no
  drift → untouched). Serial suite 7 files / 172 → 174 (+2 exact);
  typecheck/lint clean; `dist/` rebuilt deterministically (aggregate md5
  `26604ebe439fbc2764899102806c6c08` ×2).
- **`sendSeek` is now a coalescing throttle — command-repeat protection with
  a documented stance (fix lane M-SYNCPLAY-09, review `syncplay__gameux`
  M2; consumer-visible feat — semver MINOR).** A TV remote held on a seek bar
  key-repeats at 10–30 events/s and the pre-fix `sendSeek` (`client.ts:258-269`)
  was a bare synchronous dispatch: every repeat became a
  `syncplay_playback_seek` the server rebroadcasts to EVERY member
  (phlix-server `SyncPlayManager.php:1182`). The server absorbs none of it —
  its only WebSocket limiter guards the CONNECT handshake (30 conns/60 s,
  `RateLimitProfiles::WS_CONNECT`), `JoinPasswordThrottle` guards wrong group
  passwords, and `queue_limit_exceeded` (`SyncPlayManager.php:1256`) caps
  media-QUEUE depth, not command rate (all three cross-repo verified @tip).
  Shipped: leading + trailing throttle windowed by the ADDITIVE constructor
  option `seekThrottleMs` (default 250 ms; parse-at-the-boundary — negative /
  non-finite values throw a descriptive `TypeError`). The first call of a
  burst dispatches SYNCHRONOUSLY (leading edge — single-press UX is
  byte-identical to the old path, so every existing consumer call pattern —
  phlix-ui `api/syncplay.ts` case 'seek', phlix-tizen store `sendSeek(0, …)`,
  the pinned-`#v0.1.5` bundles — keeps working unchanged); repeats inside the
  window merge LATEST-WINS (intermediate seek targets are meaningless) and
  exactly ONE trailing frame carrying the last target flushes at the
  boundary — a sustained hold is wire-capped at 4 frames/s. `0` is the
  documented escape hatch: pure passthrough, zero timers (this library's one
  owned-timer exception; class-header + `onDisconnect` "schedules no timers"
  claims amended to "no PERIODIC timers" accordingly). `leaveGroup()` /
  `onDisconnect()` EAGERLY cancel a not-yet-flushed trailing seek (pinned by
  pre-advance timer-count assertions so the flush-time group guard cannot
  mask a missing cancel). Stance documented: README "Command repeat policy"
  (seek = library-coalesced; play/pause = per-intent, consumer-side gating —
  latest-wins merging a state EDGE would lose legitimate pauses;
  reportPosition cadence = consumer-owned, seconds-scale, S446 judges those
  reports); SPEC §9.1 gained a pointer sentence (pacing is client behavior,
  wire shape and §9 law untouched). New suite `test/seekCoalescing.test.ts`
  14 tests; serial suite 6 files / 158 tests → 7 / 172 (+14 exact vs 158
  baseline, measured-from-red). Mutation matrix: throttle stripped → exactly
  6 named reds; `onDisconnect`-cancel stripped → 1; `leaveGroup`-cancel
  stripped → 1 (after the named test was hardened to pin EAGER disarm);
  off-mode passthrough broken → 1. Dist rebuild deterministic ×2, aggregate
  md5 25199fb928c41407b6c09bd705e39587. Lands for pinned consumers in the
  next tag wave (v0.1.6); package version untouched in this lane.
- **The S446 `nudge` soft-desync correction is now DELIVERED —
  `handlePlaybackSync` dropped it (fix lane M-SYNCPLAY-08, review
  `syncplay__gameux` M1).** The server's owner-ruled out-of-sync reaction
  ("a rate-limited NUDGE — never a seek", phlix-server `GroupState.php:39`)
  rides the SAME `syncplay_playback_sync` frame family as an additive
  object, unicast to the drifting member by
  `SyncPlayManager::sendOutOfSyncNudge()` (phlix-server
  `src/Session/SyncPlay/SyncPlayManager.php:1569-1585` @84e55800 —
  `drift_ms`, `direction`, `suggested_rate`, `tolerance_ms`,
  `cooldown_ms`). The library extracted exactly four fields
  (`member_id`, `position`, `is_playing`, `server_time`) and dropped the
  object on the floor, stranding the "nudge, never seek" policy on the
  wire's last hop: embedders could only sniff raw frames. Shipped:
  `PlaybackSyncNudge`/`PlaybackSyncNudgeDirection` types specified to
  producer bytes (docblocks cite the emitter lines and the `GroupState`
  constants it interpolates — rate step 0.1 `:167`, tolerance default
  2000 `:124`, cooldown 1000 `:145`); `onPlaybackSync` gains an ADDITIVE
  5th optional argument (BREAKING-free — 4-arg consumers stay assignable,
  pinned by a test); `normalizeNudge()` carries with the house per-field
  narrowing — an absent `nudge` key (the group echo `:1517-1524` and every
  hub-relay frame) yields `undefined`, never a fabricated object, and a
  foreign `direction` literal is dropped not passed through.
  `PlaybackSyncPayload` gains the wire-true optional `current_media_id`
  (both producers stamp it; not delivered as its own argument — read the
  cached group) and its stale hub cite (`SyncPlayRelayWorker.php:1105/
  :1603`) re-anchored to measured `:1679`. SPEC §4 amended with the
  two-carrier law (echo vs directed nudge, both-sides cites) and §8.4's
  misnomer "S446 idle-host nudge" corrected to the out-of-sync nudge,
  pinned never-stamped on the hub lane (`SyncPlayRelayWorker.php:
  1673-1680` @f85f48ec). Fixtures are producer bytes verbatim from the
  quoted emitters. New suite 7 tests, serial suite 6 files / 158 tests
  (+7 exact vs 151 baseline); carry-through stripped → exactly 3 named
  reds (mutation-proven). Dist rebuild deterministic ×2, aggregate md5
  2327ae219348d8f5964abdce4eb8d423. Additive optional surface for
  pinned-`#v0.1.5` consumers — semver MINOR at the next tag
  (v0.1.5 → v0.2.0; package version untouched in this lane, tag wave
  decides).
- **README quick-start dials now obey the §8.4 carrier law (docs-only, fix
  lane M-SYNCPLAY-07, review `syncplay__docmaint` M7 / `syncplay__writer`
  dup).** Both former examples dialed bare URLs — no credential carrier at
  all — and the direct example omitted the `:8097` port, which points at
  :443 where no WebSocket upgrade exists. Shipped: a new `## Connecting`
  section with two labeled copy-paste-plausible snippets — **Direct —
  server `:8097`** (`wss://{host}:8097/api/v1/syncplay/ws` dialed with
  `['bearer', jwt]`; one law sentence on the bearer target carrier, the
  marker-only 101 echo, and the legacy `?token=` lane's
  credentials-in-URLs caveat, new-code-prohibited per SPEC §8.4) and
  **Via hub relay — `:8804`** (`wss://{hub}:8804/syncplay/{serverId}` with
  `['bearer', relayToken]`; the relay refuses `?token=` by design) — plus
  the Usage-block dial and the reconnect-recipe dial (`new WebSocket(URL,
  ['bearer', token])`) brought to the same law. SPEC.md carried no violating
  dial and is untouched; no `src/` or `dist/` change. Verified against
  producers on disk: phlix-server `SyncPlayAuthMiddleware::resolveHandshakeToken()`
  + `WebSocketServer` handshake gate, phlix-hub `SyncPlayRelayWorker`
  carrier + `/syncplay/{server_id}` path law.
- **`group_state.queue` is now DELIVERED — `handleGroupState` was silently
  dropping the producer's queue (fix lane M-SYNCPLAY-06, review
  `syncplay__docmaint` M2).** SPEC §4 calls the nested `group` block
  "verbatim `GroupState::getState()`", and getState() always emitted
  `queue` (`:8097` `phlix-server` `GroupState.php:970`; the `:8804`
  `phlix-hub` relay synthesizes the same key,
  `SyncPlayRelayWorker.php:1401`) — yet the library rebuilt the group
  field-by-field and discarded it, so a queue UI written to SPEC §4 read
  `undefined` through `onState` while the wire carried the array. Unlike
  `syncplay_playback_queue` (documented-as-ignored at the dispatch), the
  drop was never declared anywhere. Shipped: `PlaybackQueueItem`
  re-specified to producer bytes — `media_id` + `media_info` plus
  server-only `added_at` (UNIX seconds) + `added_by` (nullable host id at
  enqueue, `GroupState::addToQueue()` :812-817); the hub relay narrows
  items to the first two (`:1713-1747`), a per-carrier divergence now
  pinned in SPEC §4 (both the `group_state` and `playback_queue` blocks)
  and in the type docblock — absent on that carrier, never zeroed;
  `SyncPlayGroup` gains `queue?: PlaybackQueueItem[]` (wire inherits via
  `SyncPlayGroupWire`); `handleGroupState` carries it through
  `normalizeQueue` (house per-field narrowing à la `normalizeMembers`;
  a queue-less frame yields `undefined`, never a fabricated `[]`;
  a non-array garbage value degrades to `undefined`, never a throw).
  New `test/groupStateQueue.test.ts`: the primary vector is the VERBATIM
  phlix-contracts capture `syncplay-envelope-vectors.json` rail
  `groupState.state` (four-field item with real producer bytes) plus a
  hub-relay vector mirrored from `canonicalGroupPayload()`/the queue
  parser; 4 of the 6 tests are RED on the parent with the carry-through
  stripped. README quick-start's `onState` line cured. BREAKING? No —
  additive optional field + type widening; the old `PlaybackQueueItem`
  remains structurally compatible. Minor bump at the next tag wave.
  Full serial suite 5 files / 151 tests (+6 exact); typecheck/lint clean;
  dist re-built deterministically (x2, aggregate md5 in the commit body).
- **`group_list` reply rows are now the LIVE PRODUCER shape — `id`, `name`,
  `member_count`, `has_password`, `current_media`, `is_playing` inside the
  `{groups, count}` envelope (fix lane M-SYNCPLAY-05, review
  `syncplay__docmaint` M1).** SPEC §4 documented the client→server request
  and the MED-2 visibility ruling but NEVER the reply row; into that hole the
  library, README and test fixtures all poured the same invented
  `{group_id, group_name, has_password?}` row — which exists on no socket:
  `:8097` `phlix-server` `SyncPlayManager.php` `groupSummary()` :1740-1750
  (reply send :1686-1689) and `:8804` `phlix-hub` `SyncPlayRelayWorker.php`
  `handleCanonicalGroupList()` row :1938-1943 (send :1947-1950) both emit the
  six keys, always. A consumer following the old docs against a live reply
  read `groups[0].group_id` → the library's defensive `''` — the fabricated-
  field-hidden-by-fixture class, this time mirrored only against itself.
  Shipped: SPEC §4 gains a reply block pinning the six keys + `count` with
  producer coords; `GroupListResponsePayload` re-specified truthfully and
  `GroupListSummaryRow` exported; `handleGroupList` maps the real keys with
  total per-field coercion (`current_media` keeps the producer's null
  sentinel, `GroupState.php:565` `?string`); README quick-start line cured;
  test fixtures re-vendored from the quoted producer bytes (provenance header
  in-file) and the two invented-shape coercion tests converted — RED on
  parent (3), green at head. BREAKING signature: `onGroupList` now receives
  `GroupListSummaryRow[]` and `GroupListResponsePayload.groups` re-types —
  estate-wide grep of ui/mobile/server/tizen/windows `src` shows ZERO call
  sites of the WS callback or these types (their `listGroups` hits are the
  separate REST surface, already `id`/`name`-true). Consumers pin remote tags
  (`#v0.1.5`); cascade rides the next tag wave. Full serial suite 4 files /
  145 tests (delta 0 — in-place conversion, fixtures re-vendored not
  counted); typecheck/lint clean; dist re-built deterministically.
- **`playback_sync` (and the play/pause/seek echo) `server_time` — the
  consumer contract is now milliseconds on BOTH carriers (fix lane
  M-SYNCPLAY-04, review `syncplay__crossfe` M4).** The library delivered the
  raw wire stamp, but the two carriers disagree on units: the hub relay
  stamps ms (`phlix-hub` `SyncPlayRelayWorker.php:1105`/`:1603` `nowMs()`),
  while `:8097` stamps UNIX **seconds** (`phlix-server`
  `SyncPlayManager.php:1506` `time()` group echo → broadcast `:1523`, S446
  nudge `:1575`, and the play/pause/seek echo fallback `?? time()` at
  `:1076`/`:1128`/`:1175`). All-ms consumers (`TimeSync.getAdjustedPosition`,
  SPEC §4) fed seconds-scale stamps computed an elapsed of ≈ +56 years of ms
  — the playhead teleported; the burn was already confessed in the wild
  (`phlix-ui` `src/api/syncplay.ts` discarded the callback value with
  `void serverTime;`). Shipped: `SyncPlayClient.serverTimeToMs()`, a public
  static epoch-magnitude normalization (raw < 1e12 → ×1000; epoch-ms crossed
  1e12 on 2001-09-09, epoch-seconds cannot reach it before 33658) applied at
  the three decode sites (`handlePlaybackSync`/`handlePlayback`/`handleSeek`);
  the local-clock FALLBACK (frame missing `server_time`) is already ms and is
  deliberately NOT scaled. Not a signature break — the callback types and
  documented unit law were always ms; this aligns the runtime with them. The
  three stale pass-through pins were re-pinned to wire-truth carrier vectors
  (file:line provenance comments), a six-case normalization suite added
  (pure vectors, both carriers, un-scaled fallback, and an end-to-end
  no-teleport pin through `getAdjustedPosition`); full serial suite 4 files /
  145 tests. SPEC §4/§8.4 prose cured: §8.4's admitted per-carrier split now
  records that the library papers over it at the decode boundary. Same-trap
  family items M-SYNCPLAY-10/14 are cured by this fix and the §4-vs-§8.4 doc
  contradiction (M-SYNCPLAY-15) by the SPEC cure; the nudge-payload sibling
  M-SYNCPLAY-08 is a separate server-side defect, untouched here. Cascade
  deferred per the v0.1.6 wave precedent: consumers
  pin `github:#v0.1.5`, and the estate sweep found no live consumer of the
  delivered value (`phlix-tizen-client` `useSyncPlayStore.ts:615` takes arity
  3; `phlix-ui` discards it — its workaround can retire in the re-tag wave).
- **`TimeSyncPayload` — the TIME_SYNC model now matches the REAL server wire
  (fix lane M-SYNCPLAY-03, review `syncplay__crossfe`).** The interface was
  FABRICATED: it promised `{ server_time (ms), client_time (ms) }` while the
  live emit site (`phlix-server` `SyncPlayManager::handleTimeSync()`,
  `src/Session/SyncPlay/SyncPlayManager.php:1653-1659`) sends seven fields —
  `member_id`, `group_id`, `server_time` (UNIX **seconds**, `time()` — the
  `:8097` legacy quirk), `offset_ms`, `latency_ms`, `drift_rate` (float
  ≈1.0), `is_stable` — and has NEVER carried `client_time` (that name belongs
  to ping/pong only). Consumer bug path: `handleTimeSync()` read the missing
  `client_time` straight off the frame and defaulted it to `0`, handing every
  `onTimeSync` consumer a timestamp that never existed on any socket, while
  the seconds-scale `server_time` was documented as ms. Shipped: wire-truth
  `TimeSyncPayload` (byte-for-byte snake_case per the file's own mirror law),
  a new normalized `TimeSyncState` domain model with units named into the
  fields (`serverTimeSec` vs `offsetMs`), and parse-at-the-boundary handling —
  a frame that misses the server shape is DROPPED (the `handleGroupList`
  precedent) instead of half-defaulted. `onTimeSync`'s callback signature
  changes from `(serverTime, clientTime)` to `(state)`. SPEC.md §3's stale
  one-line stub ("full sync-state broadcast") is cured to the audited field
  list + unicast-reply semantics (the wire authority is the server; the stub
  predated the audit). Tests: the two fiction-pinning `handleTimeSync` cases
  flipped to server-wire truth (fixture provenance file:line-labeled), a
  regression pin proves the historic fabricated shape is now dropped, and
  `messages.test.ts` gains a compile+runtime wire-shape pin. BREAKING for any
  `onTimeSync` consumer — none exists in the estate today (grep zero hits).
- **`SyncPlayClient.handleTimePong()` — SPEC §10.1.3 now enforced on the LIVE
  pong shape; a late pong from a torn-down connection can no longer seed a
  time-sync sample (fix lane M-SYNCPLAY-02, review `syncplay__crossfe` M2).**
  The drop-on-reset rule was only ever half-live: the client's stale-pong
  defence hinged on `lastPingSendTime === null`, but that fires only for pongs
  OMITTING `client_time` — and the live server always echoes the field verbatim
  (`phlix-server` `Messages::timePong()`, round-tripping whatever
  `processPing()` captured; SPEC §10.1.2 blesses the echo as authoritative).
  A still-buffered live-shape pong surfacing after `onDisconnect()` (which
  nulls the recorded send time) therefore still seeded: the quad spanned two
  connections, and on a fast reconnect the bogus RTT could clear the
  1000 ms cap and pollute the offset — the same corruption family as the
  estate's mobile 2×-undercorrect class, measured here not guessed. Shipped:
  an outstanding ping is now required (`lastPingSendTime === null` → refuse,
  encoding §10.1.3's dropped-send-time clause literally and narrowing the
  fallback type), and an echoed `client_time` that does not equal the current
  outstanding send time is refused outright (the server echo makes mismatch
  conclusive at integer-ms granularity); a refused straggler leaves the
  outstanding ping untouched, so the real pong still lands. Regression
  vectors: live-shape pong after disconnect, and a straggler racing a fresh
  ping on the successor connection (reject-then-accept sequence). Mutation
  receipts: full guard revert reddens exactly the two new tests with zero old
  tests failing (the hole had no prior coverage); stripping the echo guard
  reddens only the straggler vector; stripping only the null check typebreaks
  `tsc` (TS2345) — it is load-bearing for the narrowing and the explicit
  fail-fast, its runtime role on the live shape shared with the echo guard.
- **`TimeSync.getOffset()` — the weighted mean no longer crushes realistic
  offsets toward zero (fix lane C09, review `syncplay__gameux` C1).** The
  divisor was `max(1, weightSum)`: with every accepted weight
  `1 / max(1, rtt)` strictly below 1 at realistic RTTs (≥ 20 ms), the window's
  `weightSum` fell below 1, froze the divisor at 1, and returned the raw
  weighted SUM — a true 120 ms offset read back as 3 ms, and `isStable()`/
  `onSync` certified the lie (the library's headline cross-device clock
  alignment was mathematically inert). Cured to SPEC §5's actual weighted mean
  `sum(w * offset) / sum(w)`, guarded only against `weightSum === 0`
  (unreachable: accepted samples carry weight ≥ 1/1000), `Math.round` for
  symmetric whole-ms output (matches the estate's shipped mobile fix
  `phlix-mobile-client` `SyncPlayService.ts`; `trunc` would retain a
  toward-zero bias on negative offsets — SPEC silent on the integer rule,
  disclosed). Honest doc divergence: the server's `TimeSync.php::getTimeOffset()`
  still carries the crush; safe because the aggregation is per-side local math
  and never on the wire (ping/pong carry raw t1/t2 only) — server lockstep fix
  reported to the orchestrator. SPEC §5 gains the explicit divisor law.
  Regression vectors: TV/phone RTT windows (20–100 ms) must land on the 120 ms
  ground truth (pre-fix measured 14), ±2 ms jitter tolerance (pre-fix |Δ|=108),
  low-RTT outlier genuinely dominating a high-RTT consensus (186; pre-fix 111,
  unweighted 134), negative-offset symmetry (−250; pre-fix −31), and the stale
  test header claiming parity with mobile's already-fixed copy is retired.
- **SPEC.md §8.4 — hub carrier cite re-anchored (docs-only micro-nit from the
  dialect-bundle review).** The `:8804` row's first carrier coordinate moved:
  `phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php:47-49` → `:52-55`. The
  carrier law the cite names — "The relay token travels in the upgrade
  request's `Authorization: Bearer` header or its
  `Sec-WebSocket-Protocol: bearer, <token>` subprotocol … NEVER accepted from
  the query string" — now sits at 52-55 (token-verified against the hub tip
  `cc1e128`; the preceding `:47-49` window holds the generic connection
  paragraph). Sibling cites on the same row re-verified current: `:443-446`
  (the `extractClientToken` gate) and `:527-560` (the marker-only 101 echo).
  The inbound-dialect-guard hub lane deliberately line-neutralised its
  class-docblock prose so all three coordinates resolve identically at that
  lane's pushed tip.
- **SPEC.md §3 + §8.4 — the hub relay `:8804` now serves the canonical
  catalog (owner decision #14; docs-only, no library change).** phlix-hub
  `cc1e128` taught `SyncPlayRelayWorker` the `syncplay_*` vocabulary with a
  per-connection dialect latch (first `syncplay_*` frame picks the dialect;
  replies answer in kind; the `syncplay_`-prefixed floor is CLOSED with
  `UNKNOWN_MESSAGE` like `:8097`, while the legacy bare room vocabulary keeps
  its open verbatim floor and has zero live consumers). §8.4 gains the
  dialect law, the `pending_command` orthogonality (a client may run two
  `:8804` sockets per server+owner; `deliverToUser` fans to all), the
  documented hub deviations (hub-issued socket ids as `your_id`/`member_id`,
  shadow rooms scoped per (server, owner) — cross-user relay parties
  impossible by construction, first-member-is-host + join-order election,
  `syncplay_playback_sync` `server_time` in ms on the hub vs the `:8097`
  seconds quirk, `syncplay_time_sync` refused `hub.protocol_unsupported`,
  `password_hash` accepted-and-ignored, S446 nudge not relayed) and the
  mobile-first consumer note (phlix-mobile-client `13715d0` lifted its
  interim `RELAY_NOT_SUPPORTED` refusal in the same decision). §3 gains a
  one-line surface-applicability pointer to §8.4. Hub carrier coordinates on
  the `:8804` row re-anchored for `cc1e128` line shift (`:339-341`→
  `:443-446`, `:441-470`→`:527-560`), token-verified against the hub tip.
- **SPEC.md §8.4 fleet-status refresh (docs-only, no behavior change).** The
  fleet table was tip-stale at authoring (review footnote on the carrier-flip
  pass); every row re-verified against current `origin/master` tips:
  phlix-ui `c0b6af04`→`324b4122` (tip regenerates `dist/` post the
  `be9a5fc5`/`c0b6af04` flips; publishing re-tag still pending, owner-gated),
  phlix-tizen-client `9a5b24b`→`348c6e7` (flip + empty-token subprotocol bail
  at `6707ed3`; tip commit only refreshes committed `package/` output),
  phlix-console-client `04a1590`→`2f0ecf5` (tip adds the `WebSocketDialer`
  `wss://` TLS-dial fix; bearer seam since `04a1590`). phlix-mobile-client
  `bdbe1e1`, phlix-roku-client `07eef68`, phlix-windows-client `c75fdf0`
  unchanged (still the tips). Transitional note sharpened on disk evidence:
  the LAST estate `?token=` producers are the vendored pre-flip
  `@phlix/ui#v0.99.7` SyncPlay widget chunks — windows AND tizen both pin
  `#v0.99.7`, whose dist carries `?token=` with zero bearer offers (verified
  in each repo's installed bundle) — closing when the ui re-tag + consumer pin
  cascade lands (owner-gated). No coordinate re-anchors: all server/hub cites
  re-verified ±3 tokens against phlix-server `c11bd4ac`
  (`SyncPlayAuthMiddleware.php:471-489`, `:87`; `WebSocketServer.php:522-526`,
  `:528-543`, `:554`, `:575-582`) and phlix-hub `8a5dc12`
  (`SyncPlayRelayWorker.php:47-49`, `:339-341`, `:441-470`) — none moved.
- **SPEC.md §8.4 `:8097` carrier flip (docs-only, no behavior change).** The
  `:8097` row moves from CURRENT `?token=` / TARGET bearer to the transitional
  DUAL carrier phlix-server `424c14d0` shipped: two-entry
  `Sec-WebSocket-Protocol: bearer, <jwt>` preferred, legacy `?token=` demoted
  to RETIRING (accepted only while older builds upgrade; removal is an owner
  timing call). Carrier MISMATCH now rejects pre-101 and the 101 echoes the
  `bearer` marker only (gated on the offer). All `:8097` cites re-pinned to
  `424c14d0` — law SSOT `SyncPlayAuthMiddleware::resolveHandshakeToken()`
  (`src/Server/WebSocket/SyncPlayAuthMiddleware.php:471-489`), handshake gate
  + mismatch reject (`src/Server/WebSocket/WebSocketServer.php:522-526`,
  `:528-543`), echo (`:554`, `:575-582`, const `:87` of the middleware) — with
  phlix-server `docs/dev/WEBSOCKET_AUTH_CARRIERS.md` named as the law doc. The
  hub `:8804` bearer-only row is unchanged (cites re-verified against
  phlix-hub `8a5dc12`). Added a dated fleet-status note: ui `c0b6af04`,
  tizen `9a5b24b`, mobile `bdbe1e1`, roku `07eef68`, console `04a1590` flipped
  at tip; windows `c75fdf0` still rides `?token=` via the vendored pre-flip
  `@phlix/ui#v0.99.7` bundle.
- Release @phlix/syncplay v0.1.5 — version bump + rebuilt committed artifacts
- **SPEC.md annotation lane (docs-only, no behavior change).** Three
  wire-truth amendments pinned against the live server/hub implementations:
  §4 documents the DEPRECATED second accepted input on group create/join —
  the legacy plaintext `password` arm the server hashes server-side
  (`SyncPlayManager::groupPasswordGate`), with the clients-MUST-NOT-send rule
  and the REST-boundary reason it survives; new §8.4 codifies the WebSocket
  credential-carrier law per endpoint (`:8097` CURRENT `?token=` query with
  pre-101 rejection, TARGET `Sec-WebSocket-Protocol: bearer, <token>` as
  tracked estate debt; hub `:8804` bearer-subprotocol ONLY, query refused —
  S237); §2 gains the units footnote pinning the one hub-relay exception —
  `:8804` stamps milliseconds except `pending_command.issued_at`, which is
  UNIX SECONDS by deliberate design.

## [0.1.4] - 2026-09-01

The wire-truth release (lane s279b, S416). Ships the previously-unreleased
S294 + S298 work together with the members-dict normalization fix below.
**Consumers currently pin v0.1.2 and are NOT bumped by this tag** — the
re-pin is deliberately its own wave (S418) because the v0.1.2→v0.1.4 delta
carries behavior, not just types.

### Fixed

- **`handleGroupState` no longer drops the server's members DICT to `[]`
  (S416).** The live wire carries `group.members` as a DICTIONARY keyed by
  member id — the shape `GroupState::getState()` has emitted since the
  initial SyncPlay commit (V1; measured, not assumed) — but the decoder's
  only branch read `Array.isArray(group.members) ? … : []`, so EVERY
  consumer going through the library silently saw ZERO members on every
  `syncplay_group_state` frame. `SyncPlayClient` now folds the dict
  (`Object.entries`, the entry KEY authoritative for `id`) into the library's
  array model behind decode; the array spelling stays accepted (it is the
  library's own output shape — re-fed frames keep working); genuinely
  non-collection values still fall back to `[]`. New test file
  `test/s416DictMembers.test.ts` pins both spellings — the dict vector is the
  REAL captured envelope (provenance: server `01340633`, dumped by
  phlix-contracts' `scripts/dump-server-syncplay-vectors.php`) and was
  mutation-verified RED against the pre-fix client before shipping GREEN.
  New exported wire type + input-side payload type (`GroupStatePayload.group`
  now types the frame AS RECEIVED; the normalized members-array output model
  is unchanged, so no consumer code moves on re-pin beyond the fix itself).
  SPEC §4's self-inconsistent example (claimed "verbatim getState()" while
  showing an array) is corrected to the dict — the "identity is `group_id`,
  NOT `id`" point it was made to illustrate stays.
- **The host now consumes its own echoed `playback_sync`, so a one-member room
  re-anchors (S294).** `handlePlaybackSync()` previously dropped every frame whose
  `member_id` was its own id — but the server broadcasts `playback_sync` to ALL
  members stamped with the HOST id (it excludes nobody, unlike play/pause/seek),
  so the host's own authoritative frame came back and was discarded and nobody
  re-anchored. Frame-type decision: a self `playback_sync` is a server-echoed
  STATE REPORT, now CONSUMED (the host re-anchor source); COMMAND frames from
  self are STILL dropped (guard remains in `handlePlayback`/`handleSeek`). Proven
  over the real wire path (encodeMessage + serializeMessage + handleIncoming)
  plus the server E2E suite; positions stay ms (SPEC §4), receive path untouched.

### Added

- **The phantom "custom transport hook" is now real: `onUnknownFrame` (S298).**
  `SyncPlayClient` previously dropped every frame whose `type` was outside the
  19 canonical `syncplay_*` types in the `default:` arm, while a comment promised
  an extension point that did not exist. Frames from non-SyncPlay vocabulary —
  e.g. the hub relay's `pending_command` push — now reach the consumer via
  `SyncPlayClientOptions.onUnknownFrame` untouched and unvalidated (new exported
  `UnknownFrame` type; `type` is a plain string so consumers compare it against
  their own vocabulary without a cast). The two canonical types the library does
  not orchestrate (`syncplay_chat`, `syncplay_playback_queue`) stay silently
  ignored, and undecodable input is still ignored — the library remains
  protocol-pure; consumers route the hub vocabulary themselves.

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
