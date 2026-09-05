---
description: Adding or changing a SyncPlay message type requires updating every mirror of the type list
globs: ["src/messages.ts", "src/client.ts", "test/messages.test.ts"]
---

# SyncPlay message types

`src/messages.ts` mirrors the PHP server's `Phlix\Session\SyncPlay\Messages`
exactly — the server is the source of truth. There are currently **19** types.

Adding one type means touching all of these in the same change:

1. `SYNCPLAY_MESSAGE_TYPES` in `src/messages.ts`, inside its category block.
2. `ALL_MESSAGE_TYPES` (mirrors `Messages::VALID_TYPES`, same order).
3. The exported payload type for that message in `src/messages.ts`.
4. A `private handleX(msg: RawMessage)` in `src/client.ts`, its `dispatch()`
   case, and the matching optional `onX` callback on `SyncPlayClientOptions`.
5. The count assertions in `test/messages.test.ts`
   (`expect(ALL_MESSAGE_TYPES).toHaveLength(19)`).
6. `SPEC.md` §3 (`## 3. Message types (all 19)`) and its §4 payload section.
7. The `SYNCPLAY_MESSAGE_TYPES` comment in `README.md` ("the 19 canonical
   type strings").

Never invent a type the server does not send — client-side inventions
(`member_joined`, a `syncplay.` dot prefix) are the drift this package exists
to remove. Frames whose `type` is outside the 19 are NOT given a handler —
they reach the consumer through `SyncPlayClientOptions.onUnknownFrame`
(`UnknownFrame`), untouched.

Wire shape vs. model shape: `group.members` arrives as a DICT keyed by member
id (`SyncPlayMembersWire` / `SyncPlayGroupWire`, the input-side type of
`GroupStatePayload.group`). `handleGroupState` in `src/client.ts` folds it into
the array model `SyncPlayGroup.members` (the array spelling stays tolerated).
Type the wire and the model separately — never widen the model to the wire.
