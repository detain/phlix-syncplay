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
 * `decodeMessage` tolerates and unwraps it for backward compatibility only.
 */

import {
  PROTOCOL_VERSION,
  type RawMessage,
  type SyncPlayMessageType,
} from './messages';

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
export function encodeMessage(
  type: SyncPlayMessageType,
  payload: Record<string, unknown>,
  now: NowFn,
): RawMessage {
  return {
    ...payload,
    type,
    protocol_version: PROTOCOL_VERSION,
    timestamp: now(),
  };
}

/**
 * Decode an inbound message into a flat RawMessage.
 *
 * Accepts either a JSON string or an already-parsed object. Tolerates (and
 * unwraps) the deprecated Tizen `{ type, data, timestamp }` envelope: if a
 * `data` object is present alongside `type`, its fields are hoisted to the top
 * level so downstream routing always sees a flat message.
 *
 * Returns `null` for anything that is not a JSON object carrying a string
 * `type`.
 */
export function decodeMessage(raw: unknown): RawMessage | null {
  let obj: unknown = raw;

  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return null;
  }

  const record = obj as Record<string, unknown>;

  if (typeof record.type !== 'string') {
    return null;
  }

  // Unwrap the deprecated Tizen { type, data, timestamp } envelope.
  const data = record.data;
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key !== 'data') {
        rest[key] = record[key];
      }
    }
    return { ...(data as Record<string, unknown>), ...rest } as RawMessage;
  }

  return record as RawMessage;
}

/** Serialize a raw message object to a JSON string for transmission. */
export function serializeMessage(message: RawMessage): string {
  return JSON.stringify(message);
}
