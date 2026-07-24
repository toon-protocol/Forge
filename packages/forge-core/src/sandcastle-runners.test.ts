import { describe, expect, it, vi } from 'vitest';
import type {
  AgentProvider,
  Sandbox,
  SandboxRunResult,
} from '@ai-hero/sandcastle';
import {
  branchForIssue,
  createSandcastleRunners,
  validatePlannedIssues,
  type GhClient,
  type PlanAgentRun,
  type PlannedIssues,
} from './sandcastle-runners.js';
import type { ImplementDispatch, LabeledIssueRef } from './cycle.js';

const AGENT = { name: 'stub-agent' } as unknown as AgentProvider;
const SANDBOX_PROVIDER = { name: 'stub-provider' } as unknown as Parameters<
  typeof createSandcastleRunners
>[0]['sandboxProvider'];

const ISSUE: LabeledIssueRef = { id: '33', title: 'concrete phase runners' };
const DISPATCH: ImplementDispatch = {
  task: ISSUE.title,
  branch: 'sandcastle/issue-33',
};

function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    branch: DISPATCH.branch,
    worktreePath: '/tmp/worktree',
    run: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(async () => ({})),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Sandbox;
}

function sandboxRunResult(
  overrides: Partial<SandboxRunResult> = {}
): SandboxRunResult {
  return {
    iterations: [],
    stdout: '',
    commits: [{ sha: 'c1' }],
    ...overrides,
  } as SandboxRunResult;
}

describe('validatePlannedIssues', () => {
  it('accepts a well-formed plan', () => {
    const value: PlannedIssues = {
      issues: [{ id: '33', title: 'x', branch: 'sandcastle/issue-33' }],
    };
    expect(validatePlannedIssues(value)).toEqual(value);
  });

  it('rejects a document with no "issues" key', () => {
    expect(() => validatePlannedIssues({})).toThrow(/"issues" array/);
  });

  it('rejects a non-array "issues"', () => {
    expect(() => validatePlannedIssues({ issues: 'nope' })).toThrow(
      /MUST be an array/
    );
  });

  it('rejects an issue entry missing a required field', () => {
    expect(() =>
      validatePlannedIssues({ issues: [{ id: '1', title: 'x' }] })
    ).toThrow(/issues\[0\]/);
  });
});

describe('branchForIssue', () => {
  it('formats the deterministic sandcastle/issue-<id> branch', () => {
    expect(branchForIssue('33')).toBe('sandcastle/issue-33');
  });
});

describe('createSandcastleRunners: runPlan', () => {
  it('runs the planner agent and returns the dispatch for the requested issue', async () => {
    const runPlanAgent = vi.fn<PlanAgentRun>(async () => ({
      output: {
        issues: [
          { id: '99', title: 'other', branch: 'sandcastle/issue-99' },
          {
            id: '33',
            title: 'concrete phase runners',
            branch: 'sandcastle/issue-33',
          },
        ],
      },
    }));

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      runPlanAgent,
    });

    const dispatch = await runners.runPlan(AGENT, ISSUE);

    expect(runPlanAgent).toHaveBeenCalledTimes(1);
    const call = runPlanAgent.mock.calls[0]![0];
    expect(call.agent).toBe(AGENT);
    expect(call.sandbox).toBe(SANDBOX_PROVIDER);
    expect(call.maxIterations).toBe(1);
    expect(call.promptFile).toBe('.sandcastle/plan-prompt.md');

    expect(dispatch).toEqual({
      task: ISSUE.title,
      branch: 'sandcastle/issue-33',
    });
  });

  it('throws when the planner excludes the requested issue (blocked)', async () => {
    const runPlanAgent = vi.fn<PlanAgentRun>(async () => ({
      output: { issues: [] },
    }));
    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      runPlanAgent,
    });

    await expect(runners.runPlan(AGENT, ISSUE)).rejects.toThrow(/blocked/);
  });

  it('throws when the planner returns a non-deterministic branch', async () => {
    const runPlanAgent = vi.fn<PlanAgentRun>(async () => ({
      output: { issues: [{ id: '33', title: 'x', branch: 'feature/wrong' }] },
    }));
    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      runPlanAgent,
    });

    await expect(runners.runPlan(AGENT, ISSUE)).rejects.toThrow(
      /expected the deterministic/
    );
  });
});

