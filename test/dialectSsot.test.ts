/**
 * Review wave w20 L6 — LW-082-d (register
 * `.reviews/2026-11-04/wiring-hub.md`, Info finding "syncplay WS dialect
 * (19 message names) verified identical across phlix-syncplay, phlix-server
 * and phlix-hub — but structurally triplicated, not shared").
 *
 * The canonical `syncplay_*` message catalog is transcribed in three repos:
 * here (`src/messages.ts` plus the SPEC §3 table), in phlix-server's
 * `Messages::TYPE_*` constants (the live :8097 producer), and in phlix-hub's
 * single-quoted wire literals under `src/SyncPlay/` (the :8804 relay). The
 * audit verified the three-way set diff EMPTY in its window, yet nothing
 * compared the legs MECHANICALLY — a rename on any leg surfaced as a runtime
 * mismatch, not as a red drift test (contrast the settings ALLOWED_KEYS and
 * MCP-scopes guards, which ship live comparators). This file is the live
 * comparator on the JS side of the family; the PHP side ships its own half in
 * the same commit group.
 *
 * Legs:
 *  1. (always) the SPEC §3 table's wire strings == the src catalog, both
 *     directions; the section heading's count tracks the catalog length; and
 *     the §3 name->value PAIRS equal the `SYNCPLAY_MESSAGE_TYPES` pairs, so a
 *     crossed value (right name, wrong string) on either side reddens the
 *     docs<->code seam even when both value sets stay equal.
 *  2. (phlix-server checkout visible) the shape of `Messages::TYPE_*`: the
 *     TYPE_ surface is non-empty and duplicate-free in either form (identity
 *     aliases onto `SyncPlayDialect::TYPE_*` — the post-`3b878403` era — or
 *     legacy quoted literals); every alias is IDENTITY (name === target), and
 *     any legacy literal value is a catalog member. Cross-file value equality
 *     for the server lives in legs 2b/2c, which need the dialect in view.
 *  2b. (phlix-shared checkout visible) `src/Relay/SyncPlayDialect.php` — the
 *     single source of truth since the server alias refactor — carries exactly
 *     the catalog's 19 wire values (both directions), and its name->value
 *     pairs, mapped through the two declared name exceptions, equal the §3
 *     pairs. A chat/typing VALUE swap keeps the set equality green and is
 *     convicted here, by name.
 *  2c. (server AND shared visible) the server alias-name set == the dialect
 *     name set (both directions), every alias target is a declared dialect
 *     const, and the resolved server values equal the catalog both
 *     directions BY NAME — a stale or crossed transcription cannot hide.
 *  3. (phlix-hub checkout visible) the union of single/double-quoted
 *     `syncplay_*` literals over every PHP file under the hub's
 *     `src/SyncPlay/` == the catalog, both directions, with PHP comments
 *     stripped first. The hub's relay-local BARE family (`room_state`,
 *     `client_joined`, `client_left`, `time_sync_reply`) carries no
 *     `syncplay_` prefix and is out of scope by construction — the same
 *     separation the audit confirmed. Dotted error codes
 *     (`syncplay.queue_limit_exceeded`) and config keys (`'syncplay_mount'`,
 *     `'syncplay_port'`) neither match the quoted wire shape nor live under
 *     the parsed tree.
 *  4. (always) parser self-tests on synthetic fixtures: a parser that stopped
 *     matching must fail LOUD, never "equal" two empty transcriptions
 *     vacuously. Legs 2/2b/2c/3 additionally red on a zero-capture result
 *     against a visible checkout — a transcription that MOVES is a broken
 *     guard, not a missing one.
 *  5. (always) the SPEC §5 worked-example vectors table is parsed, validated
 *     for arithmetic self-consistency, and driven mechanically against the
 *     real `TimeSync` — the guard compares MATH, not just names (finding
 *     phlix-syncplay-015's second half).
 *
 * Checkout discovery: `PHLIX_SERVER_REPO` / `PHLIX_HUB_REPO` /
 * `PHLIX_SHARED_REPO` (absolute paths; a set-but-bad path throws at
 * collection — an explicit request is never silently downgraded to a skip),
 * else the sibling directories `../phlix-server` / `../phlix-hub` /
 * `../phlix-shared` of this repo (estate layout). When a leg is invisible its
 * comparison test SKIPS with the reason in the test name (visible in the run
 * summary), never silently passes; repo CI runs single-repo checkouts and
 * therefore exercises the skip arms. Setting `PHLIX_DIALECT_GUARD_STRICT=1`
 * turns an invisible checkout RED — the estate cross-repo sweep flips that
 * from one machine to prove all legs at once.
 *
 * This guard lands GREEN: it adds no new wire law, it mechanizes the equality
 * the audit already proved, verified here at sibling tips phlix-server
 * `c904aa4d3b3dff1dffa7cb4486b3e7511301d3dd` and phlix-hub
 * `8913ae11662810b3ce41f08ea0102e3864d641a4` (window 2026-11-07). Its teeth
 * were proven by executed mutation probes instead: renaming one server const
 * reddens leg 2, one hub literal reddens leg 3, one SPEC row reddens leg 1,
 * and a src-entry rename reddens leg 1 ALWAYS — plus legs 2 and 3 whenever
 * those checkouts are visible (off-estate single-repo CI, where the siblings
 * skip, sees a src-entry rename in leg 1 only). The vacuity fixtures red at
 * any parser-shape regression.
 *
 * RE-AIM (S-syncplay-13, 2026-11-27; findings phlix-syncplay-015,
 * phlix-syncplay-056). The leg-2 parser originally pinned the PRE-`3b878403`
 * shape (literal `'syncplay_*'` assignments inside Messages.php); the server's
 * alias refactor moved every literal value into phlix-shared's
 * `SyncPlayDialect`, so the parse found zero consts and the guard reddened —
 * the estate's one known syncplay battery red at server `262f01d3`-era. The
 * SSOT is now `src/Relay/SyncPlayDialect.php` in phlix-shared (probe tip
 * `1b3dd724ff49cae156b5b8ecd820ee22f3b1c092`); legs 2/2b/2c split the server
 * check into shape (aliases are identity pairs, dual-form parser) and
 * resolved-value equality through the dialect, with PAIR (name->value)
 * comparisons wherever set-equality is blind to a crossing — the two chat
 * consts' names are not value-derivable, so `TYPE_CHAT_MESSAGE` /
 * `TYPE_CHAT_TYPING` cross-assigning their values keeps every SET green and
 * only the pair legs convict. Leg 5 adds the numeric dimension -015 said was
 * missing: §5 vectors pin theta's SIGN, the `trunc(rtt/2)` halving, the real
 * (uncrushed) weight-sum divisor, the recent-5 slice, the acceptance bounds,
 * and the strict `< 50` variance boundary against the live `TimeSync`.
 * Mutation re-proofs this era (executed on scratch copies): a crossed server
 * alias reddens leg 2; swapping the dialect's two chat VALUES reddens legs
 * 2b/2c pair legs while their set legs stay green; dropping a dialect const,
 * or its terminating semicolon, reddens 2b/2c (18 != 19); an added foreign
 * dialect const reddens 2b/2c both directions; a sign revert, a trunc removal,
 * or a `max(1, weightSum)` crush in `time-sync.ts` each redden leg 5; and
 * deleting the vectors table reddens leg 5 LOUD (loader throws) rather than
 * skipping vacuously.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_MESSAGE_TYPES, SYNCPLAY_MESSAGE_TYPES } from '../src/messages';
import { MAX_ACCEPTABLE_RTT, OFFSET_SAMPLE_COUNT, TimeSync } from '../src/time-sync';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC = readFileSync(join(REPO_ROOT, 'SPEC.md'), 'utf8');

/** This repo's canonical wire names — the object every leg is compared to. */
const CATALOG: readonly string[] = ALL_MESSAGE_TYPES;
const sortedUnique = (names: readonly string[]): string[] => [...new Set(names)].sort();
const CATALOG_SORTED = sortedUnique(CATALOG);

