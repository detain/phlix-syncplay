# Phlix SyncPlay Wire Protocol — Canonical Specification

This document is the single source of truth for the Phlix SyncPlay protocol, so
that every client (mobile / windows / tizen JS, Roku/BrightScript) and the PHP
server can be checked against ONE spec.

The authoritative implementation is the PHP server:

- `phlix-server/src/Session/SyncPlay/Messages.php` — message types + payloads
- `phlix-server/src/Session/SyncPlay/TimeSync.php` — NTP time-sync math
- `phlix-server/src/Session/SyncPlay/SyncPlayManager.php` — dispatch + emitted shapes

`@phlix/syncplay` is the canonical JS port of that protocol.

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

5. **The server is the source of truth.** Clients must follow the shapes the
   server actually emits, not invent their own (see §6 divergences).

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

> **Units footnote — one hub-relay exception.** On the hub SyncPlay relay
> surface (`:8804`), every server stamp is in **milliseconds** *except*
> `pending_command` envelopes' `issued_at`, which is **UNIX SECONDS** —
> deliberately, matching the DB `TIMESTAMP` it mirrors (the hub's own unit
> note: `phlix-hub/src/SyncPlay/PendingCommandDispatcher.php:117-119`, value
> written at `:132` via `time()`). A client comparing `issued_at` against an
> `exp`, `server_time`, or frame `timestamp` (all ms) must multiply by 1000
> first; this exception is pinned so no consumer "fixes" it into drift.

`@phlix/syncplay` `encodeMessage(type, payload, now)` produces this object;
`decodeMessage(raw)` parses it and, for backward compatibility only, unwraps the
deprecated `{ type, data, timestamp }` Tizen envelope into the flat form.

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
| GROUP_LIST      | `syncplay_group_list`      | client → server  |
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
| TIME_SYNC       | `syncplay_time_sync`       | server → client  |
| ERROR           | `syncplay_error`           | server → client  |
| INFO            | `syncplay_info`            | server → client  |

---

## 4. Message payloads (exact wire fields)

All field names are **snake_case**. Positions/durations are **milliseconds**.

### Group management