describe('createSandcastleRunners: runImplement + exec + runReview + openPr + close', () => {
  it('rejects exec/runReview/openPr before runImplement has created a sandbox', async () => {
    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
    });

    await expect(runners.exec('echo hi')).rejects.toThrow(
      /runImplement must run before/
    );
    await expect(runners.runReview(AGENT, DISPATCH.branch)).rejects.toThrow(
      /runImplement must run before/
    );
    await expect(runners.openPr(DISPATCH, ISSUE)).rejects.toThrow(
      /runImplement must run before/
    );
    await expect(runners.close()).resolves.toBeUndefined();
  });

  it('creates a sandbox on the dispatch branch and runs the implementer', async () => {
    const runResult = sandboxRunResult();
    const run = vi.fn(async () => runResult);
    const sandbox = fakeSandbox({ run });
    const createSandbox = vi.fn(async () => sandbox);

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      baseBranch: 'main',
    });

    const iteration = await runners.runImplement(AGENT, DISPATCH);

    expect(createSandbox).toHaveBeenCalledWith({
      branch: DISPATCH.branch,
      baseBranch: 'main',
      sandbox: SANDBOX_PROVIDER,
      hooks: undefined,
    });
    expect(run).toHaveBeenCalledWith({
      name: 'implementer',
      agent: AGENT,
      maxIterations: 100,
      promptFile: '.sandcastle/implement-prompt.md',
      promptArgs: {
        TASK_ID: '33',
        ISSUE_TITLE: DISPATCH.task,
        BRANCH: DISPATCH.branch,
      },
    });
    expect(iteration.commits).toEqual(runResult.commits);
    expect(iteration.resume).toBeUndefined();
  });

  it('adapts a resumable SandboxRunResult into a chainable Iteration', async () => {
    const resumed = sandboxRunResult({
      commits: [{ sha: 'c1' }, { sha: 'r1' }],
    });
    const resume = vi.fn(async (_prompt: string) => resumed);
    const runResult = sandboxRunResult({ resume });
    const sandbox = fakeSandbox({ run: vi.fn(async () => runResult) });
    const createSandbox = vi.fn(async () => sandbox);

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
    });

    const iteration = await runners.runImplement(AGENT, DISPATCH);
    expect(iteration.resume).toBeDefined();

    const next = await iteration.resume!('fix the lint error');
    expect(resume).toHaveBeenCalledWith('fix the lint error');
    expect(next.commits).toEqual(resumed.commits);
    expect(next.resume).toBeUndefined();
  });

  it('exec and runReview delegate to the sandbox runImplement created', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () =>
        sandboxRunResult({ commits: [{ sha: 'review-1' }] })
      ),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
    });
    await runners.runImplement(AGENT, DISPATCH);

    const execResult = await runners.exec('pnpm lint');
    expect(sandbox.exec).toHaveBeenCalledWith('pnpm lint', undefined);
    expect(execResult.exitCode).toBe(0);

    const review = await runners.runReview(AGENT, DISPATCH.branch);
    expect(sandbox.run).toHaveBeenLastCalledWith({
      name: 'reviewer',
      agent: AGENT,
      maxIterations: 1,
      promptFile: '.sandcastle/review-prompt.md',
      promptArgs: { BRANCH: DISPATCH.branch },
    });
    expect(review.commits).toEqual([{ sha: 'review-1' }]);

    await runners.close();
    expect(sandbox.close).toHaveBeenCalledTimes(1);
  });

  it('openPr pushes the branch and opens a PR when none is open yet', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const prList = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 7, url: 'https://example.com/pull/7' },
      ]);
    const prCreate = vi.fn(async () => {});
    const gh: GhClient = { prList, prCreate };

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh,
      baseBranch: 'main',
    });
    await runners.runImplement(AGENT, DISPATCH);

    const pr = await runners.openPr(DISPATCH, ISSUE);

    expect(sandbox.exec).toHaveBeenCalledWith(
      `git push -u origin ${DISPATCH.branch}`
    );
    expect(prCreate).toHaveBeenCalledWith({
      base: 'main',
      head: DISPATCH.branch,
      title: ISSUE.title,
      body: expect.stringContaining(`Closes #${ISSUE.id}`),
    });
    expect(pr).toEqual({ number: 7, url: 'https://example.com/pull/7' });
  });

  it('openPr skips pr create when a PR is already open for the branch', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);
    const prList = vi
      .fn()
      .mockResolvedValue([{ number: 5, url: 'https://example.com/pull/5' }]);
    const prCreate = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
    });
    await runners.runImplement(AGENT, DISPATCH);

    const pr = await runners.openPr(DISPATCH, ISSUE);

    expect(prCreate).not.toHaveBeenCalled();
    expect(pr).toEqual({ number: 5, url: 'https://example.com/pull/5' });
  });

  it('openPr fails loud when the push fails', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'auth failed',
      })),
    });
    const createSandbox = vi.fn(async () => sandbox);
    const prList = vi.fn();
    const prCreate = vi.fn();

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
    });
    await runners.runImplement(AGENT, DISPATCH);

    await expect(runners.openPr(DISPATCH, ISSUE)).rejects.toThrow(
      /git push .* failed/
    );
    expect(prList).not.toHaveBeenCalled();
  });

  it('openPr fails loud when no PR exists after the create attempt (silent failure)', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);
    const prList = vi.fn().mockResolvedValue([]);
    const prCreate = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
    });
    await runners.runImplement(AGENT, DISPATCH);

    await expect(runners.openPr(DISPATCH, ISSUE)).rejects.toThrow(
      /no OPEN PR exists/
    );
  });
});
