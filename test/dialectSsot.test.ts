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
 *     directions, and the section heading's count tracks the catalog length —
 *     the repo's own docs<->code seam, previously pinned row-by-row
 *     (specDocLaw) but never as a set.
 *  2. (phlix-server checkout visible) every `TYPE_*` const value in
 *     `src/Session/SyncPlay/Messages.php` == the catalog, both directions.
 *     The parser anchors on the const declaration, so prose and docblock
 *     mentions can never leak into the compared set.
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
 *     vacuously. Legs 2/3 additionally red on a zero-capture result against
 *     a visible checkout — a transcription that MOVES is a broken guard, not
 *     a missing one.
 *
 * Checkout discovery: `PHLIX_SERVER_REPO` / `PHLIX_HUB_REPO` (absolute paths;
 * a set-but-bad path throws at collection — an explicit request is never
 * silently downgraded to a skip), else the sibling directories
 * `../phlix-server` / `../phlix-hub` of this repo (estate layout). When a leg
 * is invisible its comparison test SKIPS with the reason in the test name
 * (visible in the run summary), never silently passes; repo CI runs
 * single-repo checkouts and therefore exercises the skip arms. Setting
 * `PHLIX_DIALECT_GUARD_STRICT=1` turns an invisible checkout RED — the estate
 * cross-repo sweep flips that from one machine to prove all legs at once.
 *
 * This guard lands GREEN: it adds no new wire law, it mechanizes the equality
 * the audit already proved, verified here at sibling tips phlix-server
 * `c904aa4d3b3dff1dffa7cb4486b3e7511301d3dd` and phlix-hub
 * `8913ae11662810b3ce41f08ea0102e3864d641a4` (window 2026-11-07). Its teeth
 * were proven by executed mutation probes instead: renaming one server const,
 * one hub literal, one SPEC row, or one src entry each reddens exactly its
 * leg — and the vacuity fixtures red at any parser-shape regression.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_MESSAGE_TYPES } from '../src/messages';

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

/** Server values: anchored on the const declaration — prose cannot leak in. */
function serverTypeValues(text: string): string[] {
  return [
    ...text.matchAll(/public const TYPE_[A-Z][A-Z0-9_]*\s*=\s*'(syncplay_[a-z0-9_]+)'/g),
  ].map((m) => m[1] as string);
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

const server = locateCheckout('phlix-server', 'PHLIX_SERVER_REPO');
const hub = locateCheckout('phlix-hub', 'PHLIX_HUB_REPO');

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
});

describe('leg 2 — phlix-server Messages::TYPE_* constants', () => {
  const serverRoot = server.root;
  const visible = serverRoot !== null;

  it.runIf(visible)('TYPE_* values equal the catalog, both directions', () => {
    if (serverRoot === null) throw new Error('unreachable — leg visibility flipped');
    const names = serverTypeValues(
      readTarget(server, 'src/Session/SyncPlay/Messages.php'),
    );
    expect(names.length, 'parser found zero TYPE_* constants in a visible checkout').toBeGreaterThan(0);
    expect(names.length, 'duplicate TYPE_* wire values').toBe(new Set(names).size);
    expect(sortedUnique(names)).toEqual(CATALOG_SORTED);
  });

  it.skipIf(visible)(
    'SKIPPED: no phlix-server checkout (PHLIX_SERVER_REPO unset, no ../phlix-server) — PHLIX_DIALECT_GUARD_STRICT=1 makes this red',
    () => {
      expect(server.root).toBeNull();
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

describe('leg 4 — parser vacuity guards (always on)', () => {
  it('the server parser takes const values only — prose cannot leak in', () => {
    const fixture = [
      '<?php',
      "final class Messages {",
      "    /** docblock mention: 'syncplay_in_docblock' must not count */",
      "    public const TYPE_GROUP_CREATE = 'syncplay_group_create';",
      "    public const TYPE_ERROR = 'syncplay_error'; // trailing 'syncplay_in_line_comment'",
      "    private const TYPE_HIDDEN = 'syncplay_private';",
      '}',
    ].join('\n');
    expect(serverTypeValues(fixture)).toEqual(['syncplay_group_create', 'syncplay_error']);
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
});

describe('strict mode — one-machine estate sweeps demand every leg', () => {
  it.runIf(STRICT)('all cross-repo checkouts are visible under PHLIX_DIALECT_GUARD_STRICT=1', () => {
    const missing = [server, hub]
      .filter((checkout) => checkout.root === null)
      .map((checkout) => `${checkout.leg} via ${checkout.envVar} or sibling`);
    expect(missing, 'strict mode: ' + missing.join('; ')).toEqual([]);
  });
});
