/**
 * packageManifest.test — pins the package.json peerDependency contract
 * (SPY-S9): @phlix/contracts is an OPTIONAL "*" peer (the runtime bundle never
 * imports it; dist/index.d.ts only re-exports types), and no `engines` field
 * is declared.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('package.json manifest', () => {
  it('declares @phlix/contracts as a "*" peerDependency', () => {
    expect(pkg.peerDependencies).toEqual({ '@phlix/contracts': '*' });
  });

  it('marks the @phlix/contracts peer optional', () => {
    expect(pkg.peerDependenciesMeta).toEqual({
      '@phlix/contracts': { optional: true },
    });
  });

  it('declares no engines field', () => {
    expect(pkg).not.toHaveProperty('engines');
  });
});
