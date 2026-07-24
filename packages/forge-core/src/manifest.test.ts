import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadManifest,
  ManifestValidationError,
  parseManifest,
} from './manifest.js';

// The worked example from FACTORY_SPEC.md §9 (Forge's own self-host manifest).
const VALID_MANIFEST = `
[factory]
name      = "forge"
repo      = "toon-protocol/Forge"
archetype = "blank"
description = "The factory manager."

[environment]
kind     = "node-pnpm"
node     = "22"
lockfile = "pnpm-lock.yaml"

[loop]
template        = "parallel-planner-with-review"
inner_gates     = ["t0-lint", "t1-typecheck"]
context_ceiling = 0.60
[loop.models]
planner = "claude-opus-4-8"
merger  = "claude-opus-4-8"
implementer = "claude-sonnet-5"
reviewer    = "claude-sonnet-5"

[[oracle.tier]]
id = "t0-lint"
run = "pnpm lint"
on = ["**/*.ts"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t1-typecheck"
run = "pnpm typecheck"
on = ["**/*.ts", "tsconfig*.json"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t2-golden-stamp"
run = "pnpm verify:golden"
on = ["templates/**", "packages/forge-core/**"]
surfaces = ["pr"]
cost = "moderate"
protected = true

[[oracle.tier]]
id = "t4-self-parity"
run = "pnpm verify:self-host"
on = []
surfaces = ["nightly", "dispatch"]
cost = "expensive"

[privileged]
environment = "oracle-owners"
operations  = ["golden-regen"]
`;

describe('parseManifest', () => {
  it('parses and validates the FACTORY_SPEC.md §9 worked example', () => {
    const manifest = parseManifest(VALID_MANIFEST);

    expect(manifest.factory).toEqual({
      name: 'forge',
      repo: 'toon-protocol/Forge',
      archetype: 'blank',
      description: 'The factory manager.',
    });
    expect(manifest.environment).toEqual({
      kind: 'node-pnpm',
      node: '22',
      lockfile: 'pnpm-lock.yaml',
      devbox: false,
    });
    expect(manifest.loop.template).toBe('parallel-planner-with-review');
    expect(manifest.loop.innerGates).toEqual(['t0-lint', 't1-typecheck']);
    expect(manifest.loop.contextCeiling).toBe(0.6);
    expect(manifest.loop.models).toEqual({
      planner: 'claude-opus-4-8',
      merger: 'claude-opus-4-8',
      implementer: 'claude-sonnet-5',
      reviewer: 'claude-sonnet-5',
    });
    expect(manifest.oracleTiers).toHaveLength(4);
    expect(manifest.oracleTiers[2]).toMatchObject({
      id: 't2-golden-stamp',
      protected: true,
    });
    expect(manifest.privileged).toEqual({
      environment: 'oracle-owners',
      operations: ['golden-regen'],
    });
  });

  it('rejects malformed TOML syntax', () => {
    expect(() => parseManifest('[factory\nname = "oops"')).toThrow(
      ManifestValidationError
    );
  });

  it('rejects an unknown top-level table (§1)', () => {
    expect(() =>
      parseManifest(`${VALID_MANIFEST}\n[bogus]\nx = 1\n`)
    ).toThrowError(/unknown key "bogus"/);
  });

  it('rejects an unknown key inside [factory] (§1)', () => {
    const src = VALID_MANIFEST.replace(
      '[factory]',
      '[factory]\nunknown_field = "nope"'
    );
    expect(() => parseManifest(src)).toThrowError(
      /\[factory\]: unknown key "unknown_field"/
    );
  });

  it('requires all four [loop.models] roles (§5.1, §8.5)', () => {
    const src = VALID_MANIFEST.replace('planner = "claude-opus-4-8"\n', '');
    expect(() => parseManifest(src)).toThrowError(
      /\[loop\.models\]\.planner: MUST be present/
    );
  });

  it('rejects a tier that lists "inner" without "pr" (§4.1, §8.6)', () => {
    const src = VALID_MANIFEST.replace(
      'surfaces = ["inner", "pr"]\ncost = "cheap"\n\n[[oracle.tier]]\nid = "t1-typecheck"',
      'surfaces = ["inner"]\ncost = "cheap"\n\n[[oracle.tier]]\nid = "t1-typecheck"'
    );
    expect(() => parseManifest(src)).toThrowError(
      /lists surface "inner" but not "pr"/
    );
  });

  it('rejects an "inner" tier whose cost is "expensive" (§4.1, §8.6)', () => {
    const src = VALID_MANIFEST.replace(
      'surfaces = ["inner", "pr"]\ncost = "cheap"\n\n[[oracle.tier]]\nid = "t1-typecheck"',
      'surfaces = ["inner", "pr"]\ncost = "expensive"\n\n[[oracle.tier]]\nid = "t1-typecheck"'
    );
    expect(() => parseManifest(src)).toThrowError(
      /inner.*but cost is "expensive"/
    );
  });

  it('rejects a protected tier when [privileged] lacks golden-regen (§6, §8.7)', () => {
    const src = VALID_MANIFEST.replace(/\[privileged\][\s\S]*$/, '');
    expect(() => parseManifest(src)).toThrowError(
      /MUST include "golden-regen"/
    );
  });

  it('rejects environment.node present for a non-node kind (§3, §8.8)', () => {
    const src = VALID_MANIFEST.replace(
      'kind     = "node-pnpm"',
      'kind     = "docs"'
    );
    expect(() => parseManifest(src)).toThrowError(
      /MUST NOT be present for non-node kinds/
    );
  });

  it('rejects environment.node absent for a node kind (§3, §8.8)', () => {
    const src = VALID_MANIFEST.replace('node     = "22"\n', '');
    expect(() => parseManifest(src)).toThrowError(
      /MUST be present for node kinds/
    );
  });

  it('rejects an inner_gates id with no matching [[oracle.tier]] (§5)', () => {
    const src = VALID_MANIFEST.replace(
      'inner_gates     = ["t0-lint", "t1-typecheck"]',
      'inner_gates     = ["t0-lint", "does-not-exist"]'
    );
    expect(() => parseManifest(src)).toThrowError(
      /"does-not-exist" is not declared/
    );
  });

  it('rejects a duplicate tier id (§4)', () => {
    const src = VALID_MANIFEST.replace('id = "t1-typecheck"', 'id = "t0-lint"');
    expect(() => parseManifest(src)).toThrowError(
      /duplicate tier id "t0-lint"/
    );
  });

  it('collects every violation, not just the first', () => {
    try {
      parseManifest(
        `${VALID_MANIFEST}\n[bogus]\nx = 1\n`.replace(
          'planner = "claude-opus-4-8"\n',
          ''
        )
      );
      expect.fail('expected ManifestValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      const validationError = err as ManifestValidationError;
      expect(validationError.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('loadManifest', () => {
  it('reads and validates a factory.toml file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-core-manifest-'));
    const path = join(dir, 'factory.toml');
    await writeFile(path, VALID_MANIFEST, 'utf-8');

    const manifest = await loadManifest(path);

    expect(manifest.factory.name).toBe('forge');
  });
});
