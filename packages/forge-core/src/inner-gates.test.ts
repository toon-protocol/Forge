import { describe, expect, it, vi } from 'vitest';
import {
  buildRepairPrompt,
  runInnerGates,
  selectInnerGateTiers,
} from './inner-gates.js';
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
inner_gates = ["t0-lint", "t1-typecheck"]
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
id = "t1-typecheck"
run = "pnpm typecheck"
on = ["**/*.ts"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t2-expensive-pr-only"
run = "pnpm e2e"
on = []
surfaces = ["pr"]
cost = "expensive"
`;

function execResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('selectInnerGateTiers', () => {
  it('resolves inner_gates ids to their tier definitions, filtered to the inner surface', () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const tiers = selectInnerGateTiers(manifest);
    expect(tiers.map((t) => t.id)).toEqual(['t0-lint', 't1-typecheck']);
  });

  it('excludes tiers not listed in inner_gates even if they are cheap', () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const tiers = selectInnerGateTiers(manifest);
    expect(tiers.some((t) => t.id === 't2-expensive-pr-only')).toBe(false);
  });
});

describe('runInnerGates', () => {
  it('runs every inner-gate tier via exec and reports pass when all exit 0', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockResolvedValue(execResult(0, 'ok'));

    const report = await runInnerGates(exec, manifest);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, 'pnpm lint');
    expect(exec).toHaveBeenNthCalledWith(2, 'pnpm typecheck');
    expect(report.passed).toBe(true);
    expect(report.repairPrompt).toBeUndefined();
  });

  it('surfaces a non-zero exit as a failing gate and builds a repair prompt from the red output', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'pnpm lint')
        return execResult(1, '', 'src/foo.ts:1: unexpected token');
      return execResult(0, 'ok');
    });

    const report = await runInnerGates(exec, manifest);

    expect(report.passed).toBe(false);
    expect(report.results).toEqual([
      {
        tierId: 't0-lint',
        command: 'pnpm lint',
        exitCode: 1,
        stdout: '',
        stderr: 'src/foo.ts:1: unexpected token',
        passed: false,
      },
      {
        tierId: 't1-typecheck',
        command: 'pnpm typecheck',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        passed: true,
      },
    ]);
    expect(report.repairPrompt).toContain('t0-lint');
    expect(report.repairPrompt).toContain('src/foo.ts:1: unexpected token');
    expect(report.repairPrompt).not.toContain('t1-typecheck');
  });

  it('does not short-circuit on the first failure — every gate runs', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi.fn().mockResolvedValue(execResult(1, '', 'red'));

    const report = await runInnerGates(exec, manifest);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(report.passed).toBe(false);
    expect(report.results.every((r) => !r.passed)).toBe(true);
  });
});

describe('buildRepairPrompt', () => {
  it('formats each failure with its tier id, command, exit code, and combined output', () => {
    const prompt = buildRepairPrompt([
      {
        tierId: 't0-lint',
        command: 'pnpm lint',
        exitCode: 1,
        stdout: 'stdout line',
        stderr: 'stderr line',
        passed: false,
      },
    ]);

    expect(prompt).toContain('t0-lint');
    expect(prompt).toContain('pnpm lint');
    expect(prompt).toContain('exited 1');
    expect(prompt).toContain('stdout line');
    expect(prompt).toContain('stderr line');
  });
});
