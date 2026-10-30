/**
 * framing.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
/**
 * Message framing — the CANONICAL on-the-wire envelope.
 *
 * A framed SyncPlay message is a flat JSON object:
 *
 *     { "type": "syncplay_...", "protocol_version": 1, "timestamp": 123, ...payload }
 *
 * The payload fields are spread at the TOP LEVEL of the object. This matches
 * what the PHP server reads (`$payload['member_id']`, `$payload['position']`,
 * ...) and what `Messages::*` factory methods produce.
 *
 * DEPRECATED: the Tizen client wraps sends as `{ type, data, timestamp }`,
 * nesting all fields under `data`. The server does NOT read `data`, so those
 * messages silently fail. That wrapper is deprecated and MUST NOT be used.
 * `decodeMessage` tolerates and unwraps it for backward compatibility ONLY
 * while the envelope lacks `protocol_version`: canonical frames always stamp
 * `protocol_version` (§1 item 4 of SPEC.md; the server's `Messages::frame`
 * stamps it literally), so for a frame carrying it, `data` is a legitimate
 * TOP-LEVEL payload field (e.g. `syncplay_info`, `Messages::info()`) and
 * survives decode UNTOUCHED (M-SYNCPLAY-02).
 */
import { type RawMessage, type SyncPlayMessageType } from './messages';
/**
 * A clock source, injected so the module stays pure and deterministic.
 *
 * CONTRACT: `now()` MUST return **epoch milliseconds** (the same scale as
 * `Date.now()`). The framing `timestamp` field is emitted in milliseconds and
 * `TimeSync`'s drift math presumes a ms clock (it converts via `now() / 1000`
 * to reach the server's per-second scale). Do NOT inject a seconds clock.
 */
export type NowFn = () => number;
/**
 * Encode a message into the canonical RAW JSON object.
 *
 * The result is a plain object (NOT a JSON string) so the transport layer can
 * serialize it however it likes. Payload fields are spread at the top level;
 * `type` and `protocol_version` are always set; `timestamp` is taken from the
 * injected clock.
 *
 * @param type    A valid SyncPlay message type.
 * @param payload The message body (top-level fields).
 * @param now     Clock source for the `timestamp` field.
 */
export declare function encodeMessage(type: SyncPlayMessageType, payload: Record<string, unknown>, now: NowFn): RawMessage;
/**
 * Decode an inbound message into a flat RawMessage.
 *
 * Accepts either a JSON string or an already-parsed object. Tolerates (and
 * unwraps) the deprecated Tizen `{ type, data, timestamp }` envelope ONLY when
 * the frame lacks a `protocol_version`: that wrapper never carries one, whereas
 * every canonical message does (§1 item 4), so a frame with `protocol_version`
 * is NOT the wrapper and its `data` — if present — is a legitimate top-level
 * payload field that must survive decode untouched. Pre-M-SYNCPLAY-02 the
 * heuristic keyed only on "an object `data` sits beside `type`", which
 * destructively hoisted-and-deleted `data` on canonical frames that legitimately
 * carry it (e.g. `syncplay_info`) and broke the "no mutation" promise that
 * `onUnknownFrame` makes to non-SyncPlay consumers.
 *
 * Returns `null` for anything that is not a JSON object carrying a string
 * `type`.
 */
export declare function decodeMessage(raw: unknown): RawMessage | null;
/** Serialize a raw message object to a JSON string for transmission. */
export declare function serializeMessage(message: RawMessage): string;
