import { describe, expect, it, vi } from 'vitest';
import {
  driveImplementWithInnerGates,
  runPreReviewGate,
  type Iteration,
} from './loop.js';
import { resolveRoleAgents } from './models.js';
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
`;

function execResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

/** A stub sandbox: no docker, no real agent — a scripted exec + a scripted implementer that "fixes" red output on its second call. */
function makeStubImplementer(execResponses: ReturnType<typeof execResult>[]) {
  const exec = vi.fn();
  execResponses.forEach((r) => exec.mockResolvedValueOnce(r));

  let resumeCount = 0;
  const commits = [{ sha: 'c1' }];
  const firstIteration: Iteration = {
    commits,
    resume: vi.fn(async (_prompt: string) => {
      resumeCount += 1;
      const next: Iteration = {
        commits: [...commits, { sha: `repair-${resumeCount}` }],
      };
      return next;
    }),
  };
  return { exec, firstIteration };
}

// The full acceptance demo: load a manifest, resolve per-role models, run a
// stubbed implement/inner-gate loop, and observe the injected gates firing —
// all without a real sandbox or Actions run (Forge#7 acceptance criteria).
describe('stubbed inner-gate loop (end-to-end, no sandbox required)', () => {
  it('configures roles from the manifest and repairs a red gate via resume()', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const agents = resolveRoleAgents(manifest);
    expect(agents.implementer.name).toBe('claude-code');

    // First inner-gate check is red; the repaired iteration is green.
    const { exec, firstIteration } = makeStubImplementer([
      execResult(1, '', 'lint: unexpected token'),
      execResult(0, 'ok'),
    ]);

    const report = await driveImplementWithInnerGates(firstIteration, {
      manifest,
      exec,
    });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith('pnpm lint');
    expect(firstIteration.resume).toHaveBeenCalledTimes(1);
    expect(firstIteration.resume).toHaveBeenCalledWith(
      expect.stringContaining('lint: unexpected token')
    );
    expect(report.gateReports).toHaveLength(2);
    expect(report.gateReports[0]!.passed).toBe(false);
    expect(report.gateReports[1]!.passed).toBe(true);
    expect(report.final.commits.map((c) => c.sha)).toEqual(['c1', 'repair-1']);
  });

  it('stops immediately when the first gate check already passes — no repair needed', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const { exec, firstIteration } = makeStubImplementer([execResult(0, 'ok')]);

    const report = await driveImplementWithInnerGates(firstIteration, {
      manifest,
      exec,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(firstIteration.resume).not.toHaveBeenCalled();
    expect(report.final).toBe(firstIteration);
  });

  it('gives up after maxRepairAttempts and returns the last iteration still red', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const { exec, firstIteration } = makeStubImplementer([
      execResult(1, '', 'red'),
      execResult(1, '', 'still red'),
    ]);

    const report = await driveImplementWithInnerGates(firstIteration, {
      manifest,
      exec,
      maxRepairAttempts: 1,
    });

    expect(firstIteration.resume).toHaveBeenCalledTimes(1);
    expect(report.gateReports).toHaveLength(2);
    expect(report.gateReports.at(-1)!.passed).toBe(false);
  });

  it('runs the same inner gates before review and reports red without attempting repair', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const exec = vi
      .fn()
      .mockResolvedValue(execResult(1, '', 'lint: still broken'));

    const report = await runPreReviewGate(exec, manifest);

    expect(exec).toHaveBeenCalledWith('pnpm lint');
    expect(report.passed).toBe(false);
    expect(report.repairPrompt).toContain('lint: still broken');
  });
});
