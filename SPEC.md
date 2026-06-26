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
group: {
  id: string
  name: string
  host_id: string | null
  current_media_id: string | null
  playback_position: number
  playback_state: "playing" | "paused" | "stopped"
  members: [ { id, name, is_host, joined_at }, ... ]
  has_password?: boolean
}
your_id?: string           (the recipient's own member id)
```
> The server emits the full group under `group` and the recipient id under
> `your_id`. It does NOT flatten group fields onto the envelope.

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

- Reject the sample if `rtt > MAX_ACCEPTABLE_RTT`.
- Keep a rolling buffer of up to `2 * OFFSET_SAMPLE_COUNT` samples.
- **Offset** = weighted mean over the last `OFFSET_SAMPLE_COUNT` samples,
  weight `= 1 / max(1, rtt)` (favours low-RTT samples).
- **Latency** = mean of `rtt / 2` over recent samples.
- **Stable** when `samples ≥ OFFSET_SAMPLE_COUNT` AND variance of recent
  offsets `< 50`.
- **Drift** (EMA): over the recent window,
  `driftRate = 1.0 + 0.1 * (offsetDelta / timeDelta) / 1000`, where `timeDelta`
  is in seconds. `1.0` = no drift. (Windows + Mobile omitted drift; it is
  restored here.)
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
