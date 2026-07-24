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

  it('prepareForReview opens the sandbox on an existing branch (no baseBranch) so runReview runs without an implement phase', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () =>
        sandboxRunResult({ commits: [{ sha: 'review-1' }] })
      ),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      baseBranch: 'main',
    });

    // No runImplement — review-only path.
    await runners.prepareForReview('sandcastle/issue-99');

    expect(createSandbox).toHaveBeenCalledTimes(1);
    const opts = createSandbox.mock.calls[0]![0];
    expect(opts.branch).toBe('sandcastle/issue-99');
    expect(opts.baseBranch).toBeUndefined();

    const review = await runners.runReview(AGENT, 'sandcastle/issue-99');
    expect(review.commits).toEqual([{ sha: 'review-1' }]);

    const pushed = await runners.exec('git push origin sandcastle/issue-99');
    expect(pushed.exitCode).toBe(0);

    await runners.close();
    expect(sandbox.close).toHaveBeenCalledTimes(1);
  });

  it('openPr pushes the branch and opens a PR when none is open yet (success on first try)', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const prList = vi
      .fn()
      .mockResolvedValueOnce([]) // idempotency pre-check (state: all)
      .mockResolvedValueOnce([
        { number: 7, url: 'https://example.com/pull/7' },
      ]); // post-create verification (state: open)
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
    expect(prCreate).toHaveBeenCalledTimes(1);
    expect(prCreate).toHaveBeenCalledWith({
      base: 'main',
      head: DISPATCH.branch,
      title: ISSUE.title,
      body: expect.stringContaining(`Closes #${ISSUE.id}`),
    });
    expect(pr).toEqual({ number: 7, url: 'https://example.com/pull/7' });
  });

  it('openPr skips pr create when a PR is already open for the branch (idempotent, no duplicate)', async () => {
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
    expect(prList).toHaveBeenCalledWith({
      branch: DISPATCH.branch,
      state: 'all',
    });
    expect(pr).toEqual({ number: 5, url: 'https://example.com/pull/5' });
  });

  it('openPr skips pr create when a CLOSED PR already exists for the branch', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);
    const prList = vi
      .fn()
      .mockResolvedValue([{ number: 9, url: 'https://example.com/pull/9' }]);
    const prCreate = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
    });
    await runners.runImplement(AGENT, DISPATCH);

    const pr = await runners.openPr(DISPATCH, ISSUE);

    expect(prCreate).not.toHaveBeenCalled();
    expect(pr).toEqual({ number: 9, url: 'https://example.com/pull/9' });
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

  it('openPr fails loud when no PR exists after the create attempt (silent failure), retries exhausted', async () => {
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
      prCreateRetry: { delaysMs: [] }, // single attempt, no waiting
    });
    await runners.runImplement(AGENT, DISPATCH);

    await expect(runners.openPr(DISPATCH, ISSUE)).rejects.toThrow(
      /no OPEN PR exists/
    );
  });

  it('openPr retries after a failed prCreate attempt and succeeds (success-after-retry)', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const prList = vi
      .fn()
      .mockResolvedValueOnce([]) // pre-check, attempt 1
      .mockResolvedValueOnce([]) // pre-check, attempt 2 (still no server-side PR)
      .mockResolvedValueOnce([
        { number: 12, url: 'https://example.com/pull/12' },
      ]); // post-create verification, attempt 2
    const prCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('GraphQL: Something went wrong while executing your query')
      )
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
      prCreateRetry: { delaysMs: [2000, 8000], sleep },
    });
    await runners.runImplement(AGENT, DISPATCH);

    const pr = await runners.openPr(DISPATCH, ISSUE);

    expect(prCreate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(pr).toEqual({ number: 12, url: 'https://example.com/pull/12' });
  });

  it('openPr rechecks for a server-side success before retrying, instead of blindly re-creating', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const prList = vi
      .fn()
      .mockResolvedValueOnce([]) // pre-check, attempt 1 — nothing yet
      .mockResolvedValueOnce([
        { number: 21, url: 'https://example.com/pull/21' },
      ]); // pre-check, attempt 2 — a 500 masked a server-side success
    const prCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 500 (empty body)'));
    const sleep = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate },
      prCreateRetry: { delaysMs: [2000], sleep },
    });
    await runners.runImplement(AGENT, DISPATCH);

    const pr = await runners.openPr(DISPATCH, ISSUE);

    expect(prCreate).toHaveBeenCalledTimes(1);
    expect(pr).toEqual({ number: 21, url: 'https://example.com/pull/21' });
  });

  it('openPr exhausts every retry, throws naming the pushed branch + a recovery command, and never deletes the branch', async () => {
    const sandbox = fakeSandbox({
      run: vi.fn(async () => sandboxRunResult()),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    const createSandbox = vi.fn(async () => sandbox);

    const prList = vi.fn().mockResolvedValue([]);
    const prCreate = vi
      .fn()
      .mockRejectedValue(new Error('HTTP 500 (empty body)'));
    const issueComment = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    const runners = createSandcastleRunners({
      sandboxProvider: SANDBOX_PROVIDER,
      createSandbox,
      gh: { prList, prCreate, issueComment },
      baseBranch: 'main',
      prCreateRetry: { delaysMs: [2000, 8000], sleep },
    });
    await runners.runImplement(AGENT, DISPATCH);

    await expect(runners.openPr(DISPATCH, ISSUE)).rejects.toThrow(
      new RegExp(
        `${DISPATCH.branch}.*IS pushed.*gh pr create --base main --head ${DISPATCH.branch}`,
        's'
      )
    );
    expect(prCreate).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    expect(issueComment).toHaveBeenCalledTimes(1);
    const commentArgs = issueComment.mock.calls[0]![0];
    expect(commentArgs.issue).toBe(ISSUE.id);
    expect(commentArgs.body).toContain(DISPATCH.branch);
    expect(commentArgs.body).toContain('gh pr create');

    const execCalls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0]
    );
    expect(
      execCalls.some(
        (cmd) => typeof cmd === 'string' && /branch\s+-[dD]/.test(cmd)
      )
    ).toBe(false);
  });
});
