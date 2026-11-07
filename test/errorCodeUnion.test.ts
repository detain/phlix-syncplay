/**
 * errorCodeUnion.
 *
 * LW-081 (review `syncplay__crossfe` finding 12): `error_code` travels as a
 * free string through `ErrorPayload`/`onError` (parse-don't-validate on an
 * external wire), while the TYPED union of the wire's error names lives in
 * `@phlix/contracts` as `SyncPlayErrorCode`. This package re-exports that
 * union from `src/messages.ts` so consumers can type-switch on it while
 * importing only THIS package. Three legs pin the seam:
 *
 *  - L1 (compile-time, enforced by `npm run typecheck` — vitest's esbuild
 *    strips annotations, so these assertions red the typecheck/build gate,
 *    never a passing-but-vacuous test run): the union reached via the
 *    PACKAGE NAME (`@phlix/syncplay`) equals the one reached DIRECT from
 *    contracts, both directions; and the era pin list type-checks against
 *    the packaged surface (`satisfies readonly Packaged[]` — a removed or
 *    rewired re-export is a typecheck error, a shrunken union reddens the
 *    pin's literals).
 *  - L2 (runtime): the contracts catalogue `SYNCPLAY_ERROR_CODES` equals the
 *    era pin — the 20 names measured at contracts `#v0.5.7` (SCREAMING
 *    legacy 12 ∪ dotted twins 8). An addition or deletion in the wire
 *    catalogue reddens here in both directions.
 *  - L3 (text): the COMMITTED `dist/messages.d.ts` ships the re-export and
 *    `dist/index.d.ts` still star-exports `./messages` — a src change that
 *    never reached the built surface (or a dropped carrier line) is red.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SYNCPLAY_ERROR_CODES,
  type SyncPlayErrorCode as Direct,
} from '@phlix/contracts';
import type { SyncPlayErrorCode as Packaged } from '@phlix/syncplay';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** L1: both directions must resolve to `true` or this line does not compile. */
const ROUND_TRIP: Equals<Direct, Packaged> = true;

/**
 * The era pin, typed against the PACKAGED surface (not the direct import —
 * that asymmetry is the point: if the re-export breaks, these 20 literals
 * have no type to satisfy and typecheck reddens). Measured at contracts
 * `#v0.5.7` (`bedfe69b`): legacy 12 in `Messages::error` order, then the
 * dotted twins 8.
 */
const WIRE_PINNED = [
  'UNKNOWN_MESSAGE',
  'HANDLER_ERROR',
  'NOT_AUTHENTICATED',
  'NOT_IN_GROUP',
  'NOT_HOST',
  'INVALID_NEW_HOST',
  'MEMBER_NOT_FOUND',
  'SAME_HOST',
  'CREATE_FAILED',
  'JOIN_FAILED',
  'LEAVE_FAILED',
  'PROTOCOL_VERSION_MISMATCH',
  'syncplay.create_failed',
  'syncplay.join_failed',
  'syncplay.leave_failed',
  'syncplay.group_limit_reached',
  'syncplay.group_not_found',
  'syncplay.invalid_password',
  'syncplay.group_full',
  'syncplay.queue_limit_exceeded',
] as const satisfies readonly Packaged[];

describe('LW-081 — SyncPlayErrorCode re-export seam', () => {
  it('L1: the package-name surface is the contracts union itself', () => {
    // The compile-time equality is the assertion; this expect only makes
    // the binding used (noUnusedLocals) so the leg cannot be silently
    // pruned. A removal/rewire of the re-export fails BEFORE this line
    // ever runs, at `npm run typecheck`.
    expect(ROUND_TRIP).toBe(true);
    expect(WIRE_PINNED.length).toBe(20);
  });

  it('L2: the contracts runtime catalogue equals the 20-name era pin', () => {
    expect([...SYNCPLAY_ERROR_CODES].sort()).toEqual([...WIRE_PINNED].sort());
    expect(SYNCPLAY_ERROR_CODES.length).toBe(20);
  });

  it('L3: the committed dist d.ts ships the re-export and its carrier', () => {
    const messages = readFileSync(join(REPO_ROOT, 'dist', 'messages.d.ts'), 'utf8');
    const index = readFileSync(join(REPO_ROOT, 'dist', 'index.d.ts'), 'utf8');
    expect(messages).toMatch(
      /export type \{ SyncPlayErrorCode \} from ["']@phlix\/contracts["'];/,
    );
    expect(index).toContain("export * from './messages';");
  });
});