`syncplay_group_create` (client → server)
```
group_name: string
member_id?: string         (defaults to the connection id server-side)
member_name?: string       (defaults to "Host")
password_hash?: string     (SHA-256 hex of the password)
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
> (`phlix-server/src/Session/SyncPlay/SyncPlayManager.php:2035-2071`,
> `groupPasswordGate()` — called for create at `:1695` and join at `:1748`).
> `password_hash` wins when both are present; a present-but-malformed
> `password_hash` is refused, never coerced. The plain-HTTP REST boundary
> (`SyncPlayController::createGroup` `:127`/`:133` and `joinGroup` `:204`/`:214`)
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
  created_at: number
  last_activity_at: number
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
> `has_password` is NOT emitted here — it appears only in the `listGroups()`
> summary, never on a `group_state` message.

`syncplay_group_list` (client → server) — bare request, no fields.
The server's `syncplay_group_list` reply is scoped per requester: rooms the
requester is a member of, plus every room when the requester is an active
admin (MED-2 owner ruling 2026-10-02 — visibility is members-or-admin; joining
by known id + password is unaffected, the reply shape is unchanged). The same
ruling gates the REST reads `GET /api/v1/syncplay/groups` and
`GET /api/v1/syncplay/groups/{id}` (a non-member's read of a foreign room is
an existence-agnostic 404).

### Playback control (host-only on the server; non-hosts get a `NOT_HOST` error)

`syncplay_playback_play` / `syncplay_playback_pause`
```
group_id: string
member_id: string
position: number
server_time: number        (synchronized timestamp, ms)
```

`syncplay_playback_seek`
```
group_id: string
member_id: string
from_position: number
to_position: number
server_time: number
```

`syncplay_playback_queue`
```
group_id: string
queue: [ { media_id: string, media_info?: object }, ... ]
member_id?: string
```

`syncplay_playback_sync` (periodic position broadcast)
```
group_id: string
member_id: string
position: number
is_playing: boolean
server_time: number
```
> Broadcast to every group member including the originator — the server does not
> exclude the sender for this type (unlike play/pause/seek) and stamps the frame
> with the HOST id; see §9.1.

### Chat

`syncplay_chat`
```
group_id: string
member_id: string
message: string
```

`syncplay_typing`
```
group_id: string
member_id: string
is_typing: boolean
```

### Host management

`syncplay_host_transfer` (client → server, voluntary)
```
group_id: string
current_host_id: string
new_host_id: string
```

`syncplay_host_elect` (server → client, automatic when host leaves)
```
group_id?: string
elected_id: string | null
elected_by: string
```

### Time sync (see §5)

`syncplay_time_ping` (client → server)
```
client_time: number        (t1: client send time, ms)
```

`syncplay_time_pong` (server → client)
```
client_time: number        (echoed t1)
server_time: number        (t2: server RECEIVE time, ms)
protocol_version: number
```
> There is **no** `server_receive_time` / t3 field. `server_time` IS the server
> receive time. The client must derive RTT from t1 and t4 only (it passes
> `t3 = t2` to the sample function).

`syncplay_time_sync` (server → client) — full sync-state broadcast (advisory).

### Informational

`syncplay_error` (server → client)
```
error_code?: string        (Messages::error uses error_code)
code?: string              (SyncPlayManager::sendError uses code)
message: string
details?: object
```
> Clients should read `error_code` first, then `code`.

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
| stability variance      | `< 50` |
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

- Reject the sample if `rtt < 0` or `rtt > MAX_ACCEPTABLE_RTT`.
- Keep a rolling buffer of up to `2 * OFFSET_SAMPLE_COUNT` samples.
- **Offset** = weighted mean over the last `OFFSET_SAMPLE_COUNT` samples,
  weight `= 1 / max(1, rtt)` (favours low-RTT samples).
- **Latency** = mean of `rtt / 2` over recent samples.
- **Stable** when `samples ≥ OFFSET_SAMPLE_COUNT` AND variance of recent
  offsets `< 50`.
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

---

## 6. Member-event handling (what the server ACTUALLY does)

The server does **not** emit dedicated `member_joined` / `member_left` message
types. Instead:

- **Member JOIN** is announced via `syncplay_info` carrying `member_id` and
  `member_name` (SyncPlayManager::joinGroup → broadcastToGroup INFO). Clients
  detect a join by the presence of those fields on an INFO message.
- **Member LEAVE / host change**: when the host leaves, the server broadcasts
  `syncplay_host_elect` with the newly-elected `elected_id`. A plain leave by a
  non-host produces no dedicated event; the next `syncplay_group_state` reflects
  the updated membership.

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

---

## 8. Security model

`@phlix/syncplay` is a **transport-agnostic protocol codec and client-state
orchestrator. It performs NO authentication and NO authorization, and MUST NOT
be relied on for either.** The library never opens a socket, never sees
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

### 8.3 Consumer-side display-string responsibility

(Cross-reference for the later XSS contract step.) Peer-influenceable display
strings — `group_name`, `member_name`, chat/info `message` — pass through this
library untouched. Consumers MUST escape/sanitize them before rendering in any
UI; this DOM-free library deliberately does not mutate display strings.

### 8.4 WebSocket credential carrier (server `:8097` vs hub relay `:8804`)

The pre-authentication bearer token travels **in the WebSocket handshake**,
and the accepted carrier differs per endpoint. Both endpoints reject the
handshake **before the 101 upgrade** when the credential is missing or
invalid — no frame is ever read on an unauthenticated connection (§8.1).

| Endpoint | CURRENT law | Notes |
|----------|-------------|-------|
| Server direct WS `:8097` | **SHIPPED transitional dual carrier** (phlix-server `424c14d0`): the `Sec-WebSocket-Protocol: bearer, <jwt>` **two-entry subprotocol is PREFERRED** (priority 1, the estate TARGET); the legacy `?token=<jwt>` query is still accepted only while older client builds upgrade (priority 2, **RETIRED on fleet-update timing — an owner call, never assume a removal date**). Law SSOT `SyncPlayAuthMiddleware::resolveHandshakeToken()` — `phlix-server/src/Server/WebSocket/SyncPlayAuthMiddleware.php:471-489`; handshake gate `phlix-server/src/Server/WebSocket/WebSocketServer.php:522-526`. Full law doc: phlix-server `docs/dev/WEBSOCKET_AUTH_CARRIERS.md` @ `424c14d0`. | Missing/invalid/expired credential still rejects **pre-101** (§8.1). Both carriers present with **different** credentials also rejects pre-101 (pool removal + close, `WebSocketServer.php:528-543`) — a half-migrated client fails loudly instead of authenticating on a credential other than the one it presents. A client that **offered** `bearer` and passed is answered `Sec-WebSocket-Protocol: bearer` on the 101 — marker only, never the token, and gated on the offer (`WebSocketServer.php:554`, `:575-582`; echo const `SyncPlayAuthMiddleware.php:87`). New clients MUST dial the bearer form; `?token=` is legacy-only. |
| Hub SyncPlay relay `:8804` | `Sec-WebSocket-Protocol: bearer, <token>` **two-entry subprotocol** (or `Authorization: Bearer` header) **only** — a `?token=` query is refused (S237). `phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php:47-49`, `:443-446`; JS clients: `new WebSocket(url, ['bearer', token])`. | The 101 echo answers with the `bearer` marker only — never the token (`:527-560`). |

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
is **milliseconds** here — per the §2 footnote's hub-wide ms law, whereas the
`:8097` producer keeps a legacy seconds quirk; server-initiated
`syncplay_time_sync` has no hub producer and its inbound use is refused
(`hub.protocol_unsupported`) because the hub holds no clock authority beyond
`syncplay_time_ping`/`_pong`; `password_hash` is accepted and ignored (the
token's own (server, owner) scope is the gate); and the S446 idle-host nudge
is not relayed.

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
The LAST estate `?token=` producers are the vendored ui bundle chunks:
phlix-windows-client `c75fdf0` and phlix-tizen-client both pin pre-flip
`@phlix/ui#v0.99.7` (the tag predates both flip commits), so the ui-sourced
SyncPlay widgets those apps boot still ride the query carrier — the concrete
reason `?token=` stays accepted on `:8097`. It closes when the ui re-tag +
consumer pin cascade lands (owner-gated).

