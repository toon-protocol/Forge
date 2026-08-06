import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseManifest } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import { serializeManifest, stamp } from './stamp.js';

const tempDirs: string[] = [];

async function tempTargetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-stamp-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function allFilesUnder(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await allFilesUnder(join(dir, entry.name), relPath)));
    } else {
      files.push(relPath);
    }
  }
  return files.sort();
}

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

describe('stamp — --blank (node-pnpm)', () => {
  it('stamps factory.toml, workflows, Dockerfile, .sandcastle/, scripts/, and verify/ into the target dir', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'node-pnpm', node: '22' }, targetDir);

    const result = await stamp(plan);

    expect(result.manifest.factory).toEqual(plan.factory);
    expect(result.manifest.environment).toEqual(plan.environment);
    expect(result.manifest.loop.models).toEqual({
      planner: 'claude-opus-4-8',
      merger: 'claude-opus-4-8',
      implementer: 'claude-sonnet-5',
      reviewer: 'claude-sonnet-5',
    });
    expect(result.manifest.loop.contextCeiling).toBe(0.6);
    expect(result.manifest.oracleTiers.map((t) => t.id)).toEqual([
      't0-lint',
      't1-typecheck',
      't2-test',
      't3-build',
    ]);
    expect(result.manifest.privileged).toBeUndefined();

    const onDisk = await allFilesUnder(targetDir);
    expect(onDisk).toEqual(result.files);
    expect(onDisk).toContain('factory.toml');
    expect(onDisk).toContain('.github/workflows/gate.yml');
    expect(onDisk).toContain('.github/workflows/agent-implement.yml');
    expect(onDisk).toContain('.github/workflows/agent-review.yml');
    expect(onDisk).toContain('.github/workflows/nightly.yml');
    expect(onDisk).toContain('.github/workflows/golden-regen.yml');
    expect(onDisk).toContain('.sandcastle/Dockerfile');
    expect(onDisk).toContain('.sandcastle/plan-prompt.md');
    expect(onDisk).toContain('.sandcastle/implement-prompt.md');
    expect(onDisk).toContain('.sandcastle/review-prompt.md');
    expect(onDisk).toContain('.sandcastle/CODING_STANDARDS.md');
    expect(onDisk).toContain('.sandcastle/.env.example');
    expect(onDisk).toContain('.sandcastle/.gitignore');
    expect(onDisk).toContain('scripts/check-rule4.mjs');
    expect(onDisk).toContain('verify/README.md');
    // Proven node-pnpm commands run directly — no verify/ stub needed.
    expect(onDisk).not.toContain('verify/t0-lint.sh');
    // Blank stamps no archetype opinions.
    expect(onDisk).not.toContain('DOCTRINE.md');
  });

  it('emits a factory.toml that forge-core itself accepts as valid', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'node-pnpm', node: '22' }, targetDir);
    await stamp(plan);

    const written = await readFile(join(targetDir, 'factory.toml'), 'utf-8');
    const reparsed = parseManifest(written);
    expect(reparsed.factory.name).toBe('widget');
    expect(reparsed.oracleTiers).toHaveLength(4);
  });

  it('substitutes stamp-time tokens without leaking sandcastle runtime tokens', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'node-pnpm', node: '22' }, targetDir);
    await stamp(plan);

    const implement = await readFile(
      join(targetDir, '.sandcastle/implement-prompt.md'),
      'utf-8'
    );
    expect(implement).not.toContain('__GATE_COMMANDS__');
    expect(implement).not.toContain('__CONTEXT_CEILING_PCT__');
    expect(implement).toContain('- t0-lint: `pnpm lint`');
    expect(implement).toContain('- t3-build: `pnpm build`');
    expect(implement).toContain('~60%');
    // sandcastle's own runtime tokens resolve later via promptArgs — must survive stamping untouched.
    expect(implement).toContain('{{TASK_ID}}');
    expect(implement).toContain('{{BRANCH}}');
  });

  it('re-stamping the same plan is idempotent (byte-identical output)', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'node-pnpm', node: '22' }, targetDir);

    const first = await stamp(plan);
    const firstContents = new Map(
      await Promise.all(
        first.files.map(
          async (f) => [f, await readFile(join(targetDir, f), 'utf-8')] as const
        )
      )
    );

    const second = await stamp(plan);
    expect(second.files).toEqual(first.files);
    for (const f of second.files) {
      expect(await readFile(join(targetDir, f), 'utf-8')).toBe(
        firstContents.get(f)
      );
    }
  });
});

describe('stamp — --blank (docs, non-node)', () => {
  it('wires its one default tier through a verify/ stub since no prose linter is proven yet', async () => {
    const targetDir = await tempTargetDir();
    const plan = blankPlan({ kind: 'docs' }, targetDir);

    const result = await stamp(plan);

    expect(result.manifest.environment.node).toBeUndefined();
    expect(result.manifest.oracleTiers).toEqual([
      expect.objectContaining({
        id: 't0-prose-check',
        run: 'bash verify/t0-prose-check.sh',
      }),
    ]);
    expect(result.files).toContain('verify/t0-prose-check.sh');
    expect(result.files).toContain('.sandcastle/Dockerfile');

    const dockerfile = await readFile(
      join(targetDir, '.sandcastle/Dockerfile'),
      'utf-8'
    );
    expect(dockerfile).not.toMatch(/FROM node:/);

    const stub = await stat(join(targetDir, 'verify/t0-prose-check.sh'));
    expect(stub.mode & 0o111).not.toBe(0); // executable
  });
});

