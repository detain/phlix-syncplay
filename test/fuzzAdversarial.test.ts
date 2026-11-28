/**
 * S-syncplay-40 (finding phlix-syncplay-051, Low, FUZZ R-008/R-001) —
 * adversarial fuzz harness: frame-level + message-level fuzzing driven by a
 * seeded PRNG over the entire 19-type canonical vocabulary, asserting the
 * library's property invariants under hostile input:
 *
 *  P1 NO UNHANDLED THROW — `handleIncoming` never lets an exception escape
 *     for any generated input (the class-header THROW LAW constrains
 *     consumer callbacks; the library's own parse layer must stay total).
 *  P2 SINK MUTUAL EXCLUSION — one frame fires at most one refusal sink
 *     (`onFrameDropped` XOR `onUnknownFrame` XOR content hooks); silence is
 *     legal (echo suppression, unmatched pongs, c41 replays), mixing is not.
 *  P3 REFUSAL PURITY — a frame that did not fire one of the store-folding
 *     hooks (`onState`, `onQueueChanged`, `onHostChanged`, `onHostTransfer`)
 *     never moved the `getGroup()` reference and never moved the identity.
 *  P4 ADOPTED-PAYLOAD CONTRACTS — every delivered payload satisfies the
 *     ratified normalisation laws (store invariants, chat/stamp windows,
 *     nudge domains, clamped positions, string-keyed group_list rows...).
 *  P5 INVALID FRAMES NEVER ADOPTED — the finding's core law: per-type
 *     forced-invalid frames produce exactly one `malformed` drop and zero
 *     content events, and the previously-folded store survives byte-frozen.
 *
 * The guards hardened by this wave's sibling steps are exercised inside the
 * flood AND with targeted deterministic scenarios: c23 pong plausibility
 * window (phlix-syncplay-028), c24 members-presence refusal, c25 monotonic
 * stamp watermark, c38 saneServerStamp windows, c17 intends-membership
 * latch, c41 same-host replay no-op, c27 group_list row-drop, c29
 * protocol_version range law — plus the frame-level decode layer (garbage
 * JSON, legacy-Tizen wrapper, `__proto__` payloads, foreign vocabulary,
 * outbound-only canonical types).
 *
 * Determinism: one hand-rolled mulberry32 PRNG (plan ruling: no new dev
 * dependency), fixed seed; the `determinism` test replays the whole sweep
 * and compares the full trace fingerprint. Runtime is kept CI-fast
 * (pure object work, no real timers — the client's ONLY timer is the
 * coalesced-seek flush which this harness never drives).
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { describe, expect, it } from 'vitest';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage } from '../src/messages';

/* ------------------------------------------------------------------ */
/* Seeded PRNG (mulberry32) + generators — hand-rolled per plan       */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const SEED = 0x5eedf00d;

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}
function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Magnitudes chosen to sit exactly on or around the ratified windows. */
const ADVERSARIAL_NUMBERS: readonly number[] = [
  0, -0, -1, 1, 0.5, -2.5, NaN, Infinity, -Infinity, 1e308, 999, 1000, 1500,
  1999, 2000, 2001, 5e8, 1e9 - 1, 1e9, 1.7e9, 4e9 - 1, 4e9, 9e11, 1e12 - 1,
  1e12, 1.7e12, 4e12, Number.MAX_SAFE_INTEGER, Number.EPSILON,
];

const ADVERSARIAL_STRINGS: readonly string[] = [
  '', 'x', 'me', 'host1', 'sp_1', 'other1', '__proto__', 'constructor',
  'prototype', 'polluted', 'playing', 'stopped', '1', '0', 'null', 'NaN',
  'a'.repeat(64),
];

/** One adversarial JSON-ish value (bounded depth; may include cycles). */
function garbage(rng: Rng, depth = 2): unknown {
  if (depth <= 0) {
    return int(rng, 0, 4) === 0 ? null : int(rng, 0, 3) === 0 ? pick(rng, ADVERSARIAL_STRINGS) : pick(rng, ADVERSARIAL_NUMBERS);
  }
  switch (int(rng, 0, 7)) {
    case 0: return int(rng, 0, 3) === 0 ? NaN : int(rng, 0, 7) === 0 ? Infinity : pick(rng, ADVERSARIAL_NUMBERS);
    case 1: return pick(rng, ADVERSARIAL_STRINGS);
    case 2: return chance(rng, 0.5);
    case 3: return null;
    case 4: return Array.from({ length: int(rng, 0, 3) }, () => garbage(rng, depth - 1));
    case 5: {
      const o: Record<string, unknown> = {};
      for (let i = int(rng, 0, 3); i > 0; i--) o[pick(rng, ADVERSARIAL_STRINGS)] = garbage(rng, depth - 1);
      return o;
    }
    case 6: {
      // classic prototype-poison payload
      return JSON.parse('{"__proto__":{"polluted":1},"ok":1}');
    }
    default: return chance(rng, 0.5) ? [] : {};
  }
}

/* ------------------------------------------------------------------ */
/* Type vocabulary + per-type valid frames                             */
/* ------------------------------------------------------------------ */

const VOCAB = new Set<string>(Object.values(SYNCPLAY_MESSAGE_TYPES));
/** Canonical types the CLIENT sends — inbound they are unknown frames. */
const OUTBOUND_ONLY = new Set<string>([
  SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE,
  SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN,
  SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE,
  SYNCPLAY_MESSAGE_TYPES.TIME_PING,
]);
const TYPES = [...VOCAB];

const PLAYBACK_STATES = new Set(['playing', 'paused', 'buffering', 'stopped']);

/** The roster every valid group_state folds: host1 + me + other1. */
function validGroup(room = 'sp_1'): Record<string, unknown> {
  return {
    group_id: room,
    group_name: 'Fuzz Room',
    member_count: 3,
    host_id: 'host1',
    members: {
      host1: { name: 'H', joined_at: 1000 },
      me: { name: 'T', joined_at: 1001 },
      other1: { name: 'O', joined_at: 1002 },
    },
    current_media_id: 'media_1',
    current_media_duration: 60000,
    playback_position: 1000,
    playback_state: 'playing',
    queue: [{ media_id: 'media_1', added_at: 1000, added_by: 'host1' }],
  };
}

