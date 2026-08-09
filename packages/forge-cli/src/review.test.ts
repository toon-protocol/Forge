import { describe, expect, it, vi } from 'vitest';
import { forgeReview } from './review.js';
import type { FactoryManifest } from '@toon-protocol/forge-core';

const MANIFEST = {
  loop: { models: { reviewer: 'claude-sonnet-5' } },
} as unknown as FactoryManifest;

const REVIEWER = { name: 'reviewer-agent' } as never;

function fakeRunners(reviewCommits: { sha: string }[]) {
  return {
    runPlan: vi.fn(),
    runImplement: vi.fn(),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runReview: vi.fn(async () => ({ commits: reviewCommits })),
    openPr: vi.fn(),
    prepareForReview: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function deps(reviewCommits: { sha: string }[] = []) {
  const runners = fakeRunners(reviewCommits);
  return {
    runners,
    loadManifest: vi.fn(async () => MANIFEST),
    createRunners: vi.fn(() => runners),
    resolveReviewer: vi.fn(() => REVIEWER),
    getHeadRef: vi.fn(() => 'sandcastle/issue-42'),
    materialiseHead: vi.fn(),
    verifyPushed: vi.fn(() => [] as string[]),
    sandboxProvider: { name: 'fake' } as never,
  };
}

function call(d: ReturnType<typeof deps>, prNumber = '9') {
  return forgeReview({
    prNumber,
    loadManifest: d.loadManifest,
    createRunners: d.createRunners as never,
    resolveReviewer: d.resolveReviewer,
    getHeadRef: d.getHeadRef,
    materialiseHead: d.materialiseHead,
    verifyPushed: d.verifyPushed,
    sandboxProvider: d.sandboxProvider,
  });
}

describe('forgeReview', () => {
  it('opens the sandbox on the PR head, reviews on the reviewer model, and pushes refinement commits', async () => {
    const d = deps([{ sha: 'r1' }, { sha: 'r2' }]);
    const outcome = await call(d);

    expect(d.getHeadRef).toHaveBeenCalledWith('9');
    // The workflow checks out main, so the PR head must be materialised as a
    // local branch before the sandbox opens (toon-meta#275 / connector#634).
    expect(d.materialiseHead).toHaveBeenCalledWith('sandcastle/issue-42');
    expect(d.runners.prepareForReview).toHaveBeenCalledWith(
      'sandcastle/issue-42'
    );
    expect(d.resolveReviewer).toHaveBeenCalledWith(MANIFEST);
    expect(d.runners.runReview).toHaveBeenCalledWith(
      REVIEWER,
      'sandcastle/issue-42'
    );
    expect(d.runners.exec).toHaveBeenCalledWith(
      'git push origin sandcastle/issue-42'
    );
    expect(d.verifyPushed).toHaveBeenCalledWith(
      ['r1', 'r2'],
      'sandcastle/issue-42'
    );
    expect(outcome).toEqual({
      branch: 'sandcastle/issue-42',
      pushedCommits: 2,
    });
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('makes no push when the reviewer produced no commits', async () => {
    const d = deps([]);
    const outcome = await call(d);

    expect(d.runners.exec).not.toHaveBeenCalled();
    expect(d.verifyPushed).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      branch: 'sandcastle/issue-42',
      pushedCommits: 0,
    });
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('fails loud when a reviewer commit did not land on the remote branch', async () => {
    const d = deps([{ sha: 'r1' }]);
    d.verifyPushed.mockReturnValueOnce(['r1']);

    await expect(call(d)).rejects.toThrow(/NOT on origin/);
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('fails loud when the push itself fails', async () => {
    const d = deps([{ sha: 'r1' }]);
    d.runners.exec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'auth failed',
    });

    await expect(call(d)).rejects.toThrow(/git push .* failed/);
    expect(d.verifyPushed).not.toHaveBeenCalled();
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('closes the sandbox even when review throws', async () => {
    const d = deps([{ sha: 'r1' }]);
    d.runners.runReview.mockRejectedValueOnce(new Error('boom'));

    await expect(call(d)).rejects.toThrow('boom');
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-numeric PR number before touching any sandbox', async () => {
    const d = deps();
    await expect(call(d, 'abc')).rejects.toThrow(/numeric/);
    expect(d.loadManifest).not.toHaveBeenCalled();
    expect(d.createRunners).not.toHaveBeenCalled();
  });
});