const STRICT = process.env.PHLIX_DIALECT_GUARD_STRICT === '1';

interface Checkout {
  leg: string;
  envVar: string;
  /** Absolute root of a visible checkout, or null when nothing is there. */
  root: string | null;
}

function locateCheckout(leg: string, envVar: string): Checkout {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== '') {
    const root = resolve(fromEnv);
    if (!existsSync(join(root, 'composer.json'))) {
      throw new Error(
        `${envVar} points at ${root}, which is not a PHP repo checkout ` +
          `(no composer.json) — fix the path or unset the variable`,
      );
    }
    return { leg, envVar, root };
  }
  const sibling = resolve(REPO_ROOT, '..', leg);
  return existsSync(join(sibling, 'composer.json'))
    ? { leg, envVar, root: sibling }
    : { leg, envVar, root: null };
}

function readTarget(checkout: Checkout, rel: string): string {
  if (checkout.root === null) {
    throw new Error(`unreachable: ${checkout.leg} leg ran without a visible checkout`);
  }
  const path = join(checkout.root, rel);
  if (!existsSync(path)) {
    throw new Error(
      `${checkout.leg}: ${rel} not found under ${checkout.root} — the dialect ` +
        `transcription moved; point test/dialectSsot.test.ts at the new home ` +
        `(a guard that silently stops seeing the truth is no guard)`,
    );
  }
  return readFileSync(path, 'utf8');
}

interface PhpConstPair {
  name: string;
  value: string;
}

/**
 * Literal-form `TYPE_*` consts (the dialect's own shape, and the server's
 * PRE-`3b878403` shape): anchored to the start of line so docblock/`*` prose
 * can never leak in, and anchored to the terminating `;` so a const that
 * DROPS its terminator is invisible to the parse — which the non-zero,
 * duplicate and pair-count checks then convict (a transcription cannot
 * "pass" by disappearing; see the leg-4 fixtures).
 */