function validFrameFor(type: string, rng: Rng): Record<string, unknown> {
  const v = validGroup(chance(rng, 0.2) ? `sp_${int(rng, 2, 9)}` : 'sp_1');
  switch (type) {
    case SYNCPLAY_MESSAGE_TYPES.GROUP_STATE:
      return { type, protocol_version: 1, your_id: 'me', timestamp: 1.7e12, group: v };
    case SYNCPLAY_MESSAGE_TYPES.GROUP_LIST:
      return { type, groups: [{ id: 'sp_1', name: 'F', member_count: 3, has_password: false, current_media: 'm', is_playing: true }] };
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY:
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE:
      return { type, member_id: 'other1', position: int(rng, 0, 59000), server_time: 1.7e12 };
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK:
      return { type, member_id: 'other1', to_position: int(rng, 0, 59000), server_time: 1.7e12 };
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE:
      return { type, queue: (v.queue as unknown[]).concat([{ media_id: 'media_2' }]) };
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC:
      return chance(rng, 0.5)
        ? { type, member_id: 'other1', position: 500, is_playing: true, server_time: 1.7e12, nudge: { drift_ms: 120, direction: 'behind', suggested_rate: 1.05, tolerance_ms: 50, cooldown_ms: 1000 } }
        : { type, member_id: 'other1', position: 500 };
    case SYNCPLAY_MESSAGE_TYPES.CHAT:
      return { type, member_id: 'other1', member_name: 'O', message: 'hello', timestamp: 1.7e9 };
    case SYNCPLAY_MESSAGE_TYPES.TYPING:
      return { type, member_id: 'other1', is_typing: chance(rng, 0.5) };
    case SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER:
      return { type, current_host_id: 'host1', new_host_id: 'other1' };
    case SYNCPLAY_MESSAGE_TYPES.HOST_ELECT:
      return { type, elected_id: 'host1' };
    case SYNCPLAY_MESSAGE_TYPES.TIME_PONG:
      return { type };
    case SYNCPLAY_MESSAGE_TYPES.TIME_SYNC:
      return { type, member_id: 'other1', group_id: 'sp_1', server_time: 1.7e9, offset_ms: 12, latency_ms: 40, drift_rate: 0.1, is_stable: true };
    case SYNCPLAY_MESSAGE_TYPES.ERROR:
      return { type, error_code: 'B001', message: 'boom', details: { k: 1 } };
    case SYNCPLAY_MESSAGE_TYPES.INFO:
      return { type, member_id: 'newcomer', member_name: 'N', message: 'joined' };
    default:
      // outbound-only canonical types: valid inbound shape is irrelevant —
      // the dispatcher must route them to onUnknownFrame untouched.
      return { type };
  }
}

/** Field names whose mutation exercises that type's refusal arms. */
const MUTATE_KEYS: Record<string, readonly string[]> = {
  [SYNCPLAY_MESSAGE_TYPES.GROUP_STATE]: ['group', 'your_id', 'timestamp', 'protocol_version'],
  [SYNCPLAY_MESSAGE_TYPES.GROUP_LIST]: ['groups'],
  [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY]: ['member_id', 'position', 'server_time'],
  [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE]: ['member_id', 'position', 'server_time'],
  [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK]: ['member_id', 'to_position'],
  [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE]: ['queue'],
  [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC]: ['member_id', 'position', 'is_playing', 'server_time', 'nudge'],
  [SYNCPLAY_MESSAGE_TYPES.CHAT]: ['member_id', 'member_name', 'message', 'timestamp'],
  [SYNCPLAY_MESSAGE_TYPES.TYPING]: ['member_id', 'is_typing'],
  [SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER]: ['current_host_id', 'new_host_id'],
  [SYNCPLAY_MESSAGE_TYPES.HOST_ELECT]: ['elected_id', 'elected_by'],
  [SYNCPLAY_MESSAGE_TYPES.TIME_PONG]: ['client_time', 'server_time', 'ping_id'],
  [SYNCPLAY_MESSAGE_TYPES.TIME_SYNC]: ['member_id', 'group_id', 'server_time', 'offset_ms', 'latency_ms', 'drift_rate', 'is_stable'],
  [SYNCPLAY_MESSAGE_TYPES.ERROR]: ['error_code', 'code', 'message', 'details'],
  [SYNCPLAY_MESSAGE_TYPES.INFO]: ['member_id', 'member_name', 'message'],
  [SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE]: ['group_name'],
  [SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN]: ['group_id'],
  [SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE]: ['group_id'],
  [SYNCPLAY_MESSAGE_TYPES.TIME_PING]: [],
};

/** Nested group-payload keys mutation reaches (drives c24/c25/c37/c38 arms). */
const NESTED_KEYS = ['group_id', 'members', 'host_id', 'playback_state', 'playback_position', 'current_media_duration', 'queue', 'member_count'] as const;

function mutateFrame(type: string, rng: Rng): Record<string, unknown> {
  const f = validFrameFor(type, rng);
  const n = int(rng, 1, 2);
  for (let i = 0; i < n; i++) {
    const keys = MUTATE_KEYS[type] ?? [];
    if (keys.length === 0) break;
    const k = pick(rng, keys);
    if (chance(rng, 0.3)) {
      delete f[k];
    } else {
      f[k] = garbage(rng, 1);
    }
  }
  if (type === SYNCPLAY_MESSAGE_TYPES.GROUP_STATE && chance(rng, 0.6)) {
    const g = f.group;
    if (typeof g === 'object' && g !== null && !Array.isArray(g)) {
      const k = pick(rng, NESTED_KEYS);
      if (chance(rng, 0.25)) {
        delete (g as Record<string, unknown>)[k];
      } else {
        (g as Record<string, unknown>)[k] = garbage(rng, 1);
      }
    }
  }
  return f;
}

/* ------------------------------------------------------------------ */
/* Forced-invalid registry — the finding's core law claims (P5)        */
/* ------------------------------------------------------------------ */

interface InvalidArm { frame: Record<string, unknown>; note: string }

