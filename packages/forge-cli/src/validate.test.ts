import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FactoryManifest } from '@toon-protocol/forge-core';
import { ManifestValidationError } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import { stamp } from './stamp.js';
import { buildFactoryRow, insertFactoryRow } from './register.js';
import { forgeValidate } from './validate.js';

const tempDirs: string[] = [];

async function tempTargetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-validate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function writeManifest(targetDir: string, source: string): Promise<void> {
  await writeFile(join(targetDir, 'factory.toml'), source, 'utf-8');
}

const BASE_REGISTRY = [
  '# FACTORY.md',
  '',
  '## Archetypes',
  '',
  '| Archetype | Environment    | Status |',
  '|-----------|----------------|--------|',
  '| game      | bevy-spacetime | minted |',
  '',
  '## Per-repo factory table',
  '',
  '| Repo  | Pkg mgr | Template | Gate | Status | Merged-PR proof | Notes |',
  '|-------|---------|----------|------|--------|------------------|-------|',
  '| relay | pnpm    | parallel-planner-with-review | eslint / typecheck / vitest / build | Live | — | Pilot. |',
  '',
  '## Kept workflows (not retired)',
  '',
].join('\n');

// Mirrors `WIDGET_TOML` below field-for-field, so `buildFactoryRow(WIDGET_MANIFEST)`
// is exactly the row a real `forge new`/`register.ts` registration would have
// inserted for it — the happy-path fixture for registry parity.
const WIDGET_MANIFEST: FactoryManifest = {
  factory: { name: 'widget', repo: 'toon-protocol/widget', archetype: 'blank' },
  environment: {
    kind: 'node-pnpm',
    node: '22',
    lockfile: 'pnpm-lock.yaml',
    devbox: false,
  },
  loop: {
    template: 'parallel-planner-with-review',
    innerGates: ['t0-lint', 't1-typecheck'],
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
    {
      id: 't1-typecheck',
      run: 'pnpm typecheck',
      on: ['**/*.ts'],
      surfaces: ['inner', 'pr'],
      cost: 'cheap',
      protected: false,
    },
    {
      id: 't2-test',
      run: 'pnpm test',
      on: ['**/*.ts'],
      surfaces: ['pr'],
      cost: 'moderate',
      protected: false,
    },
  ],
};

const WIDGET_TOML = `
[factory]
name      = "widget"
repo      = "toon-protocol/widget"
archetype = "blank"

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
on = ["**/*.ts"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t2-test"
run = "pnpm test"
on = ["**/*.ts"]
surfaces = ["pr"]
cost = "moderate"
`;

describe('forgeValidate — structural lint (fails fast, no registry fetch)', () => {
  it('rejects a structurally invalid manifest without ever calling fetchRegistry', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      WIDGET_TOML.replace('planner = "claude-opus-4-8"\n', '')
    );
    const fetchRegistry = vi.fn(async () => BASE_REGISTRY);

    await expect(
      forgeValidate({
        manifestPath: join(targetDir, 'factory.toml'),
        fetchRegistry,
      })
    ).rejects.toThrow(ManifestValidationError);
    expect(fetchRegistry).not.toHaveBeenCalled();
  });
});

describe('forgeValidate — registry parity, direction 1: unregistered → does not exist (§8.2)', () => {
  it('fails when no FACTORY.md row matches [factory].name', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(targetDir, WIDGET_TOML);

    await expect(
      forgeValidate({
        manifestPath: join(targetDir, 'factory.toml'),
        fetchRegistry: async () => BASE_REGISTRY,
      })
    ).rejects.toThrow(
      /"widget" has no matching row.*unregistered factories do not exist/s
    );
  });
});