function literalTypePairs(text: string): PhpConstPair[] {
  return [
    ...text.matchAll(
      /^\s*public const (TYPE_[A-Z][A-Z0-9_]*)\s*=\s*(['"])(syncplay_[a-z0-9_]+)\2\s*;/gm,
    ),
  ].map((m) => ({ name: m[1] as string, value: m[3] as string }));
}

/**
 * Alias-form `TYPE_*` consts (the server's post-`3b878403` shape:
 * `public const TYPE_X = SyncPlayDialect::TYPE_Y;`). Same line anchor — the
 * phlix-shared dialect's own docblock carries an alias-form EXAMPLE line, so
 * a non-anchored parse would read the prose as a transcription.
 */
function aliasTypePairs(text: string): { name: string; target: string }[] {
  return [
    ...text.matchAll(
      /^\s*public const (TYPE_[A-Z][A-Z0-9_]*)\s*=\s*SyncPlayDialect::(TYPE_[A-Z][A-Z0-9_]*)\s*;/gm,
    ),
  ].map((m) => ({ name: m[1] as string, target: m[2] as string }));
}

/** Deterministic PHP comment strip for the hub literal scan (see header). */
function stripPhpComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)(\s*)(\/\/|#)[^\n]*/g, '\n')
    .replace(/\/\/[^\n]*|#[^\n]*/g, '');
}

function phpFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...phpFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith('.php')) out.push(path);
  }
  return out;
}

function hubWireLiterals(hubRoot: string): string[] {
  const names: string[] = [];
  for (const file of phpFilesUnder(join(hubRoot, 'src/SyncPlay'))) {
    const stripped = stripPhpComments(readFileSync(file, 'utf8'));
    for (const m of stripped.matchAll(/'syncplay_[a-z0-9_]+'|"(syncplay_[a-z0-9_]+)"/g)) {
      names.push((m[1] ?? m[0].slice(1, -1)) as string);
    }
  }
  return names;
}

/** Slice one SPEC section between two headlines (fails loud when absent). */
function specSection(headline: string, nextHeadline: string): string {
  const start = SPEC.indexOf(headline);
  const end = SPEC.indexOf(nextHeadline);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`SPEC section not found: ${headline}`);
  }
  return SPEC.slice(start, end);
}

const SEC3 = specSection('## 3. Message types', '## 4. Message payloads');

/** §3 table rows: `| CONSTANT | \`syncplay_name\` | direction |`. */
function spec3WireNames(): string[] {
  return [...SEC3.matchAll(/^\|\s*[A-Z][A-Z0-9_]*\s*\|\s*`(syncplay_[a-z0-9_]+)`/gm)].map(
    (m) => m[1] as string,
  );
}

/** §3 rows as name->value pairs (the CONSTANT column carries no TYPE_). */
function spec3Pairs(): PhpConstPair[] {
  return [
    ...SEC3.matchAll(/^\|\s*([A-Z][A-Z0-9_]*)\s*\|\s*`(syncplay_[a-z0-9_]+)`/gm),
  ].map((m) => ({ name: m[1] as string, value: m[2] as string }));
}

/**
 * The dialect's two consts whose names are not value-derivable from the
 * catalog (`TYPE_CHAT_MESSAGE` -> `CHAT`, `TYPE_CHAT_TYPING` -> `TYPING`);
 * every other dialect const maps by stripping `TYPE_`.
 */
const DIALECT_NAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  TYPE_CHAT_MESSAGE: 'CHAT',
  TYPE_CHAT_TYPING: 'TYPING',
};

function catalogNameForPhpConst(name: string): string {
  return DIALECT_NAME_EXCEPTIONS[name] ?? name.slice('TYPE_'.length);
}

/**
 * Compare two name->value transcriptions positionally by NAME: duplicate
 * names, divergent name sets (either direction) and any crossed value each
 * fail with a message naming the offender. Set-only equality is blind to a
 * value swap between two names; this is not.
 */
function expectPairsEqual(
  actual: readonly PhpConstPair[],
  expected: readonly PhpConstPair[],
  what: string,
): void {
  const have = new Map<string, string>();
  for (const pair of actual) {
    expect(have.has(pair.name), `${what}: duplicate name ${pair.name}`).toBe(false);
    have.set(pair.name, pair.value);
  }
  const want = new Map<string, string>();
  for (const pair of expected) {
    expect(want.has(pair.name), `${what}: duplicate expected name ${pair.name}`).toBe(false);
    want.set(pair.name, pair.value);
  }
  expect([...have.keys()].sort(), `${what}: name sets diverge`).toEqual([...want.keys()].sort());
  for (const [name, value] of want) {
    expect(have.get(name), `${what}: ${name} carries a crossed value`).toBe(value);
  }
}

