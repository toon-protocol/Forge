import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhClient, PullRequestRef } from '@toon-protocol/forge-core';
import { ManifestValidationError } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import { stamp } from './stamp.js';
import {
  branchForUpgrade,
  forgeUpgrade,
  formatUpgradePrBody,
  formatUpgradePrTitle,
} from './upgrade.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

function blankPlan(targetDir: string): StampPlan {
  return {
    factory: {
      name: 'widget',
      repo: 'toon-protocol/widget',
      archetype: 'blank',
    },
    environment: {
      kind: 'node-pnpm',
      node: '22',
      lockfile: 'pnpm-lock.yaml',
      devbox: false,
    },
    targetDir,
  };
}

function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd: dir,
    encoding: 'utf-8',
  });
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '-m',
    message,
  ]);
}

/** Sets up `targetDir` as a git repo on `main` with a local bare `origin`, stamps a clean blank factory into it, and commits the baseline. */
async function initStampedRepo(): Promise<{
  readonly targetDir: string;
  readonly originDir: string;
}> {
  const targetDir = await tempDir('forge-upgrade-target-');
  const originDir = await tempDir('forge-upgrade-origin-');
  git(originDir, ['init', '-q', '--bare']);
  git(targetDir, ['init', '-q', '-b', 'main']);
  git(targetDir, ['remote', 'add', 'origin', originDir]);

  await stamp(blankPlan(targetDir));
  commitAll(targetDir, 'chore: initial stamp');

  return { targetDir, originDir };
}

function ghStub(
  openBefore: readonly PullRequestRef[],
  openAfter: readonly PullRequestRef[]
): GhClient {
  let calls = 0;
  return {
    prList: vi.fn(async () => {
      calls += 1;
      return calls === 1 ? openBefore : openAfter;
    }),
    prCreate: vi.fn(async () => {}),
  };
}

describe('forgeUpgrade — no diff', () => {
  it('opens no PR and touches no branch when re-stamping is byte-identical', async () => {
    const { targetDir } = await initStampedRepo();
    const gh = ghStub([], []);

    const result = await forgeUpgrade({ targetDir, gh });

    expect(result.changed).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.pr).toBeUndefined();
    expect(gh.prList).not.toHaveBeenCalled();
    expect(gh.prCreate).not.toHaveBeenCalled();
    expect(git(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'main'
    );
  });
});

describe('forgeUpgrade — diff, no existing PR', () => {
  it('regenerates the stale file, branches, commits, pushes, and opens a PR', async () => {
    const { targetDir, originDir } = await initStampedRepo();

    // Simulate a repo stamped before a template change: hand-stale one of
    // the verbatim-copied .sandcastle files, committed as the "current"
    // baseline `forge upgrade` must repair.
    await writeFile(
      join(targetDir, '.sandcastle', 'plan-prompt.md'),
      'stale pre-template-change content\n',
      'utf-8'
    );
    commitAll(targetDir, 'chore: simulate drift');

    const pr: PullRequestRef = { number: 7, url: 'https://example/pr/7' };
    const gh = ghStub([], [pr]);

    const result = await forgeUpgrade({ targetDir, gh });

    expect(result.changed).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.pr).toEqual(pr);
    expect(result.files).toContain('.sandcastle/plan-prompt.md');

    expect(gh.prCreate).toHaveBeenCalledTimes(1);
    expect(gh.prCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        base: 'main',
        head: branchForUpgrade('widget'),
      })
    );

    expect(git(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      branchForUpgrade('widget')
    );
    const remoteRefs = git(originDir, ['show-ref']);
    expect(remoteRefs).toContain(`refs/heads/${branchForUpgrade('widget')}`);
  });
});

describe('forgeUpgrade — diff, PR already open', () => {
  it('reuses the existing open PR and never branches locally', async () => {
    const { targetDir } = await initStampedRepo();
    await writeFile(
      join(targetDir, '.sandcastle', 'plan-prompt.md'),
      'stale pre-template-change content\n',
      'utf-8'
    );
    commitAll(targetDir, 'chore: simulate drift');

    const existing: PullRequestRef = { number: 3, url: 'https://example/pr/3' };
    const gh = ghStub([existing], [existing]);

    const result = await forgeUpgrade({ targetDir, gh });

    expect(result.changed).toBe(true);
    expect(result.opened).toBe(false);
    expect(result.pr).toEqual(existing);
    expect(gh.prCreate).not.toHaveBeenCalled();
    // No branch/commit/push happened — HEAD is still main.
    expect(git(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'main'
    );
  });
});

describe('forgeUpgrade — post-stamp validation failure', () => {
  it('propagates the validation error and never touches git/gh', async () => {
    const { targetDir } = await initStampedRepo();
    const gh = ghStub([], []);

    await expect(
      forgeUpgrade({
        targetDir,
        gh,
        validateStampedOutput: async () => {
          throw new ManifestValidationError(['boom']);
        },
      })
    ).rejects.toThrow(ManifestValidationError);

    expect(gh.prList).not.toHaveBeenCalled();
  });
});

describe('forgeUpgrade — post-stamp validation warnings', () => {
  it('surfaces non-failing warnings from the post-stamp self-check on a no-diff regen', async () => {
    const { targetDir } = await initStampedRepo();
    const gh = ghStub([], []);

    const result = await forgeUpgrade({
      targetDir,
      gh,
      validateStampedOutput: async (plan) => ({
        manifest: (await stamp(plan)).manifest,
        warnings: [
          'model divergence: [loop.models].planner diverges from org policy',
        ],
      }),
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([
      'model divergence: [loop.models].planner diverges from org policy',
    ]);
  });
});

describe('branchForUpgrade / PR title / PR body', () => {
  it('names a deterministic per-factory upgrade branch', () => {
    expect(branchForUpgrade('widget')).toBe('forge-upgrade/widget');
  });

  it('formats a title and body naming the factory and changed files', async () => {
    const { targetDir } = await initStampedRepo();
    const { manifest } = await stamp(blankPlan(targetDir));

    expect(formatUpgradePrTitle(manifest)).toContain('widget');
    const body = formatUpgradePrBody(manifest, ['.sandcastle/plan-prompt.md']);
    expect(body).toContain('.sandcastle/plan-prompt.md');
    expect(body).toContain('ordinary PR');
  });
});