describe('forgeValidate — registry parity, direction 2: pin mismatch → fail (§8.3)', () => {
  it('fails when the registered Pkg mgr pin disagrees with the manifest', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(targetDir, WIDGET_TOML);
    const wrongRow = buildFactoryRow({
      ...WIDGET_MANIFEST,
      environment: { ...WIDGET_MANIFEST.environment, kind: 'npm-workspaces' },
    });
    const registry = insertFactoryRow(BASE_REGISTRY, wrongRow);

    await expect(
      forgeValidate({
        manifestPath: join(targetDir, 'factory.toml'),
        fetchRegistry: async () => registry,
      })
    ).rejects.toThrow(
      /registered "Pkg mgr" pin is "npm workspaces", manifest resolves to "pnpm"/
    );
  });

  it('fails when the registered Gate pin disagrees with the manifest', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(targetDir, WIDGET_TOML);
    const wrongRow = buildFactoryRow({
      ...WIDGET_MANIFEST,
      oracleTiers: [
        { ...WIDGET_MANIFEST.oracleTiers[0], run: 'pnpm run lint' },
        ...WIDGET_MANIFEST.oracleTiers.slice(1),
      ],
    });
    const registry = insertFactoryRow(BASE_REGISTRY, wrongRow);

    await expect(
      forgeValidate({
        manifestPath: join(targetDir, 'factory.toml'),
        fetchRegistry: async () => registry,
      })
    ).rejects.toThrow(/registered "Gate" pin is/);
  });
});

describe('forgeValidate — archetype provenance (§2.1, §8.4)', () => {
  it('fails when a non-blank archetype is not minted in the catalog', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      WIDGET_TOML.replace('archetype = "blank"', 'archetype = "unminted-thing"')
    );
    const row = buildFactoryRow({
      ...WIDGET_MANIFEST,
      factory: { ...WIDGET_MANIFEST.factory, archetype: 'unminted-thing' },
    });
    const registry = insertFactoryRow(BASE_REGISTRY, row);

    await expect(
      forgeValidate({
        manifestPath: join(targetDir, 'factory.toml'),
        fetchRegistry: async () => registry,
      })
    ).rejects.toThrow(
      /"unminted-thing" is not a minted archetype in toon-meta\/FACTORY\.md's catalog/
    );
  });
});

describe('forgeValidate — happy path: registered, pins match', () => {
  it('resolves with the manifest and no warnings', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(targetDir, WIDGET_TOML);
    const registry = insertFactoryRow(
      BASE_REGISTRY,
      buildFactoryRow(WIDGET_MANIFEST)
    );

    const result = await forgeValidate({
      manifestPath: join(targetDir, 'factory.toml'),
      fetchRegistry: async () => registry,
    });

    expect(result.manifest.factory.name).toBe('widget');
    expect(result.warnings).toEqual([]);
  });

  it('reports model divergence from org policy as a warning, not a failure', async () => {
    const targetDir = await tempTargetDir();
    await writeManifest(
      targetDir,
      WIDGET_TOML.replace(
        'implementer = "claude-sonnet-5"',
        'implementer = "claude-opus-4-8"'
      )
    );
    // Divergence is [loop.models]-only — the row's pins (unaffected by models) still match.
    const registry = insertFactoryRow(
      BASE_REGISTRY,
      buildFactoryRow(WIDGET_MANIFEST)
    );

    const result = await forgeValidate({
      manifestPath: join(targetDir, 'factory.toml'),
      fetchRegistry: async () => registry,
    });

    expect(result.warnings).toEqual([
      expect.stringMatching(
        /model divergence: \[loop\.models\]\.implementer = "claude-opus-4-8" diverges from org policy "claude-sonnet-5"/
      ),
    ]);
  });
});

describe('forgeValidate — archetype drift (§2.1) reported as a warning', () => {
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

  it('surfaces the stamped protected-tier rewrite as drift, without failing', async () => {
    const targetDir = await tempTargetDir();
    const stamped = await stamp(gamePlan(targetDir));
    const registry = insertFactoryRow(
      BASE_REGISTRY,
      buildFactoryRow(stamped.manifest)
    );

    const result = await forgeValidate({
      manifestPath: join(targetDir, 'factory.toml'),
      fetchRegistry: async () => registry,
    });

    expect(result.manifest.factory.archetype).toBe('game');
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /archetype drift: tier "t3-sim-replay-golden"\.run diverges/
      ),
    ]);
  });
});
