import { describe, expect, it, vi } from 'vitest';
import {
  globToRegExp,
  isArmed,
  runPrGateLadder,
  selectPrGateTiers,
} from './pr-gate.js';
import { parseManifest } from './manifest.js';

const MANIFEST_SOURCE = `
[factory]
name = "example"
repo = "toon-protocol/example"
archetype = "blank"

[environment]
kind = "node-pnpm"
node = "22"
lockfile = "pnpm-lock.yaml"

[loop]
template = "parallel-planner-with-review"
inner_gates = ["t0-lint"]
[loop.models]
planner = "claude-opus-4-8"
merger = "claude-opus-4-8"
implementer = "claude-sonnet-5"
reviewer = "claude-sonnet-5"

[[oracle.tier]]
id = "t0-lint"
run = "pnpm lint"
on = ["**/*.ts"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t3-build"
run = "pnpm build"
on = ["**/*.ts"]
surfaces = ["pr"]
cost = "expensive"

[[oracle.tier]]
id = "t1-typecheck"
run = "pnpm typecheck"
on = []
surfaces = ["pr"]
cost = "moderate"

[[oracle.tier]]
id = "t9-docs-only"
run = "pnpm lint:docs"
on = ["**/*.md"]
surfaces = ["pr"]
cost = "cheap"
`;

function execResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('globToRegExp / isArmed', () => {
  it('matches `**` across directory segments and `*` within one', () => {
    const re = globToRegExp('src/**/*.ts');
    expect(re.test('src/a/b/foo.ts')).toBe(true);
    expect(re.test('src/foo.ts')).toBe(false);
    expect(re.test('src/a/b/foo.md')).toBe(false);
  });

  it('treats an empty `on` array as always armed, regardless of files', () => {
    const tier = {
      id: 't',
      run: 'x',
      on: [],
      surfaces: ['pr'] as const,
      cost: 'cheap' as const,
      protected: false,
    };
    expect(isArmed(tier, [])).toBe(true);
    expect(isArmed(tier, ['unrelated.rs'])).toBe(true);
  });

  it('arms a non-empty `on` tier only when a file matches one of its globs', () => {
    const tier = {
      id: 't',
      run: 'x',
      on: ['**/*.md'],
      surfaces: ['pr'] as const,
      cost: 'cheap' as const,
      protected: false,
    };
    expect(isArmed(tier, ['src/foo.ts'])).toBe(false);
    expect(isArmed(tier, ['docs/README.md'])).toBe(true);
  });
});

describe('selectPrGateTiers', () => {
  it('selects only pr-surfaced tiers, cost-ordered cheapest-first', () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const tiers = selectPrGateTiers(manifest);
    expect(tiers.map((t) => t.id)).toEqual([
      't0-lint',
      't9-docs-only',
      't1-typecheck',
      't3-build',
    ]);
  });
});

describe('runPrGateLadder', () => {
  it('runs every armed tier cost-ordered and skips unarmed ones', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockResolvedValue(execResult(0, 'ok'));

    const report = await runPrGateLadder(exec, manifest, ['src/foo.ts']);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenNthCalledWith(1, 'pnpm lint');
    expect(exec).toHaveBeenNthCalledWith(2, 'pnpm typecheck');
    expect(exec).toHaveBeenNthCalledWith(3, 'pnpm build');
    expect(report.passed).toBe(true);
    expect(report.results).toEqual([
      {
        tierId: 't0-lint',
        command: 'pnpm lint',
        cost: 'cheap',
        status: 'passed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
      {
        tierId: 't9-docs-only',
        command: 'pnpm lint:docs',
        cost: 'cheap',
        status: 'skipped',
      },
      {
        tierId: 't1-typecheck',
        command: 'pnpm typecheck',
        cost: 'moderate',
        status: 'passed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
      {
        tierId: 't3-build',
        command: 'pnpm build',
        cost: 'expensive',
        status: 'passed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
    ]);
  });

  it('does not short-circuit on the first failure, and marks the report red', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'pnpm lint')
        return execResult(1, '', 'src/foo.ts:1: unexpected token');
      return execResult(0, 'ok');
    });

    const report = await runPrGateLadder(exec, manifest, ['src/foo.ts']);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(report.passed).toBe(false);
    const lint = report.results.find((r) => r.tierId === 't0-lint');
    expect(lint?.status).toBe('failed');
    expect(lint?.stderr).toBe('src/foo.ts:1: unexpected token');
    const build = report.results.find((r) => r.tierId === 't3-build');
    expect(build?.status).toBe('passed');
  });

  it('a skipped-only ladder (no files match) still passes', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockResolvedValue(execResult(0, 'ok'));

    const report = await runPrGateLadder(exec, manifest, ['docs/README.md']);

    expect(exec).toHaveBeenCalledTimes(2); // t9-docs-only (armed by README.md) + t1-typecheck (always armed)
    expect(report.passed).toBe(true);
    expect(report.results.find((r) => r.tierId === 't0-lint')?.status).toBe(
      'skipped'
    );
    expect(report.results.find((r) => r.tierId === 't3-build')?.status).toBe(
      'skipped'
    );
  });
});