function forcedInvalidFor(type: string, rng: Rng): InvalidArm[] {
  const arms: InvalidArm[] = [];
  const base = () => validFrameFor(type, rng);
  if (type !== SYNCPLAY_MESSAGE_TYPES.GROUP_STATE) {
    const pv = base();
    pv.protocol_version = pick(rng, [0, -1, 2, 1.5, NaN, Infinity, '1', true, null]);
    arms.push({ frame: pv, note: 'protocol_version range law (phlix-syncplay-029/034)' });
  } else {
    const pv = base();
    pv.protocol_version = 3;
    arms.push({ frame: pv, note: 'protocol_version range law' });
  }
  switch (type) {
    case SYNCPLAY_MESSAGE_TYPES.GROUP_STATE: {
      const armsG: InvalidArm[] = [
        (() => { const f = base(); delete (f.group as Record<string, unknown>).members; return { frame: f, note: 'c24 members key omitted' }; })(),
        (() => { const f = base(); (f.group as Record<string, unknown>).group_id = int(rng, 0, 3) === 0 ? null : 42; return { frame: f, note: 'LW-041a group_id not string' }; })(),
        (() => { const f = base(); f.group = pick(rng, ['g', 42, true, null, [1, 2]]); return { frame: f, note: 'group payload not object' }; })(),
      ];
      return armsG.concat(arms);
    }
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY:
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE:
      return arms.concat([
        (() => { const f = base(); f.position = pick(rng, [-1, 'x', NaN, Infinity, null, {}]); return { frame: f, note: 'position refused domain' }; })(),
        (() => { const f = base(); delete f.position; return { frame: f, note: 'position absent' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK:
      return arms.concat([
        (() => { const f = base(); f.to_position = -1; return { frame: f, note: 'to_position negative' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE:
      return arms.concat([
        (() => { const f = base(); f.queue = pick(rng, ['q', 42, null, undefined, {}]); return { frame: f, note: 'queue not array (never fabricated)' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC:
      return arms.concat([
        (() => { const f = base(); f.member_id = 7; return { frame: f, note: 'LW-041b member_id not string' }; })(),
        (() => { const f = base(); f.position = -1e9; return { frame: f, note: 'sync position negative' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.CHAT:
      return arms.concat([
        (() => { const f = base(); f.member_id = {}; return { frame: f, note: 'chat member_id not string' }; })(),
        (() => { const f = base(); delete f.message; return { frame: f, note: 'chat message absent' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.TYPING:
      return arms.concat([
        (() => { const f = base(); f.member_id = null; return { frame: f, note: 'typing member_id null' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER:
      return arms.concat([
        (() => { const f = base(); f.current_host_id = 1; return { frame: f, note: 'transfer current not string' }; })(),
        (() => { const f = base(); delete f.new_host_id; return { frame: f, note: 'transfer new absent' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.TIME_SYNC:
      return arms.concat([
        (() => { const f = base(); f.group_id = undefined; return { frame: f, note: 'time_sync group_id undefined' }; })(),
        (() => { const f = base(); f.is_stable = 'true'; return { frame: f, note: 'time_sync is_stable not boolean' }; })(),
      ]);
    case SYNCPLAY_MESSAGE_TYPES.GROUP_LIST:
      return arms.concat([
        (() => { const f = base(); f.groups = pick(rng, ['g', 42, {}, null]); return { frame: f, note: 'groups not array' }; })(),
      ]);
    default:
      return arms;
  }
}

/* ------------------------------------------------------------------ */
/* Recording harness                                                   */
/* ------------------------------------------------------------------ */

interface Ev { hook: string; args: unknown[] }

interface FuzzHarness {
  client: SyncPlayClient;
  events: Ev[];
  sent: RawMessage[];
  clock: { now: () => number; set: (v: number) => void };
  /** Run a lifecycle op and drop its control events from the frame ledger. */
  op: (fn: (h: FuzzHarness) => unknown) => void;
  /** Fold a valid group_state (member 'me' in 'sp_1') and clear the ledger. */
  joinFold: (room?: string) => void;
}

function makeFuzzHarness(): FuzzHarness {
  const h = {} as FuzzHarness;
  h.events = [];
  h.sent = [];
  let t = 1000;
  h.clock = { now: () => t, set: (v: number) => { t = v; } };
  const ev = (hook: string) => (...args: unknown[]) => { h.events.push({ hook, args }); };
  const options = {
    send: (m: RawMessage) => { h.sent.push(m); },
    now: h.clock.now,
    memberId: 'me',
    memberName: 'Tester',
    onState: ev('state'),
    onIdentityMismatch: ev('mismatch'),
    onSync: ev('sync'),
    onSyncDegraded: ev('syncDegraded'),
    onPlaybackCommand: ev('command'),
    onMemberJoined: ev('joined'),
    onMemberLeft: ev('left'),
    onHostChanged: ev('hostChanged'),
    onError: ev('error'),
    onInfo: ev('info'),
    onMemberTyping: ev('typing'),
    onChat: ev('chat'),
    onHostTransfer: ev('hostTransfer'),
    onPlaybackSync: ev('playbackSync'),
    onNudge: ev('nudge'),
    onTimeSync: ev('timeSync'),
    onGroupList: ev('groupList'),
    onQueueChanged: ev('queueChanged'),
    onUnknownFrame: ev('unknown'),
    onFrameDropped: ev('drop'),
    seekThrottleMs: 0,
  } as ConstructorParameters<typeof SyncPlayClient>[0];
  h.client = new SyncPlayClient(options);
  h.op = (fn) => { fn(h); h.events.length = 0; };
  h.joinFold = (room = 'sp_1') => {
    h.op((x) => x.client.joinGroup(room));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      timestamp: 1.7e12,
      group: validGroup(room),
    });
    h.events.length = 0;
  };
  return h;
}

/* ------------------------------------------------------------------ */
/* Property engine                                                     */
/* ------------------------------------------------------------------ */

/** Hooks whose frames are ALLOWED to move the stored-group reference. */
const FOLDING = new Set(['state', 'queueChanged', 'hostChanged', 'hostTransfer']);

interface SweepCtx {
  violations: string[];
  trace: string[];
  frames: { n: number };
}

function safeJson(v: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, (_k, x) => {
      if (typeof x === 'number' && !Number.isFinite(x)) return `#${String(x)}`;
      if (typeof x === 'object' && x !== null) {
        if (seen.has(x)) return '#cycle';
        seen.add(x);
      }
      return x;
    }) ?? '#undefined';
  } catch {
    return '#unserialisable';
  }
}

function record(ctx: SweepCtx, frame: unknown, why: string): void {
  ctx.violations.push(`${why} :: frame=${safeJson(frame).slice(0, 300)}`);
}

function storeDigest(g: ReturnType<SyncPlayClient['getGroup']>): string {
  if (g === null) return 'null';
  return [g.group_id, g.members.map((m) => m.id).join('|'), String(g.host_id), g.playback_state, g.playback_position, String(g.current_media_duration), g.queue ? g.queue.length : 'x'].join('~');
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * One mirror of the ratified C38/C23 window (client.ts saneServerStamp +
 * serverTimeToMs): a delivered server stamp is either undefined or a
 * plausible-magnitude ms value. Used by the payload contract checks.
 */
function expectStamp(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1000) return undefined;
  const plausible = raw >= 1e12 || (raw >= 1e9 && raw < 4e9);
  return plausible ? (raw < 1e12 ? raw * 1000 : raw) : undefined;
}

/** P4 — the ratified store invariants every folded group must satisfy. */
function validateStore(g: ReturnType<SyncPlayClient['getGroup']>, ctx: SweepCtx, frame: unknown): void {
  if (g === null) return;
  if (typeof g.group_id !== 'string' || typeof g.group_name !== 'string') record(ctx, frame, 'P4 store id/name not string');
  if (!Array.isArray(g.members)) record(ctx, frame, 'P4 members not array');
  for (const m of g.members) {
    if (typeof m.id !== 'string' || typeof m.name !== 'string' || typeof m.is_host !== 'boolean' || !isFiniteNumber(m.joined_at) || m.joined_at < 0) {
      record(ctx, frame, 'P4 member shape');
    }
    if (m.is_host !== (m.id === g.host_id)) record(ctx, frame, 'P4 is_host not derived from host_id');
  }
  if (!(g.host_id === null || typeof g.host_id === 'string')) record(ctx, frame, 'P4 host_id');
  if (!(g.current_media_id === null || typeof g.current_media_id === 'string')) record(ctx, frame, 'P4 current_media_id');
  if (!(g.current_media_duration === null || (isFiniteNumber(g.current_media_duration) && g.current_media_duration >= 0))) {
    record(ctx, frame, 'P4 duration not null-or-finite-nonneg (c37)');
  }
  if (!isFiniteNumber(g.playback_position) || g.playback_position < 0) record(ctx, frame, 'P4 position not finite-nonneg');
  const dur = g.current_media_duration;
  if (typeof dur === 'number' && dur > 0 && g.playback_position > dur) {
    record(ctx, frame, 'P4 position exceeds duration ceiling');
  }
  if (!PLAYBACK_STATES.has(g.playback_state)) record(ctx, frame, 'P4 playback_state vocabulary');
  if (g.queue !== undefined) {
    if (!Array.isArray(g.queue)) record(ctx, frame, 'P4 queue not array');
    for (const q of g.queue) {
      if (typeof q.media_id !== 'string') record(ctx, frame, 'P4 queue media_id');
      if (q.media_info !== undefined && !isPlainObject(q.media_info)) record(ctx, frame, 'P4 queue media_info');
      if (q.added_at !== undefined && !isFiniteNumber(q.added_at)) record(ctx, frame, 'P4 queue added_at');
      if (q.added_by !== undefined && !(q.added_by === null || typeof q.added_by === 'string')) record(ctx, frame, 'P4 queue added_by');
    }
  }
  for (const k of ['member_count', 'created_at', 'last_activity_at'] as const) {
    const v = g[k];
    if (v !== undefined && !isFiniteNumber(v)) record(ctx, frame, `P4 ${k} defined-but-not-finite`);
  }
  if (!Object.isFrozen(g)) record(ctx, frame, 'P4 delivered store not frozen (phlix-syncplay-008)');
}

function validateContent(evName: string, args: unknown[], client: SyncPlayClient, ctx: SweepCtx, frame: unknown): void {
  switch (evName) {
    case 'state': {
      const [g, yourId] = args as [SyncPlayGroupLike, string | undefined];
      if (!Object.is(g, client.getGroup())) record(ctx, frame, 'P4 onState not the stored reference');
      validateStore(client.getGroup(), ctx, frame);
      if (!(yourId === undefined || typeof yourId === 'string')) record(ctx, frame, 'P4 yourId not string|undefined');
      break;
    }
    case 'mismatch': {
      const [a, b] = args as [unknown, unknown];
      if (typeof a !== 'string' || typeof b !== 'string') record(ctx, frame, 'P4 mismatch ids not strings');
      if (b !== client.getMemberId()) record(ctx, frame, 'P4 mismatch second arg != current id');
      break;
    }
    case 'sync': {
      const s = args[0] as { offset: number; latency: number; isStable: boolean };
      if (!isFiniteNumber(s.offset) || !isFiniteNumber(s.latency) || typeof s.isStable !== 'boolean') record(ctx, frame, 'P4 sync status shape');
      break;
    }
    case 'syncDegraded':
      if (!isFiniteNumber(args[0]) || (args[0] as number) < 1) record(ctx, frame, 'P4 syncDegraded streak');
      break;
    case 'command': {
      const c = args[0] as { type: unknown; position: unknown; serverTime: unknown };
      if (!['play', 'pause', 'seek'].includes(String(c.type))) record(ctx, frame, 'P4 command type');
      if (!isFiniteNumber(c.position) || c.position < 0) record(ctx, frame, 'P4 command position');
      if (!isFiniteNumber(c.serverTime)) record(ctx, frame, 'P4 command serverTime not finite');
      break;
    }
    case 'joined':
    case 'left': {
      const m = args[0] as { id: unknown; name: unknown };
      if (typeof m.id !== 'string' || typeof m.name !== 'string') record(ctx, frame, `P4 ${evName} member shape`);
      break;
    }
    case 'hostChanged':
      if (!(args[0] === null || typeof args[0] === 'string')) record(ctx, frame, 'P4 hostChanged arg');
      break;
    case 'hostTransfer':
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') record(ctx, frame, 'P4 hostTransfer args');
      break;
    case 'error': {
      const [code, message, details] = args as [unknown, unknown, unknown];
      if (typeof code !== 'string' || typeof message !== 'string') record(ctx, frame, 'P4 error strings');
      if (details !== undefined && !isPlainObject(details)) record(ctx, frame, 'P4 error details plain');
      break;
    }
    case 'info':
      if (typeof args[0] !== 'string') record(ctx, frame, 'P4 info string');
      break;
    case 'typing':
      if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') record(ctx, frame, 'P4 typing shape');
      break;
    case 'chat': {
      const [id, name, message, ts] = args as [unknown, unknown, unknown, unknown];
      if (typeof id !== 'string' || typeof name !== 'string' || typeof message !== 'string') record(ctx, frame, 'P4 chat strings');
      if (ts !== undefined && !(isFiniteNumber(ts) && ts >= 1e12)) record(ctx, frame, 'P4 chat ts not window-ms');
      break;
    }
    case 'playbackSync': {
      const [id, position, isPlaying, serverTime, nudge] = args as [unknown, unknown, unknown, unknown, unknown];
      if (typeof id !== 'string') record(ctx, frame, 'P4 sync sender not string');
      if (!isFiniteNumber(position) || (position as number) < 0) record(ctx, frame, 'P4 sync position');
      if (typeof isPlaying !== 'boolean') record(ctx, frame, 'P4 sync isPlaying');
      if (!isFiniteNumber(serverTime)) record(ctx, frame, 'P4 sync serverTime not finite');
      if (nudge !== undefined) validateNudge(nudge, ctx, frame, 'P4 nudge via sync arg');
      break;
    }
    case 'nudge':
      validateNudge(args[1], ctx, frame, 'P4 nudge event');
      break;
    case 'timeSync': {
      const s = args[0] as Record<string, unknown>;
      if (typeof s.memberId !== 'string' || typeof s.groupId !== 'string' || !isFiniteNumber(s.serverTimeSec) ||
        !isFiniteNumber(s.offsetMs) || !isFiniteNumber(s.latencyMs) || !isFiniteNumber(s.driftRate) ||
        typeof s.isStable !== 'boolean') record(ctx, frame, 'P4 timeSync shape');
      break;
    }
    case 'groupList': {
      const rows = args[0] as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) record(ctx, frame, 'P4 groupList not array');
      for (const r of rows) {
        if (typeof r.id !== 'string' || typeof r.name !== 'string' || !isFiniteNumber(r.member_count) ||
          typeof r.has_password !== 'boolean' || typeof r.is_playing !== 'boolean' ||
          !(r.current_media === null || typeof r.current_media === 'string')) record(ctx, frame, 'P4 groupList row shape (c27)');
      }
      break;
    }
    case 'queueChanged': {
      const q = args[0] as Array<Record<string, unknown>>;
      if (!Array.isArray(q)) { record(ctx, frame, 'P4 queueChanged not array'); break; }
      for (const item of q) {
        if (typeof item.media_id !== 'string') record(ctx, frame, 'P4 queueChanged item');
        if (item.added_at !== undefined && !isFiniteNumber(item.added_at)) record(ctx, frame, 'P4 queueChanged added_at');
      }
      break;
    }
    default:
      break;
  }
}

function validateNudge(n: unknown, ctx: SweepCtx, frame: unknown, why: string): void {
  if (!isPlainObject(n)) { record(ctx, frame, `${why} not object`); return; }
  if (n.drift_ms !== undefined && !isFiniteNumber(n.drift_ms)) record(ctx, frame, `${why} drift_ms`);
  if (n.direction !== undefined && n.direction !== 'behind' && n.direction !== 'ahead') record(ctx, frame, `${why} direction vocabulary`);
  if (n.suggested_rate !== undefined && !(isFiniteNumber(n.suggested_rate) && (n.suggested_rate as number) >= 0.9 && (n.suggested_rate as number) <= 1.1)) record(ctx, frame, `${why} suggested_rate domain`);
  for (const k of ['tolerance_ms', 'cooldown_ms']) {
    const v = n[k];
    if (v !== undefined && !(isFiniteNumber(v) && (v as number) >= 0)) record(ctx, frame, `${why} ${k}`);
  }
}

type SyncPlayGroupLike = ReturnType<SyncPlayClient['getGroup']> extends infer G ? Exclude<G, null> : never;

/** Feed one frame and enforce P1-P4 unconditionally. */
function feed(h: FuzzHarness, ctx: SweepCtx, frame: unknown): Ev[] {
  ctx.frames.n++;
  const before = h.events.length;
  const groupBefore = h.client.getGroup();
  const idBefore = h.client.getMemberId();
  let thrown: { e: unknown } | null = null;
  try {
    h.client.handleIncoming(frame);
  } catch (e) {
    thrown = { e };
  }
  if (thrown !== null) {
    record(ctx, frame, `P1 handleIncoming threw: ${String((thrown as { e: { message?: string } }).e?.message ?? thrown)}`);
    return [];
  }
  const slice = h.events.slice(before);
  const hooks = slice.map((e) => e.hook);
  const drops = hooks.filter((k) => k === 'drop').length;
  const unknowns = hooks.filter((k) => k === 'unknown').length;
  const content = slice.filter((e) => e.hook !== 'drop' && e.hook !== 'unknown');
  if (drops > 0 && (unknowns > 0 || content.length > 0)) record(ctx, frame, 'P2 drop co-fired with unknown/content');
  if (unknowns > 0 && content.length > 0) record(ctx, frame, 'P2 unknown co-fired with content');
  if (drops > 1) record(ctx, frame, 'P2 multiple drops for one frame');
  if (drops === 0) {
    if (content.some((e) => e.hook === 'mismatch') && !content.some((e) => e.hook === 'state')) record(ctx, frame, 'P2 mismatch without state in same frame');
    if (content.some((e) => e.hook === 'nudge') && content.some((e) => e.hook === 'playbackSync') &&
      hooks.indexOf('playbackSync') > hooks.indexOf('nudge')) record(ctx, frame, 'P2 nudge fired before playbackSync');
  }
  const movedStore = !Object.is(h.client.getGroup(), groupBefore);
  if (movedStore && !hooks.some((k) => FOLDING.has(k))) record(ctx, frame, 'P3 store ref moved without a folding hook');
  if (drops > 0 && movedStore) record(ctx, frame, 'P3 refused frame folded the store');
  if (h.client.getMemberId() !== idBefore) record(ctx, frame, 'P3 identity moved on a frame (adoptServerIdentity is the only seam)');
  for (const e of slice) validateContent(e.hook, e.args, h.client, ctx, frame);
  ctx.trace.push(`${storeDigest(groupBefore)}|${hooks.join(',')}|${storeDigest(h.client.getGroup())}`);
  return slice;
}

/* ------------------------------------------------------------------ */
/* Sweep driver (shared by the law sweep + determinism replay)         */
/* ------------------------------------------------------------------ */

const MSG_LEVEL_PER_TYPE = 125;
const FRAME_LEVEL_ROUNDS = 1200;

function rawPoolSample(rng: Rng): unknown {
  switch (int(rng, 0, 9)) {
    case 0: return chance(rng, 0.5) ? '{"type":' : chance(rng, 0.5) ? 'not json at all {' : '{"type":"syncplay_group_state","data":{"group":{"group_id":"sp_8","members":[]}},"your_id":"me"}';
    case 1: return chance(rng, 0.5) ? 42 : chance(rng, 0.5) ? 'plain string' : true;
    case 2: return chance(rng, 0.5) ? null : undefined;
    case 3: return JSON.parse('{"type":"syncplay_chat","member_id":"a","message":"m","__proto__":{"polluted":1}}');
    case 4: return chance(rng, 0.5) ? '[1,2,3]' : JSON.parse('[{"type":"syncplay_error"}]');
    case 5: return { type: `syncplay_foreign_${int(rng, 0, 50)}`, data: garbage(rng, 1) };
    case 6: return { noType: 1, type: int(rng, 0, 3) === 0 ? 5 : chance(rng, 0.5) ? null : undefined };
    case 7: { const o: Record<string, unknown> = { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, protocol_version: 1, your_id: 'me' }; o.group = garbage(rng, 2); return o; }
    case 8: return chance(rng, 0.5) ? { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: Infinity, server_time: -1e308 } : { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: 1e999 };
    default: return { type: pick(rng, [...TYPES]), protocol_version: pick(rng, [1, 2, 0, '1', NaN]), ...((pick(rng, [undefined, null, 1, 'x']) ?? {}) as object) };
  }
}

function runSweep(seed: number, joinFirst: boolean): SweepCtx {
  const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
  const rng = mulberry32(seed);
  const h = makeFuzzHarness();
  if (joinFirst) h.joinFold();
  // message-level: every canonical type, seeded mutations
  for (const type of TYPES) {
    for (let i = 0; i < MSG_LEVEL_PER_TYPE; i++) {
      feed(h, ctx, mutateFrame(type, rng));
    }
  }
  // frame-level: pre-decode raws (strings, non-objects, wrapper payloads...)
  for (let i = 0; i < FRAME_LEVEL_ROUNDS; i++) {
    feed(h, ctx, rawPoolSample(rng));
  }
  // interleaved lifecycle pressure keeps the guards live across generations
  if (chance(rng, 1)) {
    h.op((x) => x.client.onDisconnect());
    h.op((x) => x.client.joinGroup('sp_2'));
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_2') });
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, member_id: 'other1', position: 5 });
    h.op((x) => x.client.leaveGroup());
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_2') });
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, member_id: 'other1', position: 5 });
    h.op((x) => x.client.destroy());
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.ERROR, message: 'after destroy' });
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('S-syncplay-40 adversarial fuzz harness (phlix-syncplay-051)', () => {
  const FIRST = runSweep(SEED, true);
  const SECOND = runSweep(SEED, false);
  const TOTAL_FRAMES = FIRST.frames.n + SECOND.frames.n;

  it('P1-P4 property sweep over the full 19-type vocabulary + frame layer holds', () => {
    expect(FIRST.violations).toEqual([]);
    expect(SECOND.violations).toEqual([]);
  });

  it('sweep is deterministic: same seed, identical trace fingerprint', () => {
    expect(FIRST.trace.join('\n')).toBe(runSweep(SEED, true).trace.join('\n'));
    expect(SECOND.trace.join('\n')).toBe(runSweep(SEED, false).trace.join('\n'));
  });

  it('frame budget: the harness actually floods (finding asked for ~3900 frames)', () => {
    expect(TOTAL_FRAMES).toBeGreaterThanOrEqual(3800);
  });

  it('P5 invalid frames ⇒ dropped, never adopted (forced-invalid claims)', () => {
    const rng = mulberry32(SEED ^ 0x40ff);
    const violations: string[] = [];
    const vctx: SweepCtx = { violations, trace: [], frames: { n: 0 } };
    const h = makeFuzzHarness();
    h.joinFold();
    for (const type of TYPES) {
      for (const arm of forcedInvalidFor(type, rng)) {
        const before = h.client.getGroup();
        const slice = feed(h, vctx, arm.frame);
        const hooks = slice.map((e) => e.hook);
        // The c29 protocol_version check runs BEFORE the type switch, so a
        // pv-violating outbound-only frame refuses (drop) rather than reaching
        // the default onUnknownFrame arm — both sinks satisfy "never adopted".
        const expected = OUTBOUND_ONLY.has(type) && !arm.note.includes('protocol_version') ? ['unknown'] : ['drop'];
        if (hooks.length !== 1 || hooks[0] !== expected[0]) violations.push(`P5 ${arm.note}: hooks=${hooks.join(',')} want=${expected[0]}`);
        if (hooks[0] === 'drop' && (slice[0] as { args: unknown[] }).args[0] !== 'malformed' && (slice[0] as { args: unknown[] }).args[0] !== 'undecodable') {
          violations.push(`P5 ${arm.note}: drop reason ${(slice[0] as { args: unknown[] }).args[0]}`);
        }
        if (!Object.is(h.client.getGroup(), before)) violations.push(`P5 ${arm.note}: store ref moved`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('valid frames still fold (adoption is not blanket refusal)', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    let slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST, groups: [{ id: 'sp_1', name: 'F', member_count: 1, has_password: false, current_media: null, is_playing: false }] });
    expect(slice.map((e) => e.hook)).toEqual(['groupList']);
    slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_1') });
    expect(slice.map((e) => e.hook)).toEqual(['state']);
    slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, member_id: 'other1', position: 10 });
    expect(slice.map((e) => e.hook)).toEqual(['command']);
    slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, member_id: 'other1', position: 10, nudge: { direction: 'ahead', suggested_rate: 0.5 } });
    // suggested_rate out of [0.9,1.1] folds to undefined but the nudge
    // OBJECT itself is still normalized and delivered (present-object law).
    expect(slice.map((e) => e.hook)).toEqual(['playbackSync', 'nudge']);
    expect((slice[1].args[1] as Record<string, unknown>).suggested_rate).toBeUndefined();
    expect(ctx.violations).toEqual([]);
  });

  it('c17 intends-membership latch survives hostile echoes', () => {
    const rng = mulberry32(SEED ^ 0x17);
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold();
    h.op((x) => x.client.leaveGroup());
    // post-leave in-flight echoes: valid shapes AND garbage, all refused
    for (let i = 0; i < 120; i++) {
      const f = i % 2 === 0 ? { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_1') } : mutateFrame(SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, rng);
      const slice = feed(h, ctx, f);
      const hooks = slice.map((e) => e.hook);
      const pure = hooks.length === 0 || (hooks.length === 1 && (hooks[0] === 'drop' || hooks[0] === 'unknown'));
      if (!pure) ctx.violations.push(`c17 post-leave echo adopted: ${hooks.join(',')}`);
      expect(h.client.getGroup()).toBeNull();
    }
    // re-arm by join, hostile state still refused while latch inert
    h.op((x) => x.client.joinGroup('sp_3'));
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: { group_id: 'sp_3', members: undefined } });
    expect(h.client.getGroup()).toBeNull();
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_3') });
    expect(h.client.getGroup()?.group_id).toBe('sp_3');
    // onDisconnect must NOT disarm the latch (ratified law)
    h.op((x) => x.client.onDisconnect());
    feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: validGroup('sp_3') });
    expect(h.client.getGroup()?.group_id).toBe('sp_3');
    expect(ctx.violations).toEqual([]);
  });

  it('c24 members-presence refusal purity vs ratified fold arms', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold();
    const frozen = h.client.getGroup();
    for (const members of [undefined, 'm', 5, null, [], {}] as const) {
      const prevCount = h.client.getGroup()?.members.length ?? 0;
      const slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: { group_id: 'sp_1', members } });
      const hooks = slice.map((e) => e.hook);
      if (members === undefined) {
        expect(hooks).toEqual(['drop']);
        expect(Object.is(h.client.getGroup(), frozen)).toBe(true);
      } else {
        // Present-but-wrong-type / honest-zero spellings ADOPT with an empty
        // roster — and the ratified M-SYNCPLAY-16 same-room diff then fires
        // onMemberLeft for every previously cached member (the fold emptying
        // the roster is itself a roster change). prevCount is read BEFORE the
        // feed; deriving it from the post-fold store would be tautological.
        expect(hooks).toEqual([...Array.from({ length: prevCount }, () => 'left'), 'state']);
        const g = h.client.getGroup();
        expect(Array.isArray(g?.members)).toBe(true);
        expect(g?.members.length ?? -1).toBeLessThanOrEqual(0); // wrong-type/null fold to empty roster
      }
    }
    expect(ctx.violations).toEqual([]);
  });

  it('c25 monotonic watermark: boundary sweep, follow-law, room scoping', () => {
    const T = 1.7e12;
    const state = (room: string, stamp: number | undefined) => {
      const g = validGroup(room);
      const f: Record<string, unknown> = { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'me', group: g };
      if (stamp !== undefined) f.timestamp = stamp;
      return f;
    };
    const rng = mulberry32(SEED ^ 0x25);
    // Boundary law — STRICT >: stale-by <=2000 adopts, >2000 refuses. Each
    // probe runs on a FRESH watermark (joinFold stamps slot=T): sequential
    // feeding would follow the slot down on within-tolerance-older adoptions
    // (the ratified follow-law) and make per-arm expectations sequence
    // dependent, which would test nothing at the boundary.
    for (const d of [0, 1, 1999, 2000, 2001, 2002, 5000, 1e6, ...Array.from({ length: 30 }, () => Math.abs(int(rng, 0, 6000)))]) {
      const h = makeFuzzHarness();
      const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
      h.joinFold(); // slot = {sp_1, T}
      const before = h.client.getGroup();
      const hooks = feed(h, ctx, state('sp_1', T - d)).map((e) => e.hook);
      if (d > 2000 && hooks.join() !== 'drop') ctx.violations.push(`c25 stale-by-${d} not refused (${hooks})`);
      if (d <= 2000 && hooks.join() !== 'state') ctx.violations.push(`c25 within-tolerance ${d} not adopted (${hooks})`);
      if (d > 2000 && !Object.is(h.client.getGroup(), before)) ctx.violations.push(`c25 refusal moved store (${d})`);
      expect(ctx.violations).toEqual([]);
    }
    // Deterministic law sequence on ONE slot lineage: refusals never move the
    // watermark; adoptions (even within-tolerance-OLDER ones) DO follow it.
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold(); // slot = {sp_1, T}
    expect(feed(h, ctx, state('sp_1', T + 2001)).map((e) => e.hook)).toEqual(['state']); // newer; slot -> T+2001
    const high = h.client.getGroup();
    expect(feed(h, ctx, state('sp_1', T)).map((e) => e.hook)).toEqual(['drop']); // stale-by-2001: refused, pure
    expect(Object.is(h.client.getGroup(), high)).toBe(true);
    expect(feed(h, ctx, state('sp_1', T + 1)).map((e) => e.hook)).toEqual(['state']); // stale-by-2000 == tol: adopts
    expect(feed(h, ctx, state('sp_1', T - 2000)).map((e) => e.hook)).toEqual(['drop']); // slot followed to T+1: stale-by-2001 refused
    // untrusted stamp adopts but does NOT move the watermark
    expect(feed(h, ctx, state('sp_1', 5e8)).map((e) => e.hook)).toEqual(['state']); // 5e8 untrusted (below era floor)
    expect(feed(h, ctx, state('sp_1', T - 3001)).map((e) => e.hook)).toEqual(['drop']); // slot still T+1 -> 3002 older
    // room scoping: cross-room stale adopts (the slot is single, keyed by the
    // LAST ADOPTED fold's room), and the same-room replay is then refused.
    expect(feed(h, ctx, state('sp_9', T - 9000)).map((e) => e.hook)).toEqual(['state']); // slot -> {sp_9, T-9000}
    expect(feed(h, ctx, state('sp_9', T - 9000 - 2001)).map((e) => e.hook)).toEqual(['drop']); // same-room stale-by-2001
    expect(feed(h, ctx, state('sp_1', T - 5000)).map((e) => e.hook)).toEqual(['state']); // sp_1 unscoped by sp_9's slot
    expect(ctx.violations).toEqual([]);
  });

  it('c23 pong plausibility window: real-era rejects, no state poison', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold();
    h.clock.set(1.7e12);
    h.op((x) => x.client.pingTime());
    const groupBefore = h.client.getGroup();
    const pongs = [
      { t1: 1.7e12, server_time: 1.7e12, want: 'sync' },          // plausible ms
      { t1: 1.7e12, server_time: 1.7e9, want: 'either' },          // plausible seconds-form
      { t1: 1.7e12, server_time: 9e11, want: 'syncDegraded' },     // out-of-window finite
      { t1: 1.7e12, server_time: 1e12 - 1, want: 'syncDegraded' }, // boundary minus
      { t1: 1.7e12, server_time: 'x', want: 'syncDegraded' },      // non-numeric
      { t1: 1.7e12, want: 'syncDegraded' },                         // absent t2 (LW-043)
    ] as const;
    for (const arm of pongs) {
      h.op((x) => x.client.pingTime());
      const f: Record<string, unknown> = { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: arm.t1 };
      if ('server_time' in arm) f.server_time = (arm as { server_time?: unknown }).server_time;
      const hooks = feed(h, ctx, f).map((e) => e.hook);
      if (arm.want === 'either') {
        if (hooks.join() !== 'sync' && hooks.join() !== 'syncDegraded') ctx.violations.push(`c23 ${arm.t1} arm emitted ${hooks}`);
      } else if (hooks.join() !== arm.want) {
        ctx.violations.push(`c23 server_time=${String(f.server_time)} want=${arm.want} got=${hooks}`);
      }
      if (!Object.is(h.client.getGroup(), groupBefore)) ctx.violations.push('c23 pong fold mutated group store');
    }
    // no outstanding pong: rounds are silent and the estimator untouched
    const offsetBefore = h.client.getTimeSync().getOffset();
    const silentHooks = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: 1.7e12, server_time: 1.7e12 }).map((e) => e.hook);
    expect(silentHooks).toEqual([]);
    expect(h.client.getTimeSync().getOffset()).toBe(offsetBefore);
    // unmatched echo: refused WITHOUT consuming the live round (M-SYNCPLAY-13
    // / phlix-syncplay-047 straggler law), then the true pong still fires.
    h.clock.set(2.7e12);
    h.op((x) => x.client.pingTime());
    const straggler = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: 1.7e12, server_time: 2.7e12 }).map((e) => e.hook);
    expect(straggler).toEqual([]);
    const truePong = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: 2.7e12, server_time: 2.7e12 }).map((e) => e.hook);
    expect(['sync', 'syncDegraded']).toContain(truePong.join());
    // disconnect drops the outstanding slot: a late pong from the dead round is silent
    h.op((x) => x.client.pingTime());
    h.op((x) => x.client.onDisconnect());
    const epochHooks = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, client_time: 3.7e12, server_time: 3.7e12 }).map((e) => e.hook);
    expect(epochHooks).toEqual([]);
    expect(ctx.violations).toEqual([]);
  });

  it('c41 same-host replay is a whole no-op under flooding', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold(); // host_id 'host1'
    const before = h.client.getGroup();
    // every replay arm — absent/''/ghost/self/non-string elected_by — is a
    // whole no-op: no eviction happens, so the c41 same-host guard silences it.
    for (const by of [undefined, '', 'ghost9', 5, {}, []] as const) {
      for (let i = 0; i < 3; i++) {
        const f: Record<string, unknown> = { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'host1' };
        if (by !== undefined) f.elected_by = by;
        expect(feed(h, ctx, f).map((e) => e.hook)).toEqual([]);
      }
    }
    // self-eviction guard: elected_by 'me' must never strip our own id
    expect(feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'host1', elected_by: 'me' }).map((e) => e.hook)).toEqual([]);
    expect(h.client.getGroup()?.members.map((m) => m.id)).toContain('me');
    expect(Object.is(h.client.getGroup(), before)).toBe(true);
    // genuine change folds + announces, then ITS replay is the no-op
    expect(feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'other1' }).map((e) => e.hook)).toEqual(['hostChanged']);
    const after = h.client.getGroup();
    expect(after?.host_id).toBe('other1');
    expect(feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'other1' }).map((e) => e.hook)).toEqual([]);
    expect(Object.is(h.client.getGroup(), after)).toBe(true);
    // eviction elect announces left-then-changed and DOES fold
    const evHooks = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'newhost', elected_by: 'other1' }).map((e) => e.hook);
    expect(evHooks).toEqual(['left', 'hostChanged']);
    expect(h.client.getGroup()?.members.map((m) => m.id)).toEqual(['host1', 'me']);
    // ungrouped LW-047 exception: announce regardless, replays included
    const g = makeFuzzHarness();
    expect(feed(g, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'x' }).map((e) => e.hook)).toEqual(['hostChanged']);
    expect(feed(g, ctx, { type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, elected_id: 'x' }).map((e) => e.hook)).toEqual(['hostChanged']);
    expect(ctx.violations).toEqual([]);
  });

  it('c38 chat stamp window + seconds promotion (fuzzed magnitudes)', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold();
    const rng = mulberry32(SEED ^ 0x38);
    for (let i = 0; i < 300; i++) {
      const stamp = chance(rng, 0.15) ? garbage(rng, 1) : pick(rng, ADVERSARIAL_NUMBERS);
      const slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.CHAT, member_id: 'other1', member_name: 'O', message: 'hi', timestamp: stamp });
      const hooks = slice.map((e) => e.hook);
      if (hooks.join() !== 'chat') { ctx.violations.push(`c38 chat hooks=${hooks}`); continue; }
      const got = (slice[0].args[3] as number | undefined);
      const want = expectStamp(stamp);
      if (!Object.is(got, want)) ctx.violations.push(`c38 stamp=${String(stamp)} delivered ${String(got)} want ${String(want)}`);
    }
    expect(ctx.violations).toEqual([]);
  });

  it('c27 group_list rows never mint non-string ids', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    const rng = mulberry32(SEED ^ 0x27);
    for (let i = 0; i < 60; i++) {
      const rows = Array.from({ length: int(rng, 1, 8) }, () =>
        chance(rng, 0.4) ? { id: `sp_${int(rng, 0, 9)}`, name: chance(rng, 0.5) ? 'n' : garbage(rng, 0), member_count: chance(rng, 0.8) ? int(rng, 0, 5) : garbage(rng, 0), has_password: garbage(rng, 0), current_media: chance(rng, 0.6) ? 'm' : garbage(rng, 0), is_playing: garbage(rng, 0) } : garbage(rng, 1));
      const slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST, groups: rows });
      const hooks = slice.map((e) => e.hook);
      if (hooks.join() !== 'groupList') { ctx.violations.push(`c27 hooks=${hooks}`); continue; }
      const out = slice[0].args[0] as Array<Record<string, unknown>>;
      const strIds = rows.filter((r) => isPlainObject(r) && typeof r.id === 'string').length;
      if (out.length !== strIds) ctx.violations.push(`c27 dropped-row count ${out.length} != string-id rows ${strIds}`);
    }
    expect(ctx.violations).toEqual([]);
  });

  it('outbound-only canonical types arrive as unknown frames; foreign vocab too', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    for (const t of [...OUTBOUND_ONLY]) {
      const hooks = feed(h, ctx, { type: t, some: 'payload' }).map((e) => e.hook);
      expect(hooks).toEqual(['unknown']);
    }
    for (let i = 0; i < 200; i++) {
      const raw = garbage(rngSeed(i), 2);
      const maybeType = isPlainObject(raw) ? raw.type : undefined;
      if (typeof maybeType !== 'string') continue;
      const hooks = feed(h, ctx, raw).map((e) => e.hook);
      if (VOCAB.has(maybeType)) {
        // canonical types must never be silently dropped at the sink layer
        expect(hooks.length).toBeGreaterThan(0);
      } else {
        expect(hooks).toEqual(['unknown']);
      }
    }
    expect(ctx.violations).toEqual([]);
  });

  it('legacy Tizen wrapper unwraps under the same laws; no prototype pollution', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    const wrapped = JSON.parse('{"type":"syncplay_group_state","data":{"group":{"group_id":"sp_7","members":[]},"your_id":"me"},"__proto__":{"polluted":1}}');
    const hooks = feed(h, ctx, wrapped).map((e) => e.hook);
    expect(hooks).toEqual(['state']);
    expect(h.client.getGroup()?.group_id).toBe('sp_7');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(ctx.violations).toEqual([]);
  });

  it('destroyed client is inert: zero events for any flood', () => {
    const h = makeFuzzHarness();
    h.joinFold();
    h.op((x) => x.client.destroy());
    const frozen = h.client.getGroup();
    for (const t of TYPES) {
      expect(feed(h, { violations: [], trace: [], frames: { n: 0 } }, validFrameFor(t, mulberry32(SEED))).length).toBe(0);
    }
    expect(Object.is(h.client.getGroup(), frozen)).toBe(true);
  });

  it('self-echo suppression silent even when payload is garbage (pre-position law)', () => {
    const h = makeFuzzHarness();
    h.joinFold();
    for (const t of [SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE, SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK]) {
      expect(feed(h, { violations: [], trace: [], frames: { n: 0 } }, { type: t, member_id: 'me', position: -1, to_position: 'x' }).length).toBe(0);
    }
  });

  it('identity mismatch + adoption ordering under fuzzed your_id', () => {
    const h = makeFuzzHarness();
    const ctx: SweepCtx = { violations: [], trace: [], frames: { n: 0 } };
    h.joinFold();
    const slice = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'ghost', group: validGroup('sp_1') });
    expect(slice.map((e) => e.hook)).toEqual(['state', 'mismatch']);
    expect(slice[1].args).toEqual(['ghost', 'me']);
    expect(ctx.violations).toEqual([]);
    // seam adoption then re-fold with matching id: no more mismatch
    h.op((x) => x.client.adoptServerIdentity('ghost'));
    expect(h.client.getMemberId()).toBe('ghost');
    const again = feed(h, ctx, { type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, your_id: 'ghost', group: validGroup('sp_1') });
    expect(again.map((e) => e.hook)).toEqual(['state']);
  });
});

function rngSeed(n: number): Rng {
  return mulberry32(SEED + n * 7919);
}