const server = locateCheckout('phlix-server', 'PHLIX_SERVER_REPO');
const hub = locateCheckout('phlix-hub', 'PHLIX_HUB_REPO');
const shared = locateCheckout('phlix-shared', 'PHLIX_SHARED_REPO');

describe('leg 1 — SPEC §3 table and the src catalog are one set (always on)', () => {
  it('every §3 wire string and every catalog member agree, both directions', () => {
    const rows = spec3WireNames();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length, '§3 table carries duplicate wire strings').toBe(
      new Set(rows).size,
    );
    expect(sortedUnique(rows)).toEqual(CATALOG_SORTED);
  });

  it('the §3 heading count tracks the catalog length (no stale "(all 19)")', () => {
    expect(SEC3).toContain(`Message types (all ${CATALOG.length})`);
  });

  it('§3 name->value pairs equal SYNCPLAY_MESSAGE_TYPES (a crossed value convicts)', () => {
    const tsPairs: PhpConstPair[] = Object.entries(SYNCPLAY_MESSAGE_TYPES).map(
      ([name, value]) => ({ name, value: value as string }),
    );
    expectPairsEqual(spec3Pairs(), tsPairs, 'SPEC §3 <-> src/messages.ts');
  });
});

describe('leg 2 — phlix-server Messages::TYPE_* transcription (shape)', () => {
  const serverRoot = server.root;
  const visible = serverRoot !== null;

  it.runIf(visible)('TYPE_* surface is non-empty and duplicate-free in either form', () => {
    if (serverRoot === null) throw new Error('unreachable — leg visibility flipped');
    const text = readTarget(server, 'src/Session/SyncPlay/Messages.php');
    const names = [...aliasTypePairs(text).map((a) => a.name), ...literalTypePairs(text).map((p) => p.name)];
    expect(
      names.length,
      'parser found zero TYPE_* constants in a visible checkout — the transcription ' +
        'moved or was deleted (re-aimed 2026-11-27, S-syncplay-13, for the post-3b878403 ' +
        'alias era: identity aliases onto SyncPlayDialect::TYPE_*, legacy literals still parsed)',
    ).toBeGreaterThan(0);
    expect(names.length, 'duplicate TYPE_* constant names').toBe(new Set(names).size);
  });

  it.runIf(visible)('every server alias is an IDENTITY onto the shared dialect', () => {
    if (serverRoot === null) throw new Error('unreachable — leg visibility flipped');
    const text = readTarget(server, 'src/Session/SyncPlay/Messages.php');
    for (const alias of aliasTypePairs(text)) {
      expect(
        alias.target,
        `crossed alias: ${alias.name} = SyncPlayDialect::${alias.target} (not identity)`,
      ).toBe(alias.name);
    }
  });

  it.runIf(visible)('legacy literal-form server values (if any) are catalog members', () => {
    if (serverRoot === null) throw new Error('unreachable — leg visibility flipped');
    const text = readTarget(server, 'src/Session/SyncPlay/Messages.php');
    for (const pair of literalTypePairs(text)) {
      expect(CATALOG_SORTED, `${pair.name} carries a foreign wire value`).toContain(pair.value);
    }
  });

  it.skipIf(visible)(
    'SKIPPED: no phlix-server checkout (PHLIX_SERVER_REPO unset, no ../phlix-server) — PHLIX_DIALECT_GUARD_STRICT=1 makes this red',
    () => {
      expect(server.root).toBeNull();
    },
  );
});

describe('leg 2b — phlix-shared SyncPlayDialect is the SSOT the dialect rides', () => {
  const sharedRoot = shared.root;
  const visible = sharedRoot !== null;

  it.runIf(visible)('dialect TYPE_* values equal the catalog, both directions', () => {
    if (sharedRoot === null) throw new Error('unreachable — leg visibility flipped');
    const pairs = literalTypePairs(readTarget(shared, 'src/Relay/SyncPlayDialect.php'));
    expect(pairs.length, 'parser found zero literal TYPE_* consts in a visible dialect').toBeGreaterThan(0);
    expect(pairs.length, 'duplicate dialect TYPE_* names').toBe(new Set(pairs.map((p) => p.name)).size);
    const values = pairs.map((p) => p.value);
    expect(values.length, 'duplicate dialect wire values').toBe(new Set(values).size);
    expect(sortedUnique(values)).toEqual(CATALOG_SORTED);
  });

  it.runIf(visible)('dialect name->value pairs equal §3 (chat/typing crossing convicts by name)', () => {
    if (sharedRoot === null) throw new Error('unreachable — leg visibility flipped');
    const pairs = literalTypePairs(readTarget(shared, 'src/Relay/SyncPlayDialect.php')).map((p) => ({
      name: catalogNameForPhpConst(p.name),
      value: p.value,
    }));
    expectPairsEqual(pairs, spec3Pairs(), 'phlix-shared SyncPlayDialect <-> SPEC §3');
  });

  it.skipIf(visible)(
    'SKIPPED: no phlix-shared checkout (PHLIX_SHARED_REPO unset, no ../phlix-shared) — PHLIX_DIALECT_GUARD_STRICT=1 makes this red',
    () => {
      expect(shared.root).toBeNull();
    },
  );
});

