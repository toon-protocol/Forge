import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestValidationError } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import { stamp } from './stamp.js';
import { validateStampedOutput } from './validate-stamp.js';

const tempDirs: string[] = [];

async function tempTargetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-validate-stamp-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

function blankPlan(
  overrides: Partial<StampPlan['environment']> & {
    readonly kind: StampPlan['environment']['kind'];
  },
  targetDir: string
): StampPlan {
  return {
    factory: {
      name: 'widget',
      repo: 'toon-protocol/widget',
      archetype: 'blank',
    },
    environment: { lockfile: 'pnpm-lock.yaml', devbox: false, ...overrides },
    targetDir,
  };
}

function gamePlan(targetDir: string): StampPlan {
  return {
    factory: {
      name: 'asteroids',
      repo: 'toon-protocol/asteroids',
      archetype: 'game',
    },
    environment: {
      kind: 'bevy-spacetime',
      lockfile: 'Cargo.lock',
      devbox: false,
    },
    targetDir,
  };
}

describe('validateStampedOutput — golden (stamped fixture trees)', () => {
  it('passes forge-core validation with no warnings for the --blank path', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'node-pnpm', node: '22' }, targetDir);
    await stamp(plan);

    const result = await validateStampedOutput(plan);

    expect(result.manifest.factory.name).toBe('widget');
    expect(result.warnings).toEqual([]);
  });

  it('passes forge-core validation for the archetype path, reporting protected-tier drift as a warning', async () => {
    const targetDir = await tempTargetDir();
    const plan = gamePlan(targetDir);
    await stamp(plan);

    const result = await validateStampedOutput(plan);

    expect(result.manifest.factory.archetype).toBe('game');
    // The protected tier is rewired to a verify/ stub at stamp time — that's
    // intentional drift from the archetype's pinned command, reported, not failed.
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /archetype drift: tier "t3-sim-replay-golden"\.run diverges/
      ),
    ]);
  });
});

// The FACTORY_SPEC.md §9 worked example, used as the base fixture for the
// targeted §8 failure-mode assertions below (mirrors forge-core's own
// manifest.test.ts fixture).
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

async function writeManifest(targetDir: string, source: string): Promise<void> {
  await writeFile(join(targetDir, 'factory.toml'), source, 'utf-8');
}

describe('validateStampedOutput — targeted §8 failure modes', () => {
  it('fails the command when [loop.models] is missing a role (§8.5)', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace('planner = "claude-opus-4-8"\n', '')
    );

    await expect(
      validateStampedOutput(blankPlan({ kind: 'node-pnpm' }, targetDir))
    ).rejects.toThrow(ManifestValidationError);
    await expect(
      validateStampedOutput(blankPlan({ kind: 'node-pnpm' }, targetDir))
    ).rejects.toThrow(/\[loop\.models\]\.planner: MUST be present/);
  });

  it('fails the command when a tier lists "inner" without "pr" (§8.6)', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace(
        'surfaces = ["inner", "pr"]\ncost = "cheap"\n\n[[oracle.tier]]\nid = "t1-typecheck"',
        'surfaces = ["inner"]\ncost = "cheap"\n\n[[oracle.tier]]\nid = "t1-typecheck"'
      )
    );

    await expect(
      validateStampedOutput(blankPlan({ kind: 'node-pnpm' }, targetDir))
    ).rejects.toThrow(/lists surface "inner" but not "pr"/);
  });

  it('fails the command when a protected tier exists but [privileged] lacks golden-regen (§8.7)', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace(/\[privileged\][\s\S]*$/, '')
    );

    await expect(
      validateStampedOutput(blankPlan({ kind: 'node-pnpm' }, targetDir))
    ).rejects.toThrow(/MUST include "golden-regen"/);
  });

  it('fails the command when environment.node is present for a non-node kind (§8.8)', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace('kind     = "node-pnpm"', 'kind     = "docs"')
    );

    await expect(
      validateStampedOutput(blankPlan({ kind: 'docs' }, targetDir))
    ).rejects.toThrow(/MUST NOT be present for non-node kinds/);
  });

  it('fails the command when environment.node is absent for a node kind (§8.8)', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace('node     = "22"\n', '')
    );

    await expect(
      validateStampedOutput(blankPlan({ kind: 'node-pnpm' }, targetDir))
    ).rejects.toThrow(/MUST be present for node kinds/);
  });
});

describe('validateStampedOutput — model divergence (§5.1) reported, not failed', () => {
  it('surfaces a diverging [loop.models] value as a warning instead of failing', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      VALID_MANIFEST.replace(
        'implementer = "claude-sonnet-5"',
        'implementer = "claude-opus-4-8"'
      )
    );

    const result = await validateStampedOutput(
      blankPlan({ kind: 'node-pnpm' }, targetDir)
    );

    expect(result.manifest.loop.models.implementer).toBe('claude-opus-4-8');
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /model divergence: \[loop\.models\]\.implementer = "claude-opus-4-8" diverges from org policy "claude-sonnet-5"/
      ),
    ]);
  });
});