`@phlix/syncplay` itself opens no socket, so both carriers are consumer
transport concerns. The two-entry bearer subprotocol is now the universal
estate carrier — it is accepted on **both** surfaces above; the `?token=`
lane exists only on `:8097` for legacy builds and must never be added to new
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
   client-supplied `member_id` for any access-control purpose (it may use it only
   to detect obvious self-references / for logging).

2. **Authorize host-only actions by connection identity, not by claimed id.**
   Host-only commands (`syncplay_playback_play` / `_pause` / `_seek` /
   `_sync` and `syncplay_host_transfer`) MUST be authorized by checking that the
   *authenticated connection* is the current host — never by trusting the
   `member_id` / `current_host_id` fields the client placed in the frame. For
   host transfer, the server authorizes the transfer by the connection's
   authenticated identity and sets the resulting host id authoritatively.

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
one-member room that frame is the only re-anchor source. Self-echo suppression
applies to COMMAND frames only (`syncplay_playback_play` / `_pause` / `_seek`).

If the server failed to overwrite the sender id, a malicious peer could spoof
*your* `member_id` on a legitimate command and cause your client to silently
drop it (a denial-of-action). The client cannot defend against this on its own —
it is acceptable **only** under the §9 contract that the server replaces the
sender id with the authenticated one before rebroadcast. This caveat is the
reason the suppression key is `member_id`; see also Step B6 (host recompute),
which trusts the same server-set ids.

---

## 10. Reconnect & resume recovery

`@phlix/syncplay` owns **no socket and no timers** — the consumer's transport
opens, closes, and reconnects the WebSocket. The library only models the
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
   drops; the client's `group` must become `null` until a fresh
   `syncplay_group_state` arrives.
3. **The outstanding ping** — a late `time_pong` from the dead connection must
   not seed a sample, so the recorded send time (`lastPingSendTime`) is dropped.

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

### 10.3 Backoff is a transport (consumer) concern

The reconnect **retry/backoff timer** is owned by the consumer's transport layer,
not by this library (it has no socket and schedules no timers). The recommended
exponential-backoff recipe lives in the README ("Reconnect recovery"); this spec
only mandates the ordering in §10.2.
