import { describe, expect, it, vi } from 'vitest';
import type { FactoryManifest } from '@toon-protocol/forge-core';
import {
  buildProofReport,
  checkModelTieringEvidence,
  findRunForLabel,
  formatProofReport,
  isDecoyRun,
  proofIssueBody,
  proofIssueTitle,
  runFactoryProof,
  type FactoryProofGhClient,
  type ProofCheckRun,
  type ProofPrInfo,
  type WorkflowRunSummary,
} from './factory-proof.js';

const MANIFEST = {
  loop: {
    models: {
      planner: 'claude-opus-4-8',
      merger: 'claude-opus-4-8',
      implementer: 'claude-sonnet-5',
      reviewer: 'claude-sonnet-5',
    },
  },
} as unknown as FactoryManifest;

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-08-13T10:00:30Z',
    url: 'https://github.com/toon-protocol/Forge/actions/runs/1',
    displayTitle: 'agent:implement — issue #99',
    ...overrides,
  };
}

const LABELED_AT = '2026-08-13T10:00:00Z';

describe('isDecoyRun', () => {
  it('is true for a completed run that concluded skipped', () => {
    expect(isDecoyRun({ status: 'completed', conclusion: 'skipped' })).toBe(
      true
    );
  });

  it('is false for a completed run that concluded success', () => {
    expect(isDecoyRun({ status: 'completed', conclusion: 'success' })).toBe(
      false
    );
  });

  it('is false for a run still in progress', () => {
    expect(isDecoyRun({ status: 'in_progress', conclusion: null })).toBe(false);
  });
});

describe('findRunForLabel', () => {
  it('matches on displayTitle (exact tier) over a decoy created around the same time', () => {
    const decoy = run({
      id: 2,
      displayTitle: 'agent:implement — issue #99',
      conclusion: 'skipped',
      createdAt: '2026-08-13T09:59:00Z',
    });
    const real = run({ id: 3, createdAt: '2026-08-13T10:00:10Z' });
    const other = run({
      id: 4,
      displayTitle: 'agent:implement — issue #5',
      createdAt: '2026-08-13T10:00:20Z',
    });
    const result = findRunForLabel({
      runs: [decoy, real, other],
      issueNumber: 99,
      labeledAt: LABELED_AT,
    });
    expect(result?.id).toBe(3);
  });

  it('returns null when the only exact-title matches are all decoys', () => {
    const decoy = run({ conclusion: 'skipped', id: 5 });
    const result = findRunForLabel({
      runs: [decoy],
      issueNumber: 99,
      labeledAt: LABELED_AT,
    });
    expect(result).toBeNull();
  });

  it('never drops a live (non-completed) run even if a decoy also matches', () => {
    const decoy = run({ conclusion: 'skipped', id: 6 });
    const live = run({ id: 7, status: 'in_progress', conclusion: null });
    const result = findRunForLabel({
      runs: [decoy, live],
      issueNumber: 99,
      labeledAt: LABELED_AT,
    });
    expect(result?.id).toBe(7);
  });

  it('falls back to the nearest-after time window when no title matches (no run-name)', () => {
    const noTitle = run({
      id: 8,
      displayTitle: '',
      createdAt: '2026-08-13T10:00:05Z',
    });
    const later = run({
      id: 9,
      displayTitle: '',
      createdAt: '2026-08-13T10:05:00Z',
    });
    const result = findRunForLabel({
      runs: [later, noTitle],
      issueNumber: 99,
      labeledAt: LABELED_AT,
    });
    expect(result?.id).toBe(8);
  });

  it('ignores runs outside the time window when no title matches', () => {
    const tooLate = run({
      id: 10,
      displayTitle: '',
      createdAt: '2026-08-13T10:20:00Z',
    });
    const result = findRunForLabel({
      runs: [tooLate],
      issueNumber: 99,
      labeledAt: LABELED_AT,
    });
    expect(result).toBeNull();
  });

  it('returns null when nothing correlates at all', () => {
    expect(
      findRunForLabel({ runs: [], issueNumber: 99, labeledAt: LABELED_AT })
    ).toBeNull();
  });
});