describe('leg 2c — server aliases resolve through the dialect to the catalog', () => {
  const visible = server.root !== null && shared.root !== null;

  it.runIf(visible)('server alias names == dialect names, and every target is declared', () => {
    const text = readTarget(server, 'src/Session/SyncPlay/Messages.php');
    const dialect = literalTypePairs(readTarget(shared, 'src/Relay/SyncPlayDialect.php'));
    const dialectNames = dialect.map((p) => p.name);
    const aliases = aliasTypePairs(text);
    expect(
      sortedUnique(aliases.map((a) => a.name)),
      'server alias names vs dialect const names (literal-form server consts ride leg 2)',
    ).toEqual(sortedUnique(dialectNames));
    for (const alias of aliases) {
      expect(
        dialectNames,
        `undeclared dialect target: ${alias.name} = SyncPlayDialect::${alias.target}`,
      ).toContain(alias.target);
    }
  });

  it.runIf(visible)('resolved server values equal the catalog, both directions, BY NAME', () => {
    const dialectValue = new Map(literalTypePairs(readTarget(shared, 'src/Relay/SyncPlayDialect.php')).map((p) => [p.name, p.value]));
    const text = readTarget(server, 'src/Session/SyncPlay/Messages.php');
    const resolved: PhpConstPair[] = [
      ...aliasTypePairs(text).map((a) => {
        const value = dialectValue.get(a.target);
        if (value === undefined) {
          throw new Error(`unresolvable alias ${a.name} -> ${a.target}`);
        }
        return { name: a.name, value };
      }),
      ...literalTypePairs(text),
    ].map((p) => ({ name: catalogNameForPhpConst(p.name), value: p.value }));
    expect(sortedUnique(resolved.map((p) => p.value))).toEqual(CATALOG_SORTED);
    expectPairsEqual(resolved, spec3Pairs(), 'phlix-server resolved values <-> SPEC §3');
  });

  it.skipIf(visible)(
    'SKIPPED: needs BOTH phlix-server and phlix-shared checkouts visible (siblings or env paths) — PHLIX_DIALECT_GUARD_STRICT=1 makes this red',
    () => {
      expect(server.root === null || shared.root === null).toBe(true);
    },
  );
});

describe('leg 3 — phlix-hub src/SyncPlay wire literals', () => {
  const hubRoot = hub.root;
  const visible = hubRoot !== null;

  it.runIf(visible)('quoted syncplay_* literals equal the catalog, both directions', () => {
    if (hubRoot === null) throw new Error('unreachable — leg visibility flipped');
    const names = hubWireLiterals(hubRoot);
    expect(names.length, 'zero quoted wire literals under a visible src/SyncPlay').toBeGreaterThan(0);
    expect(sortedUnique(names)).toEqual(CATALOG_SORTED);
  });

  it.skipIf(visible)(
    'SKIPPED: no phlix-hub checkout (PHLIX_HUB_REPO unset, no ../phlix-hub) — PHLIX_DIALECT_GUARD_STRICT=1 makes this red',
    () => {
      expect(hub.root).toBeNull();
    },
  );
});

/**
 * Leg 5 — the SPEC §5 worked-example vectors (`S-syncplay-13`) driven against
 * the live TimeSync. The table is the docs<->math seam: §5 states the
 * estimator (rtt = t4 - t1 - (t3 - t2); one_way = trunc(rtt / 2); theta =
 * t2 - t1 - one_way; offset = round of the weight-1/max(1,rtt) mean over the
 * recent OFFSET_SAMPLE_COUNT samples, real divisor; latency = trunc of the
 * mean of rtt/2; stable when >= OFFSET_SAMPLE_COUNT samples and population
 * variance < 50) — this leg makes every cell mechanically checkable. The
 * loader THROWS on a missing header, a drifted header, a ragged row, a
 * non-numeric cell or an arithmetically inconsistent row: a deleted or
 * mangled table can never green-out vacuously.
 */
const SEC5 = specSection('## 5. NTP time synchronization', '## 6. Member-event handling');

const VECTOR_HEADER = [
  'vector', 'seq', 't1', 't2', 't3', 't4', 'accepted',
  'rtt', 'one_way', 'theta', 'offset', 'latency', 'stable',
];

interface SpecVectorRow {
  vector: string;
  seq: string;
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  accepted: boolean;
  rtt: number | null;
  oneWay: number | null;
  theta: number | null;
  offset: number | null;
  latency: number | null;
  stable: boolean | null;
}

function rowCells(line: string): string[] {
  return line.split('|').map((cell) => cell.trim()).slice(1, -1);
}