describe('stamp — archetype branch (game)', () => {
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

  it("applies the archetype's pinned oracle ladder, rewiring the protected tier to a verify/ stub", async () => {
    const targetDir = await tempTargetDir();
    const result = await stamp(gamePlan(targetDir));

    expect(result.manifest.oracleTiers.map((t) => t.id)).toEqual([
      't0-fmt-lint',
      't1-build',
      't2-unit-test',
      't3-sim-replay-golden',
      't4-visual-parity',
    ]);
    // Non-protected tiers keep the archetype's real, concrete command.
    const unitTest = result.manifest.oracleTiers.find(
      (t) => t.id === 't2-unit-test'
    );
    expect(unitTest?.run).toBe('cargo test --workspace');

    // Protected tiers are rewired to a verify/ stub — the pilot's real
    // golden-check binary isn't something the stamping engine can fabricate.
    const goldenTier = result.manifest.oracleTiers.find(
      (t) => t.id === 't3-sim-replay-golden'
    );
    expect(goldenTier?.protected).toBe(true);
    expect(goldenTier?.run).toBe('bash verify/t3-sim-replay-golden.sh');
    expect(result.files).toContain('verify/t3-sim-replay-golden.sh');

    expect(result.manifest.privileged).toEqual({
      environment: 'oracle-owners',
      operations: ['golden-regen'],
    });
    expect(result.files).toContain('DOCTRINE.md');

    const doctrine = await readFile(join(targetDir, 'DOCTRINE.md'), 'utf-8');
    expect(doctrine.toLowerCase()).toContain('mint-after-pilot');
  });

  it('produces a factory.toml that round-trips through forge-core validation', async () => {
    const targetDir = await tempTargetDir();
    await stamp(gamePlan(targetDir));
    const written = await readFile(join(targetDir, 'factory.toml'), 'utf-8');
    const reparsed = parseManifest(written);
    expect(reparsed.factory.archetype).toBe('game');
    expect(reparsed.privileged?.operations).toContain('golden-regen');
  });
});

describe('stamp — archetype branch (service, Forge#49)', () => {
  function servicePlan(targetDir: string): StampPlan {
    return {
      factory: {
        name: 'relay',
        repo: 'toon-protocol/relay',
        archetype: 'service',
      },
      environment: {
        kind: 'node-pnpm',
        node: '22',
        lockfile: 'pnpm-lock.yaml',
        devbox: true,
      },
      targetDir,
    };
  }

  it("applies the archetype's pinned oracle ladder verbatim (no protected tiers to rewire)", async () => {
    const targetDir = await tempTargetDir();
    const result = await stamp(servicePlan(targetDir));

    expect(result.manifest.oracleTiers.map((t) => t.id)).toEqual([
      't0-lint',
      't1-typecheck',
      't2-test',
      't3-build',
      't4-devbox-validate',
    ]);
    // No protected tiers in the service ladder — every tier keeps its real command.
    expect(result.manifest.oracleTiers.every((t) => !t.protected)).toBe(true);
    const devboxTier = result.manifest.oracleTiers.find(
      (t) => t.id === 't4-devbox-validate'
    );
    expect(devboxTier?.run).toContain('devbox run');
    expect(result.manifest.privileged).toBeUndefined();
    expect(result.files).toContain('DOCTRINE.md');

    const doctrine = await readFile(join(targetDir, 'DOCTRINE.md'), 'utf-8');
    expect(doctrine.toLowerCase()).toContain('mint-after-pilot');

    const dockerfile = await readFile(
      join(targetDir, '.sandcastle/Dockerfile'),
      'utf-8'
    );
    expect(dockerfile).toMatch(/FROM node:/);
  });

  it('produces a factory.toml that round-trips through forge-core validation', async () => {
    const targetDir = await tempTargetDir();
    await stamp(servicePlan(targetDir));
    const written = await readFile(join(targetDir, 'factory.toml'), 'utf-8');
    const reparsed = parseManifest(written);
    expect(reparsed.factory.archetype).toBe('service');
    expect(reparsed.environment.devbox).toBe(true);
    expect(reparsed.privileged).toBeUndefined();
  });
});

describe('serializeManifest', () => {
  it('round-trips a manifest through forge-core parseManifest', () => {
    const text = serializeManifest({
      factory: { name: 'x', repo: 'toon-protocol/x', archetype: 'blank' },
      environment: {
        kind: 'node-pnpm',
        node: '22',
        lockfile: 'pnpm-lock.yaml',
        devbox: false,
      },
      loop: {
        template: 'parallel-planner-with-review',
        innerGates: ['t0-lint'],
        contextCeiling: 0.6,
        models: {
          planner: 'claude-opus-4-8',
          merger: 'claude-opus-4-8',
          implementer: 'claude-sonnet-5',
          reviewer: 'claude-sonnet-5',
        },
      },
      oracleTiers: [
        {
          id: 't0-lint',
          run: 'pnpm lint',
          on: ['**/*.ts'],
          surfaces: ['inner', 'pr'],
          cost: 'cheap',
          protected: false,
        },
      ],
    });

    expect(parseManifest(text).factory.name).toBe('x');
  });
});
