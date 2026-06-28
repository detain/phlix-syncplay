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

`@phlix/syncplay` `encodeMessage(type, payload, now)` produces this object;
`decodeMessage(raw)` parses it and, for backward compatibility only, unwraps the
deprecated `{ type, data, timestamp }` Tizen envelope into the flat form.

---

## 3. Message types (all 19)

Mirrors `Messages::TYPE_*` exactly.

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
```

`syncplay_group_join` (client → server)
```
group_id: string
member_id?: string
member_name?: string
password_hash?: string
```

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
  members: [ { id, name, is_host, joined_at }, ... ]
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
> identity uses `group_id` / `group_name`; only the **members** use `id` / `name`.
> `has_password` is NOT emitted here — it appears only in the `listGroups()`
> summary, never on a `group_state` message.

`syncplay_group_list` (client → server) — bare request, no fields.

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

If the server failed to overwrite the sender id, a malicious peer could spoof
*your* `member_id` on a legitimate command and cause your client to silently
drop it (a denial-of-action). The client cannot defend against this on its own —
it is acceptable **only** under the §9 contract that the server replaces the
sender id with the authenticated one before rebroadcast. This caveat is the
reason the suppression key is `member_id`; see also Step B6 (host recompute),
which trusts the same server-set ids.