function vectorIntCell(cell: string, label: string, allowDash: boolean): number | null {
  if (allowDash && cell === '-') return null;
  if (!/^-?\d+$/.test(cell)) {
    throw new Error(`§5 vectors: ${label} cell is not an integer or '-': "${cell}"`);
  }
  return parseInt(cell, 10);
}

function yesNoCell(cell: string, label: string): boolean {
  if (cell !== 'yes' && cell !== 'no') {
    throw new Error(`§5 vectors: ${label} cell is not yes/no: "${cell}"`);
  }
  return cell === 'yes';
}

function sec5VectorRows(): SpecVectorRow[] {
  const lines = SEC5.split('\n');
  const headerIndex = lines.findIndex((line) => line.startsWith('| vector |'));
  if (headerIndex < 0) {
    throw new Error(
      'SPEC §5 worked-example vectors table not found — leg 5 refuses to ' +
        'compare against an absent table (re-adding it is the cure)',
    );
  }
  const headerLine = lines[headerIndex];
  if (headerLine === undefined) throw new Error('unreachable: findIndex lied');
  expect(rowCells(headerLine), 'SPEC §5 vectors header labels drifted').toEqual(VECTOR_HEADER);

  const rows: SpecVectorRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.startsWith('|')) break;
    const cells = rowCells(line);
    if (cells.every((cell) => /^[-:]*$/.test(cell))) continue;
    if (cells.length !== VECTOR_HEADER.length) {
      throw new Error(`§5 vectors row has ${cells.length} cells, not ${VECTOR_HEADER.length}: ${line}`);
    }
    const accepted = yesNoCell(cells[6] as string, 'accepted');
    rows.push({
      vector: cells[0] as string,
      seq: cells[1] as string,
      t1: vectorIntCell(cells[2] as string, 't1', false) as number,
      t2: vectorIntCell(cells[3] as string, 't2', false) as number,
      t3: vectorIntCell(cells[4] as string, 't3', false) as number,
      t4: vectorIntCell(cells[5] as string, 't4', false) as number,
      accepted,
      rtt: vectorIntCell(cells[7] as string, 'rtt', true),
      oneWay: vectorIntCell(cells[8] as string, 'one_way', true),
      theta: vectorIntCell(cells[9] as string, 'theta', true),
      offset: vectorIntCell(cells[10] as string, 'offset', true),
      latency: vectorIntCell(cells[11] as string, 'latency', true),
      stable: cells[12] === '-' ? null : yesNoCell(cells[12] as string, 'stable'),
    });
  }
  expect(rows.length, 'SPEC §5 vectors table is too thin to be meaningful').toBeGreaterThanOrEqual(12);
  return rows;
}

function isStandaloneRow(row: SpecVectorRow): boolean {
  return row.seq === '-';
}

function vectorGroups(rows: readonly SpecVectorRow[]): Map<string, SpecVectorRow[]> {
  const groups = new Map<string, SpecVectorRow[]>();
  for (const row of rows) {
    if (isStandaloneRow(row)) continue;
    const bucket = groups.get(row.vector) ?? [];
    bucket.push(row);
    groups.set(row.vector, bucket);
  }
  return groups;
}

function expectRowArithmetic(row: SpecVectorRow, label: string): void {
  const computedRtt = row.t4 - row.t1 - (row.t3 - row.t2);
  if (!row.accepted) {
    expect(row.rtt, `${label}: rejected row must not carry an rtt` + ' cell').toBeNull();
    expect(row.oneWay, `${label}: rejected row must not carry a one_way cell`).toBeNull();
    expect(row.theta, `${label}: rejected row must not carry a theta cell`).toBeNull();
    expect(row.offset, `${label}: rejected row must not carry an offset cell`).toBeNull();
    expect(row.latency, `${label}: rejected row must not carry a latency cell`).toBeNull();
    expect(row.stable, `${label}: rejected row must be stable=no or '-'`).toBe(false);
    expect(
      computedRtt < 0 || computedRtt > MAX_ACCEPTABLE_RTT,
      `${label}: marked rejected although rtt=${computedRtt} is inside [0, ${MAX_ACCEPTABLE_RTT}]`,
    ).toBe(true);
    return;
  }
  expect(row.rtt, `${label}: rtt cell contradicts t4 - t1 - (t3 - t2)`).toBe(computedRtt);
  expect(row.oneWay, `${label}: one_way cell contradicts trunc(rtt / 2)`).toBe(
    Math.trunc((computedRtt as number) / 2),
  );
  expect(row.theta, `${label}: theta cell contradicts t2 - t1 - one_way`).toBe(
    row.t2 - row.t1 - (row.oneWay as number),
  );
}