describe('checkModelTieringEvidence', () => {
  it('reports per-role presence of the manifest model string in the log text', () => {
    const evidence = checkModelTieringEvidence(
      'planner resolved claude-opus-4-8\nimplementer resolved claude-sonnet-5',
      MANIFEST.loop.models
    );
    expect(evidence).toEqual([
      { role: 'planner', model: 'claude-opus-4-8', seenInLog: true },
      { role: 'merger', model: 'claude-opus-4-8', seenInLog: true },
      { role: 'implementer', model: 'claude-sonnet-5', seenInLog: true },
      { role: 'reviewer', model: 'claude-sonnet-5', seenInLog: true },
    ]);
  });

  it('reports false when a model string never appears', () => {
    const evidence = checkModelTieringEvidence('nothing relevant here', {
      planner: 'claude-opus-4-8',
      merger: 'claude-opus-4-8',
      implementer: 'claude-sonnet-5',
      reviewer: 'claude-sonnet-5',
    });
    expect(evidence.every((e) => !e.seenInLog)).toBe(true);
  });
});

const PR: ProofPrInfo = {
  number: 42,
  url: 'https://github.com/toon-protocol/Forge/pull/42',
  state: 'OPEN',
  headRefName: 'sandcastle/issue-99',
  body: 'Closes #99\n\nsome body',
};

const GREEN_CHECKS: readonly ProofCheckRun[] = [
  { name: 'gate', status: 'completed', conclusion: 'success' },
];

describe('buildProofReport', () => {
  it('passes every criterion given a completed run, an open referencing PR, and a green gate check', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'https://github.com/toon-protocol/Forge/issues/99',
      run: run(),
      pr: PR,
      checkRuns: GREEN_CHECKS,
    });
    expect(report.passed).toBe(true);
    expect(report.criteria.every((c) => c.passed)).toBe(true);
    expect(report.criteria.map((c) => c.id)).toEqual([
      'run-succeeded',
      'pr-opened',
      'no-auto-merge',
      'ci-green',
    ]);
  });

  it('fails run-succeeded when the correlated run is a decoy', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run({ conclusion: 'skipped' }),
      pr: PR,
      checkRuns: GREEN_CHECKS,
    });
    expect(report.passed).toBe(false);
    expect(report.criteria.find((c) => c.id === 'run-succeeded')?.passed).toBe(
      false
    );
  });

  it('fails pr-opened when no PR was found', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: null,
      checkRuns: [],
    });
    expect(report.passed).toBe(false);
    expect(report.criteria.find((c) => c.id === 'pr-opened')?.passed).toBe(
      false
    );
    expect(report.criteria.find((c) => c.id === 'no-auto-merge')?.passed).toBe(
      false
    );
  });

  it('fails pr-opened when the PR body never references the seed issue', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: { ...PR, body: 'unrelated' },
      checkRuns: GREEN_CHECKS,
    });
    expect(report.criteria.find((c) => c.id === 'pr-opened')?.passed).toBe(
      false
    );
  });

  it('fails no-auto-merge when the PR was merged', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: { ...PR, state: 'MERGED' },
      checkRuns: GREEN_CHECKS,
    });
    expect(report.criteria.find((c) => c.id === 'no-auto-merge')?.passed).toBe(
      false
    );
  });

  it('fails ci-green when the gate check failed', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: PR,
      checkRuns: [{ name: 'gate', status: 'completed', conclusion: 'failure' }],
    });
    expect(report.criteria.find((c) => c.id === 'ci-green')?.passed).toBe(
      false
    );
  });

  it('fails ci-green when no matching check run is present yet', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: PR,
      checkRuns: [],
    });
    expect(report.criteria.find((c) => c.id === 'ci-green')?.passed).toBe(
      false
    );
  });

  it('carries model-tiering evidence as advisory notes, never as a criterion', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: PR,
      checkRuns: GREEN_CHECKS,
      modelTieringEvidence: [
        { role: 'planner', model: 'claude-opus-4-8', seenInLog: false },
      ],
    });
    expect(report.criteria.map((c) => c.id)).not.toContain('model-tiering');
    expect(report.notes.some((n) => n.includes('claude-opus-4-8'))).toBe(true);
    // A false model-tiering note must not fail the overall proof.
    expect(report.passed).toBe(true);
  });
});

describe('formatProofReport', () => {
  it('renders a green summary line when every criterion passes', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: PR,
      checkRuns: GREEN_CHECKS,
    });
    const text = formatProofReport(report);
    expect(text).toContain('forge factory-proof: green');
    expect(text).toContain('run-succeeded');
  });

  it('renders a RED summary line when a criterion fails', () => {
    const report = buildProofReport({
      issueNumber: 99,
      issueUrl: 'x',
      run: run(),
      pr: null,
      checkRuns: [],
    });
    expect(formatProofReport(report)).toContain('forge factory-proof: RED');
  });
});

