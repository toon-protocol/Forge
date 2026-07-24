import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '@ai-hero/sandcastle';
import { runPlanImplementCycle, type ImplementDispatch } from './cycle.js';
import type { Iteration } from './loop.js';
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

const ISSUE = { id: '22', title: 'forge-core: plan→implement cycle' };

function modelOf(provider: AgentProvider): string {
  const { command } = provider.buildPrintCommand({
    prompt: 'hi',
    dangerouslySkipPermissions: true,
  });
  const match = /--model '([^']+)'/.exec(command);
  if (!match) throw new Error(`no --model flag in: ${command}`);
  return match[1]!;
}

function execResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('runPlanImplementCycle (stubbed, no sandbox required)', () => {
  it('plans on the planner model, implements on the implementer model, and repairs a red inner gate', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);

    const dispatch: ImplementDispatch = {
      task: ISSUE.title,
      branch: 'sandcastle/issue-22',
    };
    const runPlan = vi.fn(async (_agent: AgentProvider) => dispatch);

    let resumeCount = 0;
    const commits = [{ sha: 'c1' }];
    const firstIteration: Iteration = {
      commits,
      resume: vi.fn(async (_prompt: string) => {
        resumeCount += 1;
        return { commits: [...commits, { sha: `repair-${resumeCount}` }] };
      }),
    };
    const runImplement = vi.fn(async (_agent: AgentProvider) => firstIteration);

    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(1, '', 'lint: unexpected token'))
      .mockResolvedValueOnce(execResult(0, 'ok'));

    const report = await runPlanImplementCycle(ISSUE, {
      manifest,
      exec,
      runPlan,
      runImplement,
    });

    expect(runPlan).toHaveBeenCalledTimes(1);
    expect(modelOf(runPlan.mock.calls[0]![0])).toBe('claude-opus-4-8');
    expect(runPlan.mock.calls[0]![1]).toEqual(ISSUE);

    expect(runImplement).toHaveBeenCalledTimes(1);
    expect(modelOf(runImplement.mock.calls[0]![0])).toBe('claude-sonnet-5');
    expect(runImplement.mock.calls[0]![1]).toEqual(dispatch);

    expect(report.dispatch).toEqual(dispatch);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(firstIteration.resume).toHaveBeenCalledTimes(1);
    expect(firstIteration.resume).toHaveBeenCalledWith(
      expect.stringContaining('lint: unexpected token')
    );
    expect(report.gateReports).toHaveLength(2);
    expect(report.gateReports[0]!.passed).toBe(false);
    expect(report.gateReports[1]!.passed).toBe(true);
    expect(report.final.commits.map((c) => c.sha)).toEqual(['c1', 'repair-1']);
  });

  it('stops immediately when the first inner-gate check already passes', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const dispatch: ImplementDispatch = {
      task: ISSUE.title,
      branch: 'sandcastle/issue-22',
    };
    const runPlan = vi.fn(async () => dispatch);
    const firstIteration: Iteration = { commits: [{ sha: 'c1' }] };
    const runImplement = vi.fn(async () => firstIteration);
    const exec = vi.fn().mockResolvedValueOnce(execResult(0, 'ok'));

    const report = await runPlanImplementCycle(ISSUE, {
      manifest,
      exec,
      runPlan,
      runImplement,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(report.final).toBe(firstIteration);
    expect(report.gateReports).toHaveLength(1);
  });
});
