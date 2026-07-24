import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '@ai-hero/sandcastle';
import {
  runPlanImplementCycle,
  runCycle,
  type ImplementDispatch,
  type ReviewResult,
  type PullRequestRef,
} from './cycle.js';
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

describe('runCycle (stubbed, no sandbox required)', () => {
  it('composes plan -> implement -> inner-gates -> pre-review-gate -> review -> PR, each on its manifest-resolved model', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);

    const dispatch: ImplementDispatch = {
      task: ISSUE.title,
      branch: 'sandcastle/issue-23',
    };
    const runPlan = vi.fn(async () => dispatch);

    const firstIteration: Iteration = { commits: [{ sha: 'c1' }] };
    const runImplement = vi.fn(async () => firstIteration);

    // First exec call: inner-gate check during implement. Second: the
    // pre-review gate. Both green, so no repair and review proceeds.
    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(0, 'ok'))
      .mockResolvedValueOnce(execResult(0, 'ok'));

    const reviewResult: ReviewResult = { commits: [{ sha: 'review-1' }] };
    const runReview = vi.fn(
      async (_agent: AgentProvider, _branch: string) => reviewResult
    );

    const pr: PullRequestRef = {
      number: 99,
      url: 'https://github.com/toon-protocol/example/pull/99',
    };
    const openPr = vi.fn(async () => pr);

    const report = await runCycle(ISSUE, {
      manifest,
      exec,
      runPlan,
      runImplement,
      runReview,
      openPr,
    });

    expect(runPlan).toHaveBeenCalledTimes(1);
    expect(runImplement).toHaveBeenCalledTimes(1);
    expect(modelOf(runImplement.mock.calls[0]![0])).toBe('claude-sonnet-5');

    expect(exec).toHaveBeenCalledTimes(2);

    expect(runReview).toHaveBeenCalledTimes(1);
    expect(modelOf(runReview.mock.calls[0]![0])).toBe('claude-sonnet-5');
    expect(runReview.mock.calls[0]![1]).toBe(dispatch.branch);

    expect(openPr).toHaveBeenCalledTimes(1);
    expect(openPr.mock.calls[0]![0]).toEqual(dispatch);
    expect(openPr.mock.calls[0]![1]).toEqual(ISSUE);

    expect(report.dispatch).toEqual(dispatch);
    expect(report.preReviewGate.passed).toBe(true);
    expect(report.review).toEqual(reviewResult);
    expect(report.pr).toEqual(pr);
  });

  it('runs the pre-review gate after implement finishes, even when it is red — advisory only, does not block review', async () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const dispatch: ImplementDispatch = {
      task: ISSUE.title,
      branch: 'sandcastle/issue-23',
    };
    const runPlan = vi.fn(async () => dispatch);
    const firstIteration: Iteration = { commits: [{ sha: 'c1' }] };
    const runImplement = vi.fn(async () => firstIteration);

    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(0, 'ok'))
      .mockResolvedValueOnce(execResult(1, '', 'lint: still broken'));

    const runReview = vi.fn(async () => ({ commits: [] }) as ReviewResult);
    const openPr = vi.fn(
      async () =>
        ({ number: 1, url: 'https://example.com/pull/1' }) as PullRequestRef
    );

    const report = await runCycle(ISSUE, {
      manifest,
      exec,
      runPlan,
      runImplement,
      runReview,
      openPr,
    });

    expect(report.preReviewGate.passed).toBe(false);
    expect(report.preReviewGate.repairPrompt).toContain('lint: still broken');
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(openPr).toHaveBeenCalledTimes(1);
  });
});
