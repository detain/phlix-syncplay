# Phlix SyncPlay Wire Protocol — Canonical Specification

This document is the single source of truth for the Phlix SyncPlay protocol, so
that every client (mobile / windows / tizen JS, Roku/BrightScript) and the PHP
server can be checked against ONE spec.

The authoritative implementation is the PHP server:

- `phlix-server/src/Session/SyncPlay/Messages.php` — message types + payloads
- `phlix-server/src/Session/SyncPlay/TimeSync.php` — NTP time-sync math
- `phlix-server/src/Session/SyncPlay/SyncPlayManager.php` — dispatch + emitted shapes

`@phlix/syncplay` is the canonical JS port of that protocol.

> **Document revision:** 2026-11-03 — wire era `@phlix/syncplay` v0.1.6. This
> stamp is rotated with every normative edit to this document (per §1 item 6's
> era-pin discipline), so a consumer can answer "which spec revision does my
> build conform to?" without git archaeology.

---

## Contents

1. [Canonical decisions (read these first)](#1-canonical-decisions-read-these-first)
2. [Framing](#2-framing)
3. [Message types (all 19)](#3-message-types-all-19)
4. [Message payloads (exact wire fields)](#4-message-payloads-exact-wire-fields) — subsections `4.1`–`4.6`
5. [NTP time synchronization (mirrors `TimeSync.php`)](#5-ntp-time-synchronization-mirrors-timesyncphp)
6. [Member-event handling (what the server ACTUALLY does)](#6-member-event-handling-what-the-server-actually-does)
7. [Normalized client divergences](#7-normalized-client-divergences)
8. [Security model](#8-security-model) — subsections `8.1`–`8.4`
9. [Server-derived identity contract](#9-server-derived-identity-contract-member_id--host_id) — subsections `9.1`–`9.2`
10. [Reconnect & resume recovery](#10-reconnect--resume-recovery) — subsections `10.1`–`10.3`

---

## 1. Canonical decisions (read these first)

1. **Message-type prefix is `syncplay_` with an UNDERSCORE.**
   e.g. `syncplay_group_create`. Roku's `syncplay.` (dot) prefix is WRONG.

2. **Transport is WebSocket.** Roku's HTTP-POST approach is non-conformant —
   SyncPlay is a bidirectional, server-pushed protocol.

3. **Framing is a FLAT JSON object** (see §2). The Tizen client's
   `{ type, data, timestamp }` wrapper (payload nested under `data`) is
   **deprecated** — the server reads top-level fields and ignores `data`.

4. **`protocol_version` is `1`** and is included on every message.

5. **The server is the source of truth.** Clients MUST follow the shapes the
   server actually emits, not invent their own (see §7 divergences).

6. **Server/hub coordinates are era-pinned snapshots.** Line numbers cited
   for `phlix-server` / `phlix-hub` drift with every server commit; an
   `@ <sha>` stamp at a cite cluster names the exact tree it was verified
   against. **Class and method names are the durable anchors** — trust
   those, and re-verify a bare line number against your checkout before
   acting on it.

7. **Keyword discipline.** Uppercase `MUST`, `MUST NOT`, `SHOULD`, and `MAY`
   carry their RFC 2119 meanings and are normative for consumers of this
   contract; lowercase "must/should/may" is descriptive prose (server
   behavior or a stated possibility) and imposes no client requirement.

---

## 2. Framing

Every message — inbound or outbound — is a single flat JSON object:

```json
{
  "type": "syncplay_<name>",
  "protocol_version": 1,
  "timestamp": 1700000000000,
  "...": "payload fields at the top level"
}
```

- `type` — one of the 19 types in §3.
- `protocol_version` — always `1`.
- `timestamp` — sender wall-clock at send time, in **milliseconds**. Optional
  on inbound; always present on outbound from `@phlix/syncplay`.
- All payload fields are spread at the **top level** (NOT nested under `data`).

> **Units footnote — the §4 unit law, hub-relay detail site.** There is no
> hub-wide "everything is milliseconds" rule on `:8804`, and this footnote
> states no universal of its own — it restates §4's roster for this carrier,
> delegating every unit to that law. Per §4: the envelope `timestamp` is ms;
> `server_time` is ms **here**, because the hub never stamps a seconds
> `server_time` and the seconds side of §4's "Named exception" is `:8097`
> server-stamped arms only; the §4 family-(ii) roster/lifecycle stamps
> `joined_at`, `created_at`, `last_activity_at` and `added_at` are UNIX
> SECONDS **here too** — the hub's own docblock concurs
> (`phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php:1367`; `$now = time()` at
> `:1376`, emitted at `:1385`/`:1402`/`:1403`). The one unit stated as fact
> rather than delegated is outside §4's field scope: `pending_command` is the
> push/Alexa delivery lane, not one of §3's syncplay types, and its envelope's
> `issued_at` is **UNIX SECONDS** — deliberately, matching the DB `TIMESTAMP`
> it mirrors (the hub's own unit note:
> `phlix-hub/src/SyncPlay/PendingCommandDispatcher.php:117-119`, value written
> at `:132` via `time()`). Comparison scale: `issued_at` is already seconds —
> the same scale as a JWT `exp` claim (RFC 7519 seconds; the hub signs
> `time() + $ttl` in `src/Hub/EnrollmentJwtService.php:101-112`) and the §4
> (ii) roster stamps, so compare those directly; against an ms-scale stamp — a
> frame `timestamp`, or a hub `server_time` — multiply `issued_at` by 1000
> first. The exception is pinned so no consumer "fixes" it into drift. This
> footnote is a detail site for §4's named exceptions plus one
> out-of-§4-scope delivery-metadata note, not a second authority.

`@phlix/syncplay` `encodeMessage(type, payload, now)` produces this object;
`decodeMessage(raw)` parses it and, for backward compatibility only, unwraps the
deprecated `{ type, data, timestamp }` Tizen envelope into the flat form.

Terminology: the wire object for a synced session is a **group** —
`syncplay_group_*` types, `group_id`/`group_name` fields (§3, §4). The hub's
legacy bare-room dialect on `:8804` (§8.4) calls the same object a **room**;
this document uses *room* only where it names that hub dialect.

---

## 3. Message types (all 19)

Mirrors `Messages::TYPE_*` exactly. Served by the server's `:8097` socket
and — since phlix-hub `cc1e128` (owner decision #14) — by the hub `:8804`
relay's room lane as well; §8.4 states the hub's dialect latch and the
documented per-surface deviations.

| Constant        | Wire string                | Direction        |
|-----------------|----------------------------|------------------|
| GROUP_CREATE    | `syncplay_group_create`    | client → server  |
| GROUP_JOIN      | `syncplay_group_join`      | client → server  |
| GROUP_LEAVE     | `syncplay_group_leave`     | client → server  |
| GROUP_STATE     | `syncplay_group_state`     | server → client  |
| GROUP_LIST      | `syncplay_group_list`      | both             |
| PLAYBACK_PLAY   | `syncplay_playback_play`   | both             |
| PLAYBACK_PAUSE  | `syncplay_playback_pause`  | both             |
| PLAYBACK_SEEK   | `syncplay_playback_seek`   | both             |
| PLAYBACK_QUEUE  | `syncplay_playback_queue`  | both             |
| PLAYBACK_SYNC   | `syncplay_playback_sync`   | both             |
| CHAT            | `syncplay_chat`            | both             |
| TYPING          | `syncplay_typing`          | both             |
| HOST_TRANSFER   | `syncplay_host_transfer`   | client → server  |
| HOST_ELECT      | `syncplay_host_elect`      | server → client  |
| TIME_PING       | `syncplay_time_ping`       | client → server  |
| TIME_PONG       | `syncplay_time_pong`       | server → client  |
| TIME_SYNC       | `syncplay_time_sync`       | both             |
| ERROR           | `syncplay_error`           | server → client  |
| INFO            | `syncplay_info`            | server → client  |

---

## 4. Message payloads (exact wire fields)

All field names are **snake_case**.

> **§4 UNIT LAW — the single authority on wire time units.** Positions and
> durations are **milliseconds** on both carriers, as is the envelope
> `timestamp` (§2). Two families of wall-clock stamps depart from that, and
> this text is where both are ruled: (i) `server_time`, the protocol's only
> MIXED-unit field, carries the per-carrier named exception stated below and
> referenced by every mention-site in this section; (ii) the roster/lifecycle
> stamps `joined_at`, `created_at`, `last_activity_at` and `added_at` are
> **UNIX SECONDS on every carrier by design** — a stable per-field unit, not a
> per-carrier quirk (server `GroupState.php:241-242`/`:399`/`:813` `time()`;
> hub `SyncPlayRelayWorker.php:1367` states the same law) — and each names its
> unit inline at its field line. No other section states a unit law: the §2
> units footnote and the §8.4 carrier table are detail sites for these
> exceptions and defer to this text.
>
> **Named exception — `server_time` in UNIX SECONDS (`:8097` only).** The
> `:8097` server stamps `time()` (SECONDS) on every `server_time` it WRITES:
> the `playback_sync` group echo and the S446 nudge unicast
> (`phlix-server/src/Session/SyncPlay/SyncPlayManager.php` `handlePlaybackSync()`,
> echo `:1517-1524`, nudge `:1569-1585`), the `time_sync` advisory reply
> (`handleTimeSync()` `:1652-1660`), and the play/pause/seek echo FALLBACK
> (`:1076` / `:1128` / `:1175` `?? time()`) — a sender-supplied ms stamp is
> echoed verbatim, so even one frame type can carry either scale depending on
> the sender. Outside those arms the field is ms: the `:8804` hub relay NEVER
> emits a seconds `server_time` (it stamps `nowMs()` and passes a sender's ms
> stamp through untouched), and `time_pong`'s `server_time` is ms on BOTH
> carriers (server `TimeSync::processPing()` `(int)(microtime(true) * 1000)`).
> The exception covers the `:8097` server-stamped arms above and nothing else.
>
> **Delivery policy — what `@phlix/syncplay` consumers see.** Playhead-bearing
> frames are normalized to ms AT PARSE: `SyncPlayClient.serverTimeToMs`
> (`src/client.ts`, epoch-magnitude rule) is applied by `handlePlayback`,
> `handleSeek` and `handlePlaybackSync`, so `onPlaybackCommand` and
> `onPlaybackSync` receive milliseconds whichever carrier stamped. The ONE
> deliberate verbatim arm is the `time_sync` advisory: `handleTimeSync`
> surfaces its seconds stamp UNCONVERTED as the unit-named `serverTimeSec`,
> because that snapshot's siblings are `_ms`-named and it is read per-field
> (see the §4 `time_sync` block below). A consumer that needs ms there
> multiplies by 1000 itself.
>
> **Clamping law.** Playhead numbers this library hands consumers are bounded
> when a cached duration exists: `SyncPlayClient.positionOrDrop`
> (`src/client.ts`) drops non-finite or negative positions and clamps
> beyond-duration ones to the cached `group.current_media_duration` (the
> field's "useful for clamping" note in §4.1 is now enforced, not advisory).
> The as-of reference for a `group_state` position remains unstamped — that
> half is §10.2's join catch-up clause, an OPEN decision.

### 4.1 Group management

`syncplay_group_create` (client → server)
```
group_name: string
member_id?: string         (defaults to the connection id server-side)
member_name?: string       (defaults to "Host")
password_hash?: string     (unsalted SHA-256 hex of the password)
password?: string          (DEPRECATED legacy plaintext arm — see note below)
```

`syncplay_group_join` (client → server)
```
group_id: string
member_id?: string
member_name?: string
password_hash?: string
password?: string          (DEPRECATED legacy plaintext arm — see note below)
```

> **DEPRECATED second accepted input — legacy plaintext `password`.** The
> server's group gate parses a second, pre-spec field: when `password_hash`
> is absent, a plaintext `password` is accepted and hashed **server-side**
> (`phlix-server/src/Session/SyncPlay/SyncPlayManager.php:2157-2178`,
> `groupPasswordGate()` — called for create at `:1779` and join at `:1832`;
> @ `bc3b9b33`).
> `password_hash` wins when both are present; a present-but-malformed
> `password_hash` is refused, never coerced. The plain-HTTP REST boundary
> (`SyncPlayController::createGroup` `:158`/`:164` and `joinGroup` `:252`/`:262`,
> `src/Server/Http/Controllers/` @ `bc3b9b33`)
> still accepts **only** plaintext `password` in its body, which is why the
> arm survives. **New clients MUST NOT send `password` on the WebSocket** —
> send `password_hash` (unsalted SHA-256 hex) exclusively; the plaintext arm
> exists solely so pre-spec callers keep working and is estate debt for a
> future REST carrier migration. See §8.2 for why either field is a weak
> group gate, never identity.

`syncplay_group_leave` (client → server)
```
group_id: string
member_id: string
```

`syncplay_group_state` (server → client) — **nested**, the historical trap
```
group: {                            (verbatim GroupState::getState())
  group_id: string                  (NOT `id` — that's a members-only field)
  group_name: string                (NOT `name`)
  member_count: number
  members: {                        (a DICT keyed by member id — NOT an array;
    <member_id>: {                    the entry key equals the value's `id`)
      id: string, name: string,
      is_host: boolean, joined_at: number (unix seconds)
    }, ...
  }
  host_id: string | null
  current_media_id: string | null
  current_media_duration: number    (ms; useful for clamping positions)
  playback_position: number
  playback_state: "playing" | "paused" | "buffering" | "stopped"
  queue: [ { media_id, media_info, added_at, added_by }, ... ]
                                          (item fields per-carrier — see note)
  created_at: number                    (UNIX seconds — both carriers)
  last_activity_at: number              (UNIX seconds — both carriers)
}
your_id?: string           (the recipient's own member id)
```
> The server emits the full group under `group` and the recipient id under
> `your_id`. It does NOT flatten group fields onto the envelope. The group
> identity uses `group_id` / `group_name`; only the **members** use `id` / `name`
> — and members ride as a **dictionary keyed by member id** (the shape
> `GroupState::getState()` has emitted since the first SyncPlay commit). The
> library's `handleGroupState` normalizes that dict into its array model
> (`SyncPlayGroup.members: SyncPlayMember[]`), tolerating the array spelling
> for re-fed frames (S416). An array-only reader silently saw ZERO members on
> every live frame — the exact bug class this note exists to kill.
> `queue` item fields are **per-carrier**: the `:8097` server stamps every
> item with `added_at` (UNIX seconds) + `added_by` (host member id at enqueue
> time, nullable) — `GroupState.php` `addToQueue()` :812-817, nested at
> `getState()` :970 — while the `:8804` hub relay narrows items to
> `media_id` + `media_info` (`SyncPlayRelayWorker.php` :1713-1747, emitted
> :1401/:1764); there those keys are ABSENT, never zeroed. The library
> delivers the array under `SyncPlayGroup.queue` exactly as the frame
> carried it (M-SYNCPLAY-06: `handleGroupState` used to drop the field).
> `has_password` is NOT emitted here — it appears only in the `listGroups()`
> summary, never on a `group_state` message. `playback_position` is what a
> joiner adopts as its starting point; it carries no as-of stamp — see §10.2's
> join catch-up clause.

`syncplay_group_list` (client → server) — bare request, no fields.

`syncplay_group_list` (server → client reply) — **live-producer truth, both
carriers** (`:8097` `phlix-server` `SyncPlayManager.php` `handleGroupList`
reply send :1686-1689 + `groupSummary()` :1740-1750; `:8804` `phlix-hub`
`SyncPlayRelayWorker.php` `handleCanonicalGroupList` :1925-1950, whose row
literally mirrors the Server summary). Payload keys alongside the
`Messages::frame` envelope:
```
groups: [                          (array of summary rows — SIX keys, always all emitted)
  {
    id: string                     (the group id — NOT `group_id`)
    name: string                   (display name — NOT `group_name`)
    member_count: number           (integer)
    has_password: boolean          (real bool, always present; hub: always false —
                                    it gates by ownership scope, not passwords)
    current_media: string | null   (media id or null — NOT an "und" sentinel)
    is_playing: boolean
  }, ...
]
count: number                      (integer, === groups.length on both producers)
```
> This block exists because the reply row was NEVER documented here, and the
> library/README/test all drifted into an invented `{group_id, group_name,
> has_password}` row that matches no wire byte on either carrier — reading
> `groups[0].group_id` against a live reply yields nothing. `id`/`name` are the
> summary spelling (like the REST listing rows); the `group_id`/`group_name`
> spelling belongs ONLY to the nested `group_state.group` block above.

The server's `syncplay_group_list` reply is scoped per requester: groups the
requester is a member of, plus every group when the requester is an active
admin (MED-2 owner ruling 2026-10-02 — visibility is members-or-admin; joining
by known id + password is unaffected, the reply shape is unchanged). The same
ruling gates the REST reads `GET /api/v1/syncplay/groups` and
`GET /api/v1/syncplay/groups/{id}` (a non-member's read of a foreign group is
an existence-agnostic 404).

### 4.2 Playback control (play/pause/seek/queue host-only on the server, non-hosts get a `NOT_HOST` error; `syncplay_playback_sync` is the member-permitted state report — §9 item 2)

`syncplay_playback_play` / `syncplay_playback_pause`
```
group_id: string
member_id: string
position: number
server_time: number        (ms; the :8097 echo fallback is the §4 unit law's
                            named seconds exception; the library normalizes
                            echoes to ms — §4 delivery policy)
```

`syncplay_playback_seek`
```
group_id: string
member_id: string
from_position: number
to_position: number
server_time: number        (same §4 unit law as play/pause above)
```

> **Echo shapes (both directions, per type — the echo is NOT the sender's
> shape).** On `:8097` (verified `SyncPlayManager.php`
> `handlePlaybackPlay()` / `handlePlaybackPause()` / `handlePlaybackSeek()`
> @ `6437e318`): an accepted command re-broadcasts under the same type
> carrying `member_id` (the server-derived sender id — the claim is
> overwritten, §9 item 3), the positions (`position`, or
> `from_position`/`to_position` for seek) and `server_time` — the sender's own
> value echoed verbatim, or the `?? time()` seconds fallback (the §4 named
> exception). **The echo omits `group_id`** — membership is implicit in the
> fan-out, the chat law again. Fan-out EXCLUDES the sender for pause and seek;
> PLAY is the asymmetric one: the server unicasts the identical frame to the
> host as a self-confirmation and then broadcasts the same bytes to all OTHER
> members (the `@fires` docblock states this ordering). Consumers MUST parse
> echoes by (type, fields-present), never by reusing their outbound request
> shape; `@phlix/syncplay` relies on exactly these facts (§9.1 self-echo
> suppression, host-side PLAY confirmation).

`syncplay_playback_queue` (both directions — the shapes DIFFER)
```
client → server (host replaces the queue; Messages::playbackQueue,
               `Messages.php:502-511`-family factory shape):
group_id: string
queue: [ { media_id: string, media_info?: object }, ... ]

server → group (broadcast after the update is ACCEPTED):
queue: [ { media_id: string, media_info?: object,
           added_at?: number (unix s), added_by?: string | null }, ... ]
```
> Same queue array semantics as `group_state.group.queue`, same per-carrier
> item law (`:8097` `SyncPlayManager.php:1271-1273` broadcasts
> `getPlaybackQueue()` — full four-field items stamped by `addToQueue()`
> (`GroupState.php:812-817`); the hub relay's broadcast
> `SyncPlayRelayWorker.php:1763-1765` carries `media_id` + `media_info` only
> — narrowed at :1713-1747, `added_*` ABSENT, never zeroed). The BROADCAST
> carries NO `group_id`/`member_id` (the producers derive both server-side,
> S289); fan-out includes the sender on both carriers. Refusals are separate
> error frames (`syncplay.queue_limit_exceeded` `SyncPlayManager.php:1253-1263`
> / `NOT_HOST` :1219; hub :1707 / :1748-1757) with the live queue UNTOUCHED —
> and there is no `group_state` re-broadcast after an accepted update
> (`publishSnapshot()` :1278 is an internal HTTP-worker snapshot), so this
> broadcast is the ONLY live queue-change signal. The library orchestrates
> it since M-SYNCPLAY-11: `onQueueChanged` fires with the normalized queue
> and the cached group is folded (former "carried-but-not-orchestrated /
> ignored by design" law retired; reading the queue off `onState` remains
> valid for the `group_state` copy).
>
> **`media_info` is an opaque host-supplied payload.** The server stores the
> enqueuer's object verbatim (`GroupState::addToQueue()` stamps `media_id`,
> `media_info`, `added_at`, `added_by` and nothing inside the info dict,
> @ `6437e318`) and neither carrier validates or decorates it — there is no
> minimum-key profile, not even `title`. Queue rows therefore diverge
> cross-client BY CONSTRUCTION unless consumers render defensively: tolerate
> any subset of keys, unknown extras, and per-item heterogeneity (each row
> carries whatever its enqueuer chose to send).

`syncplay_playback_sync` (periodic position broadcast)
```
group_id: string
member_id: string          (echo: HOST id — `SyncPlayManager.php:1518`; nudge frame:
                            the DRIFTING member's own id — :1570)
current_media_id: string|null  (:1520 echo, :1572 nudge; hub relay
                                 `SyncPlayRelayWorker.php:1676`)
position: number
is_playing: boolean
server_time: number        (§4 named exception: UNIX seconds on :8097, ms on hub;
                            delivered as ms via serverTimeToMs — §4 delivery policy)
nudge?: {                  (S446 soft-desync correction — directed frames ONLY, see below)
  drift_ms: number,        (group position − reported position, ms; >0 = behind — :1566)
  direction: 'behind' | 'ahead',   (:1578)
  suggested_rate: number,  (1 ± 0.1 — `GroupState::NUDGE_RATE_STEP` :167; :1579-1581)
  tolerance_ms: number,    (group position tolerance — default 2000, `GroupState.php:124`; :1582)
  cooldown_ms: number      (`GroupState::NUDGE_COOLDOWN_MS` = 1000 — `GroupState.php:145`; :1583)
}
```
> Broadcast to every group member including the originator — the server does not
> exclude the sender for this type (unlike play/pause/seek) and stamps the frame
> with the HOST id; see §9.1. That is the GROUP ECHO
> (`SyncPlayManager.php:1517-1524`, phlix-server @84e55800); it never carries
> `nudge`. The same frame type additionally serves the S446 out-of-sync
> reaction: when a member's ingested report falls outside the group tolerance
> (guard :1529-1531, cooldown slot claim :1561), the server UNICASTS that one
> member a second frame of this type carrying the `nudge` object above
> (`sendOutOfSyncNudge()` :1569-1585) — an additive payload on the existing
> type (S417 outbound rule), stamped with the recipient's own id, position
> and `is_playing` from the authoritative group state. The owner policy is
> "a rate-limited NUDGE — never a seek" (`GroupState.php:39`): a consumer
> applies `suggested_rate` as playRate instead of seeking. The library
> delivers it as the optional 5th argument of `onPlaybackSync`; on every
> frame that carried none — echo and hub alike — the argument is `undefined`,
> never a fabricated zero object.

### 4.3 Chat

`syncplay_chat` (both directions — the shapes DIFFER; M-SYNCPLAY-11 cure of the
single-shape drift)
```
client → server (any member; Messages::chatMessage `Messages.php:564-574`):
group_id: string
member_id: string          (SELF-ASSERTED — the server never reads it, S289:
                            `SyncPlayManager.php:1297` derives the speaker from
                            the authenticated connection)
message: string

server → group (broadcast of the accepted message):
member_id: string          (AUTHENTICATED id — overwrites the claim)
member_name: string        (group member record, server fallback 'Unknown' :1312)
message: string
```
> The broadcast carries NO `group_id` key — membership is implicit in the
> fan-out. A blank/whitespace message is dropped IN SILENCE on both carriers
> (server :1314-1316, hub `SyncPlayRelayWorker.php:1791-1793`): no error frame,
> no echo. Envelope `timestamp` is the authoritative send time in
> MILLISECONDS on both carriers (`Messages.php:924-927` microtime×1000; hub
> `canonicalFrame` `nowMs()` :1230) — the seconds-level payload duplicate was
> dropped at S417. Fan-out INCLUDES the sender on both carriers
> (`broadcastToGroup` default `$excludeIds = []`, `SyncPlayManager.php:1932`,
> the chat call at :1323 passes none; hub :1795 omits the exclusion): your own
> message comes back to you. The library delivers every chat frame — echo
> included — via `onChat(memberId, memberName, message, timestampMs)`; the
> outbound arm is `sendChat(message)`.
>
> **Chat is ephemeral, and the echo is the only receipt.** No carrier stores
> chat history: a joiner (or rejoiner) sees only messages sent after
> admission — an empty pane after joining or reconnecting is conformant
> behavior, not a bug. There is no message id and no delivery acknowledgement
> anywhere on this type: because the fan-out includes the sender, the sender's
> own echo is the SOLE receipt signal. An optimistic UI that renders on send
> MUST reconcile against the echo (dedupe by `(member_id, message,
> timestamp)`), and a message whose echo never arrives was refused or lost
> with no machine-readable outcome either way — stating that limit is all the
> contract can honestly offer without a new ack frame (wire addition: not
> made here).

`syncplay_typing` (both directions)
```
client → server (any member; Messages::chatTyping `Messages.php:590-600`):
group_id: string
member_id: string          (self-asserted — ignored, S289 :1364)
is_typing: boolean         (producers read `=== true` or legacy `'1'`:
                            server :1375, hub :1822-1823)

server → group (broadcast):
member_id: string          (authenticated id)
is_typing: boolean
```
> Unlike chat, the typing fan-out EXCLUDES the sender (server `[$memberId]`
> :1380, hub `$client->clientId` :1828) and guard misses are SILENT (no error
> frames for a transient indicator). Inbound is delivered by `onMemberTyping`;
> outbound is `sendTyping(isTyping)` since M-SYNCPLAY-11 (the inbound arm was
> already wired — the missing sender half made the indicator one-way).
>
> **Typing has no protocol-level cleanup floor.** The wire carries only
> explicit `is_typing` flips. A member whose socket drops mid-typing sends no
> `false`, and nothing fabricates one: neither carrier re-broadcasts a
> typing-off frame on departure, and `@phlix/syncplay` fires no
> `onMemberTyping(false)` when its roster diff removes the typer (verified:
> the leave path fires membership events only). Consumers MUST expire stale
> typing indicators locally — a few-second timer per typer, reset by each
> `true`, cleared on that member's departure — or bind the indicator to
> roster presence outright.

### 4.4 Host management

`syncplay_host_transfer` (client → server, voluntary)
```
group_id: string
current_host_id: string
new_host_id: string
```

`syncplay_host_elect` (server → client, automatic when host leaves)
```
group_id?: string         (legacy `Messages::hostElect` factory ONLY — the live
                           broadcasts on BOTH carriers omit it: `:8097`
                           `SyncPlayManager.php:941-945` @814369eb, hub relay
                           `SyncPlayRelayWorker.php:2073-2076` @f26eecad;
                           §1 item 6 governs the stamps)
elected_id: string | null
elected_by: string
```

> Moderation scope (catalog truth): the 19-type catalog carries NO kick, mute,
> password-rotate, or forced-rename frame. A host's remedies against a
> disruptive member are social (they leave) or destructive (the group empties).
> There is no server-side kick primitive to build against; machine-enforced
> moderation is out of v1 scope.

The `string | null` domain of `elected_id` has exactly three cases: a leave
that EMPTIES the group broadcasts nothing at all (the cleanup branch destroys
the group silently — phlix-server `SyncPlayManager.php:947-951`); when members
remain, `GroupState::removeMember()` re-elects the oldest surviving member
before the broadcast reads `getHostId()`, so a LIVE election frame always
carries a non-null successor (`:953-960`, `GroupState.php` `removeMember()` →
`electNewHost()` @ `6437e318`; the hub's leave path mirrors the oldest-present
rule); and the null arm itself survives only because the legacy
`Messages::hostElect` factory permits it — no current producer emits it on
either carrier. Consumers MUST treat `elected_id: null` as "no host — await
the next `group_state`", never as a roster mutation on its own, and MUST NOT
build UI on its expected frequency: today that frequency is zero.

### 4.5 Time sync (see §5)

`syncplay_time_ping` (client → server)
```
client_time: number        (t1: client send time, ms)
```

`syncplay_time_pong` (server → client)
```
client_time: number        (echoed t1)
server_time: number        (t2: server RECEIVE time, ms on BOTH carriers — explicitly
                            NOT the §4 seconds exception)
protocol_version: number
```
> There is **no** `server_receive_time` / t3 field. `server_time` IS the server
> receive time. The client MUST derive RTT from t1 and t4 only (it passes
> `t3 = t2` to the sample function).

`syncplay_time_sync` (server → client) — advisory sync-STATE snapshot. The §3
direction column reads `both` for this type: the inbound arm is a member's
request (the server registers a handler for it; the hub `:8804` refuses it —
§8.4), and what that request buys is exactly the frame documented here — a
**unicast reply** on the connection that sent it
(`phlix-server` `SyncPlayManager::handleTimeSync()`, emit at
`src/Session/SyncPlay/SyncPlayManager.php:1650-1658` @ `bc3b9b33`) — NOT a group broadcast
(the old one-line stub here predated the field audit). Units are mixed per
field — this is the §4 unit law's named exception in its `time_sync` arm:
`server_time` is UNIX **seconds** on `:8097`, the `_ms` fields are
milliseconds.

```
member_id: string          (server-derived requester identity — S289, payload member_id ignored)
group_id: string
server_time: number        (UNIX SECONDS via time() — NOT ms; the library
                            delivers it VERBATIM as `serverTimeSec`, never
                            normalized — §4 delivery policy)
offset_ms: number          (server TimeSync::getTimeOffset(), ms)
latency_ms: number         (server TimeSync::getEstimatedLatency(), ms)
drift_rate: number         (server drift factor, float ≈1.0)
is_stable: boolean         (server TimeSync::isSyncStable())
```
> There is **no** `client_time` field on this frame (the `client_time` name
> belongs to `time_ping`/`time_pong` only). On `:8804` the hub has no producer
> and refuses inbound use (see §8.4).

### 4.6 Informational

`syncplay_error` (server → client)
```
error_code?: string        (Messages::error uses error_code)
code?: string              (SyncPlayManager::sendError uses code)
message: string
details?: object
```
> Clients MUST read `error_code` first, then fall back to `code`: the server
> splits its error emitters across the two fields (`Messages::error` sets
> `error_code`, `SyncPlayManager::sendError` sets `code`), so a consumer that
> consults only one silently drops every frame from the other.
>
> **Code vocabulary — registry SSOT, two families on the wire.** The dotted
> codes (`syncplay.*`, `hub.*`) are registry members: their values have exactly
> one source of truth, the `@phlix/contracts` error-codes registry — no repo
> mints a dotted code locally; additions cascade through contracts. On `:8097`
> the join/create/leave/queue refusals already ride their registry twins —
> `syncplay.invalid_password`, `syncplay.group_full`,
> `syncplay.group_limit_reached`, `syncplay.group_not_found`,
> `syncplay.create_failed`, `syncplay.join_failed`, `syncplay.leave_failed`,
> `syncplay.queue_limit_exceeded` (`SyncPlayManager.php` R17-04/W2 twin-flip
> path, which retired the legacy SCREAMING join aliases, @ `6437e318`). The
> SCREAMING_SNAKE values still sent on that WS (`NOT_HOST`, `NOT_IN_GROUP`,
> `NOT_AUTHENTICATED`, `UNKNOWN_MESSAGE`) are the per-handler codes that
> predate the registry. Consumers that localize error UI MUST localize BY
> CODE, never by the English `message` string — §8.3's display-string law
> covers `message` verbatim. **Known gap (documented, not mints):** the REST
> carriers answer join/create refusals with a bare `{error: string}` — no code
> at all — so a REST-side refusal has no machine-readable key today. This note
> documents the two-family shape; it mints no values.

`syncplay_info` (server → client)
```
message: string
member_id?: string         (present when this INFO announces a member JOIN)
member_name?: string
data?: object
```

---

## 5. NTP time synchronization (mirrors `TimeSync.php`)

Constants:

| Constant                | Value  |
|-------------------------|--------|
| `PROTOCOL_VERSION`      | `1`    |
| `OFFSET_SAMPLE_COUNT`   | `5`    |
| `MAX_ACCEPTABLE_RTT`    | `1000` ms |
| stability variance      | `< 50` ms² |
| drift smoothing factor  | `0.1`  |

Per ping/pong round, with:

```
t1 = client send time   (client_time in the ping)
t2 = server receive time (server_time in the pong)
t3 = server response time (== t2; no separate field on the wire)
t4 = client receive time
```

compute:

```
rtt    = t4 - t1 - (t3 - t2)
oneWay = rtt / 2
offset = t2 - t1 + oneWay        // add offset to local time → server time
```

**Clock contract.** The injected `now()` MUST return **epoch milliseconds**
(same scale as `Date.now()`). All quad timestamps (`t1`..`t4`), positions,
durations, `offset`, and `latency` are in milliseconds. The one seconds-scaled
value is each sample's stored `timestamp`, computed as `now() / 1000` solely so
the drift `timeDelta` matches the server's per-second `microtime(true)` scale.
That `/ 1000` is the units bridge and is correct only because `now()` is ms —
do not inject a seconds clock.

- Reject the sample if `rtt < 0` or `rtt > MAX_ACCEPTABLE_RTT`. The `rtt < 0`
  arm is client-side hardening that the server's own rejection in
  `TimeSync.php` omits (it bounds `rtt` above only): a negative round trip
  arises solely from a corrupt or forged echo, or a rewound local clock —
  never from an honest measurement — and a local estimator's law is to drop
  impossible samples, not average them in.
- Keep a rolling buffer of up to `2 * OFFSET_SAMPLE_COUNT` samples.
- **Offset** = weighted mean over the last `OFFSET_SAMPLE_COUNT` samples,
  weight `= 1 / max(1, rtt)` (favours low-RTT samples), i.e. exactly
  `sum(weight * offset) / sum(weight)` — the divisor is the REAL weight sum.
  Clamping that divisor to `≥ 1` (the server's legacy
  `max(1, $weightSum)` in `TimeSync.php::getTimeOffset()`) returns the raw
  weighted sum at realistic RTTs and crushes offsets toward zero — ruled a
  defect by the estate and cured here and in the mobile copy; the server's
  local estimator awaits its lockstep fix, which is safe because this
  aggregation never crosses the wire. Result rounded to whole ms.
- **Latency** = mean of `rtt / 2` over recent samples.
- **Stable** when `samples ≥ OFFSET_SAMPLE_COUNT` AND the **population**
  variance of the recent offsets (integer-ms samples; `sum((o - mean)²) / n`)
  is `< 50` — the threshold's unit is **ms²** (variance of ms), mirroring the
  server's unit-less `50`. The server docblock's "50ms" (`TimeSync.php:39`
  @ `bc3b9b33`) labels the root's unit onto the variance — a mislabel owed
  to the server vein, not a different threshold.
- **Drift** (EMA): over the recent window,
  `driftRate = 1.0 + 0.1 * (offsetDelta / timeDelta) / 1000`, where `timeDelta`
  is in seconds (see the clock contract above). `1.0` = no drift. (Windows +
  Mobile omitted drift; it is restored here.) The result is then **clamped into
  `[0.99, 1.01]`** (`DRIFT_RATE_MIN` / `DRIFT_RATE_MAX`) so a noisy or forged
  offset sequence cannot drive the rate out of range — a rate `< 1.0` would let
  the adjusted position run backwards for a forward-elapsed interval. The clamp
  is client-side hardening and changes nothing on the wire.
- **Adjusted position**:
  `position + (synchronizedNow - serverTime) * driftRate`.
- **Freshness and degradation (client observability).** The window above has
  no expiry: after a sleep or a frozen timer tab the aggregates serve a hours-
  old window with full confidence. The library therefore exposes the inputs
  to that judgement without inventing a policy — `TimeSync.getSampleAgeMs()`
  (age of the newest sample against the injected clock; `null` when empty)
  and an `onSyncDegraded(consecutiveRejections)` event fired per REJECTED
  round that still matched its ping (a realistic outcome for high-RTT
  members against `MAX_ACCEPTABLE_RTT = 1000`), reset by any acceptance. The
  server's `TimeSync.php` has neither a freshness bound nor a reject
  counter, so this is client-side observability only — no wire meaning.

---

## 6. Member-event handling (what the server ACTUALLY does)

The server does **not** emit dedicated `member_joined` / `member_left` message
types. Instead:

- **Member JOIN** is announced via `syncplay_info` carrying `member_id` and
  `member_name` (SyncPlayManager::joinGroup → broadcastToGroup INFO). Clients
  detect a join by the presence of those fields on an INFO message.
- **Member LEAVE / host change**: when the host leaves, the server broadcasts
  `syncplay_host_elect` with the newly-elected `elected_id`. A plain leave by a
  non-host produces no dedicated event — and on the `:8097` carrier NO
  follow-up `syncplay_group_state` either: the server's WS `group_state`
  producers are the join/create acks (to the joiner) and the host-transfer
  path, so PEERS see a plain-leave roster change only when the next such frame
  happens to arrive. The hub relay `:8804` differs: membership churn
  rebroadcasts state on that carrier. The library diffs rosters between
  `group_state` frames to fire `onMemberLeft`/join detection, so on `:8097`
  that diff lags a plain leave. Whether `:8097` SHOULD broadcast a refreshed
  `group_state` on every leave is a server behavior decision (wire-visible;
  tracked for the cascade) — not ruled here.

Tizen's `syncplay_member_joined` / `syncplay_member_left` types are
**inventions** and are not part of the protocol.

---

## 7. Normalized client divergences

`@phlix/syncplay` exists to eliminate these:

- **Windows**: was missing 6 of 19 types (no `playback_queue`, `chat`,
  `typing`, `host_transfer`, `host_elect`, `time_sync`); had no drift; read
  `group_state` as **flat** fields (server nests under `group` + `your_id`);
  had a buggy RTT formula (`t4 - t1 - (t2 - t4)`); sent a non-protocol
  `syncplay_position_report`; used a fake non-SHA-256 `hashPassword`.
- **Tizen**: invented `syncplay_member_joined` / `syncplay_member_left`; wrapped
  all sends as `{ type, data, timestamp }` (server ignores `data`); used a fake
  password hash.
- **Roku** (BrightScript): used a `syncplay.` dot prefix and HTTP-POST instead
  of the underscore prefix over WebSocket.

The canonical decisions: underscore `syncplay_` prefix, flat RAW JSON framing,
`protocol_version = 1`, nested `group_state`, and member events via INFO /
HOST_ELECT (never dedicated member types).

> **Shorthand convention (declared once here, so §1 item 1 stays unbroken):**
> the divergence bullets above abbreviate names from the §3 catalog by
> dropping the `syncplay_` prefix (`chat` is `syncplay_chat`, `time_sync` is
> `syncplay_time_sync`, and likewise for every name in those lists). The
> abbreviations are prose shorthand only; the wire always carries the full
> underscore-prefixed names.

---

## 8. Security model

`@phlix/syncplay` is a **transport-agnostic protocol codec and client-state
orchestrator**. It performs **no authentication and no authorization** and
**MUST NOT be relied on for either**. The library never opens a socket, never sees
credentials, and cannot verify who is on the other end of the wire. Every
security guarantee in SyncPlay is a **server responsibility**. The points below
enumerate what the server MUST enforce; the client merely mirrors the wire
shapes.

### 8.1 Authenticate the connection BEFORE any `syncplay_*` frame

The server MUST authenticate the WebSocket connection **before** it accepts or
acts on any `syncplay_*` frame. A connection that has not completed
authentication MUST NOT be allowed to create/join a group, issue playback
commands, or receive group broadcasts. Do not treat the first `syncplay_*`
message as implicitly authenticated.

Recommended: a server **nonce-challenge handshake** — the server issues a
single-use nonce, the client returns a signature/token bound to that nonce over
the connection, and only then is the connection promoted to "authenticated" and
permitted to send protocol frames. The authenticated identity established here
is what the server uses for §9 identity derivation.

### 8.2 `password_hash` is a weak group gate, not identity

`password_hash` (sent on `syncplay_group_create` / `syncplay_group_join`; see
`src/client.ts` `createGroup` / `joinGroup`) is an **unsalted SHA-256 hex
string of the group password**. It is:

- **replayable** — anyone who observes one valid `password_hash` on the wire (or
  guesses it from an unsalted dictionary) can re-send it verbatim to enter the
  group;
- **not an identity** — it authenticates *knowledge of a group secret*, nothing
  about *who* the connection belongs to;
- therefore only a **weak gate on group membership**, never a substitute for the
  authenticated connection of §8.1.

The server MUST treat `password_hash` purely as an optional group-entry gate and
MUST derive member/host identity from the authenticated connection (§9), never
from possession of a `password_hash`.

Two provenance facts about the gate's other half. The group id itself is minted
by the live server as `sp_` plus a 64-bit CSPRNG hex (`SyncPlayManager.php:2067-
2070`, `generateGroupId()`, @ `6437e318`), so for a group created WITHOUT a
password the id — unguessable but trivially shareable — IS the only gate; join
attempts against password-protected groups are additionally guarded server-side
by the `JoinPasswordThrottle`. What entropy group ids MUST carry, and whether
id-gated groups require a password by law, are policy questions for the server
owners — noted here, not ruled.

### 8.3 Consumer-side display-string responsibility

(Cross-reference for the later XSS contract step.) Peer-influenceable display
strings — `group_name`, `member_name`, chat/info `message` — pass through this
library untouched. Consumers MUST escape/sanitize them before rendering in any
UI; this DOM-free library deliberately does not mutate display strings.

> **`member_name` is claimed display data, not identity.** §4.1 takes the
> value from the joining client and the live server stores the claim verbatim
> in the roster — including on the re-home branch, where an already-member
> socket that re-sends `syncplay_group_join` overwrites its roster `name` with
> the new claim, un-gated by password or capacity and with NO rename event on
> the wire (`SyncPlayManager.php` `joinGroup()` re-home branch, which updates
> `name`/`is_active`/`connection_id` only, @ `6437e318`). A server MAY derive
> the display name from the authenticated user record instead of trusting the
> claim. Consumers' security-relevant UX — host-transfer confirmation,
> "who paused this", any moderation context — MUST key on `member_id` (§9),
> never on `member_name`, which any member may rewrite between frames.

### 8.4 WebSocket credential carrier (server `:8097` vs hub relay `:8804`)

The pre-authentication bearer token travels **in the WebSocket handshake**,
and the accepted carrier differs per endpoint. Both endpoints reject the
handshake **before the 101 upgrade** when the credential is missing or
invalid — no frame is ever read on an unauthenticated connection (§8.1).

**Dial paths (normative here; the README mirrors them for quick reference).**
Direct server surface: `wss://<host>:8097/api/v1/syncplay/ws`. Hub relay
surface: `wss://<hub>:8804/syncplay/{server_id}`. Both take the bearer
subprotocol form shown in §8.1. The two paths differ in load-bearingness:
the `:8097` listener gates on the handshake credential and does NOT route on
the path — `/api/v1/syncplay/ws` is the estate convention every current dialer
uses, and new clients SHOULD send it, but nothing on that port dispatches by
it; the hub `:8804` path IS routing — `{server_id}` selects the shadow scope,
and a path without the segment never reaches auth: `parseServerId()` fails and
the socket is answered a real close frame, code 1011 do-not-retry, before any
frame is read (`phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php`
`onWebSocketConnect()` @ `20d0e785`, method names durable per §1 item 6).

**Credential hygiene on the transitional `?token=` lane.** Operators MUST scrub
or redact `?token=` from access logs, proxy configurations, and any error page
that echoes the request URI. Clients MUST NOT log a dial URL that carries a
credential — log the endpoint without its query.

| Endpoint | CURRENT law | Notes |
|----------|-------------|-------|
| Server direct WS `:8097` | **SHIPPED transitional dual carrier** (phlix-server `424c14d0`): the `Sec-WebSocket-Protocol: bearer, <jwt>` **two-entry subprotocol is PREFERRED** (priority 1, the estate TARGET); the legacy `?token=<jwt>` query is still accepted only while older client builds upgrade (priority 2, **RETIRED on fleet-update timing — an owner call, never assume a removal date**). Law SSOT `SyncPlayAuthMiddleware::resolveHandshakeToken()` — `phlix-server/src/Server/WebSocket/SyncPlayAuthMiddleware.php:471-489`; handshake gate `phlix-server/src/Server/WebSocket/WebSocketServer.php:522-526`. Full law doc: phlix-server `docs/dev/WEBSOCKET_AUTH_CARRIERS.md` @ `424c14d0`. | Missing/invalid/expired credential still rejects **pre-101** (§8.1). Both carriers present with **different** credentials also rejects pre-101 (pool removal + close, `WebSocketServer.php:528-543`) — a half-migrated client fails loudly instead of authenticating on a credential other than the one it presents. A client that **offered** `bearer` and passed is answered `Sec-WebSocket-Protocol: bearer` on the 101 — marker only, never the token, and gated on the offer (`WebSocketServer.php:554`, `:575-582`; echo const `SyncPlayAuthMiddleware.php:87`). New clients MUST dial the bearer form; `?token=` is legacy-only. |
| Hub SyncPlay relay `:8804` | `Sec-WebSocket-Protocol: bearer, <token>` **two-entry subprotocol** (or `Authorization: Bearer` header) **only** — a `?token=` query is refused (S237). `phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php:52-55`, `:443-446`; JS clients: `new WebSocket(url, ['bearer', token])`. | The 101 echo answers with the `bearer` marker only — never the token (`:527-560`). |

**Room-vocabulary dialect on `:8804` (owner decision #14, phlix-hub
`cc1e128`).** The relay's room lane now serves this canonical §3 catalog. A
connection latches its dialect on the first `syncplay_*` frame it sends and
every subsequent reply arrives in the same dialect; `syncplay_`-prefixed
names outside the 19 are refused loudly (`syncplay_error`
`UNKNOWN_MESSAGE` — the canonical floor is CLOSED, mirroring `:8097`), while
the legacy unnamed bare room vocabulary keeps its open verbatim-relay floor.
The legacy bare room vocabulary (`group_join`/`room_state`/`client_joined`/
`client_left`/`time_sync`) stays handled for compatibility but has **zero**
live consumers in the estate. `pending_command` (the push/Alexa lane) is an
orthogonal frame family delivered to every authenticated socket of the target
user regardless of dialect — a client may run two `:8804` sockets per
(server, owner), one command lane and one room lane (the hub's
`deliverToUser` fans out to all matching connections).

The hub is a relay without the server's group store, so its canonical replies
carry documented deviations from the full `:8097` laws: identity is a
hub-issued per-socket client id surfaced as `your_id`/`member_id`; rooms are
shadow-scoped per (server_id, owner user_id), which makes cross-user parties
over the relay impossible by construction; the first member is host and a
host departure elects the longest-present member (broadcast `syncplay_info`
per §6 on join/leave, `syncplay_host_elect` followed by the refreshed
`syncplay_group_state` on election); `syncplay_playback_sync`'s `server_time`
is **milliseconds** here — the hub arm of the §4 unit law's named exception
(§4 is the single authority; the `:8097` server-stamped arms are the seconds
side and `SyncPlayClient.serverTimeToMs` normalizes them at parse, so
consumers receive ms on both carriers); server-initiated
`syncplay_time_sync` has no hub producer and its inbound use is refused
(`hub.protocol_unsupported`) because the hub holds no clock authority beyond
`syncplay_time_ping`/`_pong`; `password_hash` is accepted and ignored (the
token's own (server, owner) scope is the gate); and the S446 out-of-sync
nudge (`syncplay_playback_sync`'s additive `nudge` object — a producer that
exists only in the `:8097` server, `SyncPlayManager.php:1569-1585`
@84e55800; the hub lane runs no out-of-sync policy and its
`handleCanonicalPlaybackSync()` reply, `SyncPlayRelayWorker.php:1673-1680`
@f85f48ec, never stamps the key) is not relayed — on that carrier the
`onPlaybackSync` nudge argument is always `undefined`.

That silence has a stated consequence: a hub-lane party has no server-side
out-of-sync policy, so drift blindness there is **permanent unless the
consumer self-monitors**. Hub-lane consumers MUST compute drift themselves
from the echoed playhead-bearing frames — §5's adjusted-position machinery,
which the reference library runs on every `onPlaybackSync` ingest whichever
carrier fed it — and own any correction UX locally; nothing on `:8804` will
ever tell them they are behind.

The first consumer of the relay's canonical lane is phlix-mobile-client
`13715d0`, whose interim `RELAY_NOT_SUPPORTED` refusal was lifted in the same
owner decision; it dials `['bearer', <relay token>]` and speaks this catalog
unchanged — the §4–§6 frame shapes the hub replies with are parsed by the
same code as the server's.

Fleet status (re-verified 2026-09-30 against each repo's `origin/master` tip;
an earlier pass of this table was tip-stale at authoring): the bearer flip has
landed in phlix-ui `324b4122` (`src/api/syncplay.ts` flipped at `be9a5fc5` /
`c0b6af04`; this tip commit regenerates `dist/` and the re-tag that publishes
it is still pending, owner-gated), phlix-tizen-client `348c6e7` (flip +
empty-token subprotocol bail at `6707ed3` in
`src/stores/useSyncPlayStore.ts`; this tip commit only refreshes the committed
`package/` build output), phlix-mobile-client `bdbe1e1`
(`src/syncplay/wsEndpoint.ts`), phlix-roku-client `07eef68`
(`source/lib/SyncPlayProtocol.brs`) and phlix-console-client `2f0ecf5` (native
`websocketClientProtocol` seam in `src/Api/SyncPlay/SyncPlayService.php` since
`04a1590`; this tip commit adds the `WebSocketDialer` `wss://` TLS-dial fix).
This fleet paragraph is era-pinned, and the era moved: at the
`@phlix/ui#v0.99.7` pins the LAST estate `?token=` producers were the vendored
ui bundle chunks booted by phlix-windows-client and phlix-tizen-client (the tag
predated both flip commits). Both clients have since re-pinned through the
`v0.99.13` cascade (disk-verified 2026-11-03), so current estate dials ride the
bearer subprotocol. `?token=` stays accepted on `:8097` for third-party and
pre-cascade builds; its retirement remains the owner fleet-update call named in
the table above — never an assumed date.

`@phlix/syncplay` itself opens no socket, so both carriers are consumer
transport concerns. The two-entry bearer subprotocol is now the universal
estate carrier — it is accepted on **both** surfaces above; the `?token=`
lane exists only on `:8097` for legacy builds and MUST NOT be added to new
code paths (the hub refuses it).

---

## 9. Server-derived identity contract (`member_id` / `host_id`)

`member_id` and the various host ids (`current_host_id` / `new_host_id` in
`syncplay_host_transfer`, and the `member_id` carried on every playback command)
are **self-asserted by the client on the wire**. In `@phlix/syncplay` they are
populated from the constructor `memberId` option (see `createGroup`,
`joinGroup`, and the playback senders in `src/client.ts`). **A client-supplied
id is a convenience/echo value only and MUST NOT be trusted for authorization.**

A correct server MUST:

1. **Derive the effective `member_id` from the authenticated connection** (§8.1)
   and use that derived id for all authorization decisions. It MUST IGNORE the
   client-supplied `member_id` for any access-control purpose; the client-supplied
   value MAY be used only for obvious self-reference detection and for logging,
   never for anything else.

2. **Authorize host-only actions by connection identity, not by claimed id.**
   The host-only COMMANDS are `syncplay_playback_play` / `_pause` / `_seek` /
   `_queue` and `syncplay_host_transfer`: each MUST be authorized by checking
   that the *authenticated connection* is the current host — never by trusting
   the `member_id` / `current_host_id` fields the client placed in the frame.
   (M-SYNCPLAY-17 correction, aligned to both live producers: the server's
   `NOT_HOST` gates sit on play / pause / seek / queue / transfer —
   phlix-server `SyncPlayManager.php:1071, :1123, :1169, :1219, :1413` @
   3cfd26c2 — and the hub relay mirrors that set — phlix-hub
   `SyncPlayRelayWorker.php:1605, :1707, :1873` @ 34ae8e3e. The old list
   gated `_sync` and omitted `_queue`: both wrong.) For host transfer, the
   server authorizes the transfer by the connection's authenticated identity
   and sets the resulting host id authoritatively.
   `syncplay_playback_sync` is **not** in that set: it is a member-permitted
   STATE REPORT (see §9.1). Both producers guard it only for authentication
   and membership — server `handlePlaybackSync()` :1483 (`NOT_AUTHENTICATED`
   :1490, `NOT_IN_GROUP` :1498, no `NOT_HOST` arm anywhere in the body; its
   own docblock, :1452: "Any member can request a playback sync"), hub
   `handleCanonicalPlaybackSync()` :1661 (docblock :1650: "state report,
   anyone may send"; sole guard `NOT_IN_GROUP` :1665). The ungated arm is
   intentional law, not a server gap: the whole S446 per-member drift policy
   (the server ingests every reporter's position at :1513 and aims a nudge at
   the drifting member — :1530, :1562) exists only because non-hosts report,
   and §9.1's S294 re-anchor design starves without them.

3. **Set the true sender id on rebroadcast.** When the server rebroadcasts a
   command to the group, it MUST stamp the authoritative sender `member_id`
   (derived from the sender's authenticated connection), overwriting whatever the
   sender claimed.

### 9.1 Echo-suppression depends on the server-set sender id

`@phlix/syncplay` suppresses its *own* echoed playback/seek commands by
comparing the inbound frame's `member_id` against this client's `memberId` (see
the echo-suppression checks in `handlePlayback` and `handleSeek` in
`src/client.ts`). This is **safe only because the server is expected to set the
true sender id on rebroadcast (§9 item 3)**.

**Per-frame-type exception (S294):** `syncplay_playback_sync` is a STATE REPORT,
not a command — the server broadcasts it to EVERY member including the sender,
stamped with the HOST id (it excludes nobody for this type, unlike play/pause/
seek). The host MUST therefore consume its own echoed `playback_sync`: in a
one-member group that frame is the only re-anchor source. Self-echo suppression
applies to COMMAND frames only (`syncplay_playback_play` / `_pause` / `_seek`).

If the server failed to overwrite the sender id, a malicious peer could spoof
*your* `member_id` on a legitimate command and cause your client to silently
drop it (a denial-of-action). The client cannot defend against this on its own —
it is acceptable **only** under the §9 contract that the server replaces the
sender id with the authenticated one before rebroadcast. This caveat is the
reason the suppression key is `member_id`; see also the host-recompute flow,
which trusts the same server-set ids (§9 item 3).

Send **pacing** is likewise client behavior, not wire shape:
`@phlix/syncplay` coalesces key-repeat seek bursts into at most one
`syncplay_playback_seek` frame per throttle window before the frame reaches the
wire (README "Command repeat policy"; `seekThrottleMs`). Nothing in this
section changes for the frames that do arrive — the server authorizes and
re-stamps each one exactly as above.

### 9.2 Client-side coupling: ctor `memberId` MUST equal the stamped identity

This section's server law has a mirror obligation for consumers of
`@phlix/syncplay`. The library's local identity decisions — `isHost()`
(`group.host_id === memberId`) and the §9.1 echo suppressions
(`msg.member_id === memberId`) — compare the **constructor** `memberId`
against ids the server derived from the *sender's* authenticated connection.
For those comparisons to mean anything, the ctor value MUST equal the identity
the server will stamp for **this** connection — the `your_id` the join/create
ack carries:

- Direct `:8097`: the authenticated **user id** (JWT subject). Producer bytes:
  phlix-server `SyncPlayManager.php:1799` and `:1855`
  (`'your_id' => $connection->getUserId()`), REST
  `SyncPlayController.php:173`/`:267`/`:305` (`$memberId = $request->userId`,
  S289). Knowable before dialing (the auth layer holds it).
- Hub relay `:8804`: a hub-generated **per-connection uuid**
  (phlix-hub `SyncPlayRelayWorker.php:423`, `generateClientId()` `:2107-2120`),
  echoed as `your_id` at `:1486-1491`. NOT knowable before the first
  `group_state`; the client surfaces `your_id` through `onState` and
  reconciles nothing (ctor id immutable by design) — the consumer adopts it.

A fabricated/mismatched ctor id yields exactly two observable defects:
`isHost()` permanently false for a true host (mobile's dead-host bug class —
UI controls inert even though §9 item 2 authorization would accept the
commands), and self-echo suppression dead — the member's own re-stamped
commands pass the `=== memberId` test as foreign and double-apply. The full
law and both carriers' coordinates are documented on
`SyncPlayClientOptions.memberId` (`src/client.ts`).

---

## 10. Reconnect & resume recovery

`@phlix/syncplay` owns **no socket and no periodic timers** — the consumer's
transport opens, closes, and reconnects the WebSocket; the library's only
timer at all is the one-shot seek-coalescing flush, disarmed by every reset
path (`onDisconnect()`, `destroy()`). The library only models the
SyncPlay *state* that depends on a live connection, and exposes one method to
reset it.

### 10.1 The transient state a disconnect invalidates

When the underlying WebSocket closes or errors, three pieces of client state
become stale and MUST be discarded before reconnecting:

1. **Time-sync samples + drift** — a reconnect may take a new network path, so
   offsets/drift measured on the dead connection would corrupt the first
   post-reconnect sync. `TimeSync.reset()` clears samples and restores
   `driftRate = 1.0`.
2. **Group membership** — the server-side membership is gone once the socket
   drops; the client's `group` MUST become `null` until a fresh
   `syncplay_group_state` arrives.
3. **The outstanding ping** — a late `time_pong` from the dead connection MUST
   NOT seed a sample, so the recorded send time (`lastPingSendTime`) is dropped.

Pacing while connected is likewise client law, not wire shape: `pingTime()`
with a ping outstanding MUST be ignored — a pong can only be attributed to the
one recorded send time, so stacked pings would return as mismatched echoes the
estimator refuses. An unanswered ping older than `MAX_ACCEPTABLE_RTT` can never
seed a sample (any such sample would itself be rejected on `rtt`), so it is
treated as lost and the next call may re-ping; a matched pong frees the slot
even when it omits `server_time`.

### 10.2 Required recovery sequence

```
socket close / error
        │
        ▼
client.onDisconnect()          // reset TimeSync, group = null, drop ping
        │
        ▼
(consumer) reconnect WebSocket // with backoff — see README
        │
        ▼
client.joinGroup(groupId, …)   // re-establish membership; awaits group_state
        │
        ▼
resume periodic client.pingTime()   // rebuild the time-sync window
```

`SyncPlayClient.onDisconnect()` performs steps 1–3 of §10.1 and then invokes the
optional `onDisconnect` consumer callback (a UI hook, e.g. a "reconnecting…"
banner). It does **not** reconnect, re-join, or schedule any timer.

**Returning host & rejoin credentials — observed facts, not new law.**
Re-election is oldest-member-first on both carriers (§4.4's election path,
§8.4's hub rule), so a host whose connection blips — close vacates the seat,
and the rejoin lands as a NEW member record with a fresh `joined_at`
(`GroupState::addMember()` @ `6437e318`) — sits behind every remaining member
and regains the host seat only if all earlier joiners leave first. There is
no protocol notion of a "previous host" to restore: ordinary-member-forever
is the designed social outcome, not a defect to chase. Credential custody is
the consumer's mirror problem: `@phlix/syncplay` NEVER stores a
`password_hash` — `createGroup`/`joinGroup` stamp it onto the frame and
forget it (no field retains it), and `onDisconnect()` clears the cached group
— so a reconnect path MUST re-supply the hash it obtained at join time
(session-scoped custody is the consumer's to design). Server-side, the
group's gate hash lives exactly as long as the group does: membership churn
never rotates or clears it (§8.2).

**Joiner position catch-up — observed law, OPEN decision.** When a (re)joiner
receives its first `syncplay_group_state`, the position law in effect today is
ADOPTION: playback starts at `group.playback_position` verbatim. That field
carries no as-of `server_time` stamp on either carrier, so no wire-delay
compensation exists to read, and neither this spec nor the library mandates a
seek-to-adjusted-now on join. Convergence after adoption runs through the
machinery already on the wire: later playhead-bearing frames are interpreted
via §5's adjusted-position law, and out-of-tolerance members are trimmed by the
§4.2 rate-limited nudge ("a rate-limited NUDGE — never a seek"). A joiner that
adopts 30 s behind therefore sits ~30 s off for minutes while fully
conformant. Whether the contract should instead REQUIRE a join-time seek to a
§5-adjusted position — and/or stamp `group_state` with an as-of reference and
define a "synced" moment — is an OPEN decision: both halves change wire
meaning and need the server + hub + client cascade plus an owner ruling. Until
that lands, a consumer MAY seek once to its §5-adjusted position after the
first `group_state` and before revealing the player; the current wire permits
that choice and this spec neither requires nor forbids it.

### 10.3 Backoff is a transport (consumer) concern

The reconnect **retry/backoff timer** is owned by the consumer's transport layer,
not by this library (it has no socket and schedules no periodic timers — §10
lead-in). The recommended
exponential-backoff recipe lives in the README ("Reconnect recovery"); this spec
only mandates the ordering in §10.2.