describe('leg 5 — SPEC §5 worked-example vectors vs TimeSync (always on)', () => {
  it('the vectors table is present, dense and arithmetically self-consistent', () => {
    const rows = sec5VectorRows();
    const standalone = rows.filter(isStandaloneRow);
    expect(standalone.length, '§5 vectors: too few standalone rows').toBeGreaterThanOrEqual(8);
    expect(
      standalone.filter((row) => row.accepted).length,
      '§5 vectors: too few accepted standalone rows',
    ).toBeGreaterThanOrEqual(5);
    expect(
      standalone.filter((row) => !row.accepted).length,
      '§5 vectors: too few rejected standalone rows',
    ).toBeGreaterThanOrEqual(3);

    const groups = vectorGroups(rows);
    expect(groups.size, '§5 vectors: too few aggregate windows').toBeGreaterThanOrEqual(2);
    for (const [vector, group] of groups) {
      expect(group.length, `${vector}: window too short to exercise the recent-N mean`).toBeGreaterThanOrEqual(5);
      group.forEach((row, index) => {
        expect(/^\d+$/.test(row.seq), `${vector}: seq cell must be numeric`).toBe(true);
        expectRowArithmetic(row, `${vector}#${row.seq}`);
        const last = index === group.length - 1;
        if (!row.accepted) return;
        expect(row.theta, `${vector}#${row.seq}: accepted window row must carry theta`).not.toBeNull();
        if (last) {
          expect(row.offset, `${vector}: last row must assert offset`).not.toBeNull();
          expect(row.latency, `${vector}: last row must assert latency`).not.toBeNull();
          expect(row.stable, `${vector}: last row must assert stable`).not.toBeNull();
        } else {
          expect(row.offset, `${vector}#${row.seq}: mid-window offset must be '-'`).toBeNull();
          expect(row.latency, `${vector}#${row.seq}: mid-window latency must be '-'`).toBeNull();
          expect(row.stable, `${vector}#${row.seq}: mid-window stable must be '-'`).toBeNull();
        }
      });
    }
    for (const row of standalone.filter((candidate) => candidate.accepted)) {
      expect(row.offset, 'accepted standalone offset must equal theta').toBe(row.theta);
      expect(row.latency, 'accepted standalone latency must equal one_way').toBe(row.oneWay);
      expect(row.stable, 'a single sample can never be stable').toBe(false);
    }
  });

  it('TimeSync reproduces every standalone §5 vector (sign, trunc, bounds)', () => {
    for (const row of sec5VectorRows().filter(isStandaloneRow)) {
      const sync = new TimeSync(() => 0);
      const label = `t1=${row.t1} t2=${row.t2} t3=${row.t3} t4=${row.t4}`;
      expect(sync.addSample(row.t1, row.t2, row.t3, row.t4), `${label}: acceptance`).toBe(row.accepted);
      if (!row.accepted) {
        expect(sync.getSampleCount(), `${label}: rejected sample never enters the buffer`).toBe(0);
        expect(sync.getOffset(), `${label}: empty buffer offset`).toBe(0);
        expect(sync.getLatency(), `${label}: empty buffer latency`).toBe(0);
        continue;
      }
      expect(sync.getSampleCount(), `${label}: sample count`).toBe(1);
      expect(sync.getOffset(), `${label}: single-sample offset must equal theta`).toBe(row.offset);
      expect(sync.getLatency(), `${label}: single-sample latency must equal one_way`).toBe(row.latency);
      expect(sync.isStable(), `${label}: single sample stable`).toBe(row.stable);
    }
  });

  it('TimeSync reproduces every §5 aggregate window (real divisor, recent slice, strict boundary)', () => {
    for (const [vector, group] of vectorGroups(sec5VectorRows())) {
      const sync = new TimeSync(() => 0);
      const acceptedCount = group.filter((row) => row.accepted).length;
      for (const row of group) {
        expect(sync.addSample(row.t1, row.t2, row.t3, row.t4), `${vector}: acceptance mid-window`).toBe(
          row.accepted,
        );
      }
      expect(sync.getSampleCount(), `${vector}: buffer holds every accepted sample up to 2*N`).toBe(
        acceptedCount,
      );
      expect(sync.getSampleCount(), `${vector}: buffer cap`).toBeLessThanOrEqual(2 * OFFSET_SAMPLE_COUNT);
      const last = group[group.length - 1] as SpecVectorRow;
      expect(sync.getOffset(), `${vector}: aggregate offset must equal the asserted §5 cell`).toBe(
        last.offset,
      );
      expect(sync.getLatency(), `${vector}: aggregate latency must equal the asserted §5 cell`).toBe(
        last.latency,
      );
      expect(sync.isStable(), `${vector}: stability must equal the asserted §5 cell`).toBe(last.stable);
    }
  });
});