describe('proofIssueTitle / proofIssueBody', () => {
  it('marks the seed issue as disposable', () => {
    expect(proofIssueTitle('2026-08-13T10:00:00.000Z')).toContain(
      '[factory-proof] disposable'
    );
    expect(proofIssueBody('2026-08-13T10:00:00.000Z')).toContain(
      '<!-- factory-proof:disposable -->'
    );
  });
});

function fakeGh(
  overrides: Partial<FactoryProofGhClient> = {}
): FactoryProofGhClient {
  return {
    createIssue: vi.fn(async () => ({
      number: 99,
      url: 'https://github.com/toon-protocol/Forge/issues/99',
    })),
    addLabel: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    listWorkflowRuns: vi.fn(async () => [run()]),
    getRun: vi.fn(async () => run()),
    findPrForBranch: vi.fn(async () => PR),
    listCheckRuns: vi.fn(async () => GREEN_CHECKS),
    getRunLogText: vi.fn(async () => 'claude-opus-4-8 claude-sonnet-5'),
    closePr: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runFactoryProof', () => {
  it('seeds an issue, labels it, correlates + polls to completion, and returns a passing report', async () => {
    const gh = fakeGh();
    const sleep = vi.fn(async () => {});
    const report = await runFactoryProof({
      manifest: MANIFEST,
      gh,
      sleep,
      now: () => new Date(LABELED_AT),
    });

    expect(report.passed).toBe(true);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
    expect(gh.addLabel).toHaveBeenCalledWith({
      number: 99,
      label: 'agent:implement',
    });
    expect(gh.findPrForBranch).toHaveBeenCalledWith({
      branch: 'sandcastle/issue-99',
    });
    // Cleans up by default: closes the PR then the issue.
    expect(gh.closePr).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42, deleteBranch: true })
    );
    expect(gh.closeIssue).toHaveBeenCalledWith(
      expect.objectContaining({ number: 99 })
    );
  });

  it('polls until the run is correlated, then until it completes', async () => {
    const inProgress = run({ status: 'in_progress', conclusion: null });
    const listWorkflowRuns = vi
      .fn()
      .mockResolvedValueOnce([]) // not yet correlated
      .mockResolvedValueOnce([inProgress]); // correlated, still running
    const getRun = vi
      .fn()
      .mockResolvedValueOnce(inProgress) // still running
      .mockResolvedValueOnce(run()); // completed
    const gh = fakeGh({ listWorkflowRuns, getRun });
    const sleep = vi.fn(async () => {});

    const report = await runFactoryProof({
      manifest: MANIFEST,
      gh,
      sleep,
      now: () => new Date(LABELED_AT),
    });

    expect(report.passed).toBe(true);
    // 1 sleep before the correlating list call, 2 more inside the completion
    // poll (each attempt sleeps, then re-checks — the 2nd re-check is done).
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('throws when no run ever correlates within the poll budget', async () => {
    const gh = fakeGh({ listWorkflowRuns: vi.fn(async () => []) });
    const sleep = vi.fn(async () => {});

    await expect(
      runFactoryProof({
        manifest: MANIFEST,
        gh,
        sleep,
        now: () => new Date(LABELED_AT),
        correlatePoll: { attempts: 2, intervalMs: 1 },
      })
    ).rejects.toThrow(/no run correlated/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws when the correlated run never completes within the poll budget', async () => {
    const inProgress = run({ status: 'in_progress', conclusion: null });
    const gh = fakeGh({
      listWorkflowRuns: vi.fn(async () => [inProgress]),
      getRun: vi.fn(async () => inProgress),
    });
    const sleep = vi.fn(async () => {});

    await expect(
      runFactoryProof({
        manifest: MANIFEST,
        gh,
        sleep,
        now: () => new Date(LABELED_AT),
        completionPoll: { attempts: 2, intervalMs: 1 },
      })
    ).rejects.toThrow(/did not complete/);
  });

  it('skips cleanup when cleanup: false', async () => {
    const gh = fakeGh();
    await runFactoryProof({
      manifest: MANIFEST,
      gh,
      sleep: vi.fn(async () => {}),
      now: () => new Date(LABELED_AT),
      cleanup: false,
    });
    expect(gh.closePr).not.toHaveBeenCalled();
    expect(gh.closeIssue).not.toHaveBeenCalled();
  });

  it('does not fail the proof when the best-effort log fetch throws', async () => {
    const gh = fakeGh({
      getRunLogText: vi.fn(async () => {
        throw new Error('log expired');
      }),
    });
    const report = await runFactoryProof({
      manifest: MANIFEST,
      gh,
      sleep: vi.fn(async () => {}),
      now: () => new Date(LABELED_AT),
    });
    expect(report.passed).toBe(true);
  });
});