describe('leg 4 — parser vacuity guards (always on)', () => {
  it('the literal parser takes public const values only — prose cannot leak in', () => {
    const fixture = [
      '<?php',
      "final class Messages {",
      "    /** docblock mention: 'syncplay_in_docblock' must not count */",
      "    public const TYPE_GROUP_CREATE = 'syncplay_group_create';",
      "    public const TYPE_ERROR = 'syncplay_error'; // trailing 'syncplay_in_line_comment'",
      "    private const TYPE_HIDDEN = 'syncplay_private';",
      '}',
    ].join('\n');
    expect(literalTypePairs(fixture).map((p) => p.value)).toEqual(['syncplay_group_create', 'syncplay_error']);
  });

  it('the literal parser takes double-quoted const values too — invented consts cannot evade', () => {
    // w20L6 review Minor: the parser was single-quote-only, so a server const
    // invented as `public const TYPE_X = "syncplay_x";` was INVISIBLE to leg
    // 2 — an added constant with no catalog twin then passed the both-
    // direction set equality it exists to enforce. Double-quoted prose is
    // still no leak vector: the regex anchors on the const declaration.
    const fixture = [
      '<?php',
      "final class Messages {",
      '    /** docblock "syncplay_in_docblock" is prose */',
      '    public const TYPE_GROUP_CREATE = "syncplay_group_create";',
      "    public const TYPE_ERROR = 'syncplay_error';",
      '    public const TYPE_UNDELETE = "syncplay_undelete"; // trailing "syncplay_in_line_comment" is prose',
      '}',
    ].join('\n');
    expect(literalTypePairs(fixture).map((p) => p.value)).toEqual([
      'syncplay_group_create',
      'syncplay_error',
      'syncplay_undelete',
    ]);
  });

  it('the hub parser strips comments and takes both quote styles', () => {
    const fixture = [
      '<?php',
      "/** 'syncplay_in_block_comment' is prose */",
      "['type' => 'syncplay_alpha'], // 'syncplay_in_line_comment' is prose",
      '$reply = "syncplay_beta";',
    ].join('\n');
    const stripped = stripPhpComments(fixture);
    const names = [
      ...stripped.matchAll(/'syncplay_[a-z0-9_]+'|"(syncplay_[a-z0-9_]+)"/g),
    ].map((m) => (m[1] ?? m[0].slice(1, -1)) as string);
    expect(names).toEqual(['syncplay_alpha', 'syncplay_beta']);
  });

  it('the alias parser sees a crossed alias but never docblock prose (real-file hazard)', () => {
    // The phlix-shared dialect docblock carries an alias-form EXAMPLE line
    // verbatim; the line anchor is load-bearing. The TYPE_ERROR = TYPE_INFO
    // pair below is exactly the crossing leg 2 exists to convict, and the
    // parser must SEE it while ignoring both comment forms.
    const fixture = [
      '<?php',
      '/**',
      ' * public const TYPE_CHAT_MESSAGE = SyncPlayDialect::TYPE_CHAT_MESSAGE;',
      ' */',
      '    public const TYPE_ERROR = SyncPlayDialect::TYPE_INFO; // SyncPlayDialect::TYPE_COMMENTED',
      '    private const TYPE_PRIVATE = SyncPlayDialect::TYPE_PRIVATE;',
      '}',
    ].join('\n');
    expect(aliasTypePairs(fixture)).toEqual([{ name: 'TYPE_ERROR', target: 'TYPE_INFO' }]);
  });

  it('a dropped terminator hides the const from the parse — the count legs convict', () => {
    const fixture = [
      '    public const TYPE_ERROR = SyncPlayDialect::TYPE_ERROR',
      "    public const TYPE_INFO = 'syncplay_info'",
    ].join('\n');
    expect(aliasTypePairs(fixture)).toEqual([]);
    expect(literalTypePairs(fixture)).toEqual([]);
    // This is NOT green-by-erasure: legs 2/2b/2c compare PARSED surfaces
    // against the catalog, so a transcription losing its semicolons drops the
    // pair count (18 != 19) and fails the zero/dup/pair checks — the same
    // reason the fixtures above demand loud failure over silent agreement.
    expect(literalTypePairs("    public const TYPE_INFO = 'syncplay_info';").length).toBe(1);
  });

  it('the dialect parser excludes WIRE_PREFIX, self:: lists and docblock examples', () => {
    const fixture = [
      '<?php',
      '/**',
      ' * public const TYPE_CHAT_MESSAGE = SyncPlayDialect::TYPE_CHAT_MESSAGE;',
      ' */',
      "    public const WIRE_PREFIX = 'syncplay_';",
      '    private const TYPES = [self::TYPE_ERROR, self::TYPE_INFO];',
      "    public const TYPE_ERROR = 'syncplay_error';",
      '    public const TYPE_INFO = "syncplay_info";',
      '}',
    ].join('\n');
    expect(literalTypePairs(fixture).map((p) => p.value)).toEqual(['syncplay_error', 'syncplay_info']);
  });
});

describe('strict mode — one-machine estate sweeps demand every leg', () => {
  it.runIf(STRICT)('all cross-repo checkouts are visible under PHLIX_DIALECT_GUARD_STRICT=1', () => {
    const missing = [server, hub, shared]
      .filter((checkout) => checkout.root === null)
      .map((checkout) => `${checkout.leg} via ${checkout.envVar} or sibling`);
    expect(missing, 'strict mode: ' + missing.join('; ')).toEqual([]);
  });
});
