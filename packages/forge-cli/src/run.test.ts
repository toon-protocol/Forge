import { describe, expect, it, vi } from 'vitest';
import { forgeRun, sandboxSecrets, SANDBOX_READY_HOOKS } from './run.js';
import type { FactoryManifest } from '@toon-protocol/forge-core';

const MANIFEST = {
  factory: { name: 'Forge' },
} as unknown as FactoryManifest;

const PR = { number: 7, url: 'https://github.com/toon-protocol/Forge/pull/7' };

function fakeRunners() {
  return {
    runPlan: vi.fn(),
    runImplement: vi.fn(),
    exec: vi.fn(),
    runReview: vi.fn(),
    openPr: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

describe('sandboxSecrets', () => {
  it('passes through only the token keys that are set', () => {
    expect(sandboxSecrets({ GH_TOKEN: 't', FOO: 'x' })).toEqual({
      GH_TOKEN: 't',
    });
    expect(sandboxSecrets({})).toEqual({});
    expect(
      sandboxSecrets({ CLAUDE_CODE_OAUTH_TOKEN: 'c', GH_TOKEN: 'g' })
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'c', GH_TOKEN: 'g' });
  });
});

describe('SANDBOX_READY_HOOKS', () => {
  it('wires gh credential setup + a frozen install (deterministic push, toon-meta#235/#236)', () => {
    const cmds = SANDBOX_READY_HOOKS.sandbox!.onSandboxReady!.map(
      (h) => (h as { command: string }).command
    );
    expect(cmds[0]).toContain('gh auth setup-git');
    expect(cmds[0]).toContain('http.https://github.com/.extraheader');
    expect(cmds[1]).toContain('pnpm install --frozen-lockfile');
  });
});

describe('forgeRun', () => {
  function deps() {
    const runners = fakeRunners();
    return {
      runners,
      loadManifest: vi.fn(async () => MANIFEST),
      createRunners: vi.fn(() => runners),
      runCycle: vi.fn(async () => ({ pr: PR })),
      getIssueTitle: vi.fn(() => 'Fix the bug'),
      sandboxProvider: { name: 'fake' } as never,
    };
  }

  it('loads the manifest, drives the cycle for the issue, and returns the PR', async () => {
    const d = deps();
    const result = await forgeRun({
      issueNumber: '42',
      manifestPath: 'factory.toml',
      loadManifest: d.loadManifest,
      createRunners: d.createRunners as never,
      runCycle: d.runCycle as never,
      getIssueTitle: d.getIssueTitle,
      sandboxProvider: d.sandboxProvider,
    });

    expect(d.loadManifest).toHaveBeenCalledWith('factory.toml');
    expect(d.createRunners).toHaveBeenCalledWith({
      sandboxProvider: d.sandboxProvider,
      hooks: SANDBOX_READY_HOOKS,
    });

    const [issueArg, optsArg] = d.runCycle.mock.calls[0]!;
    expect(issueArg).toEqual({ id: '42', title: 'Fix the bug' });
    expect(optsArg.manifest).toBe(MANIFEST);
    expect(optsArg.runPlan).toBe(d.runners.runPlan);
    expect(optsArg.runImplement).toBe(d.runners.runImplement);
    expect(optsArg.exec).toBe(d.runners.exec);
    expect(optsArg.runReview).toBe(d.runners.runReview);
    expect(optsArg.openPr).toBe(d.runners.openPr);

    expect(result).toEqual(PR);
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('closes the sandbox even when the cycle throws', async () => {
    const d = deps();
    d.runCycle.mockRejectedValueOnce(new Error('boom'));
    await expect(
      forgeRun({
        issueNumber: '1',
        loadManifest: d.loadManifest,
        createRunners: d.createRunners as never,
        runCycle: d.runCycle as never,
        getIssueTitle: d.getIssueTitle,
        sandboxProvider: d.sandboxProvider,
      })
    ).rejects.toThrow('boom');
    expect(d.runners.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-numeric issue number before touching any sandbox', async () => {
    const d = deps();
    await expect(
      forgeRun({
        issueNumber: 'abc',
        loadManifest: d.loadManifest,
        createRunners: d.createRunners as never,
        runCycle: d.runCycle as never,
        getIssueTitle: d.getIssueTitle,
        sandboxProvider: d.sandboxProvider,
      })
    ).rejects.toThrow(/numeric/);
    expect(d.loadManifest).not.toHaveBeenCalled();
    expect(d.createRunners).not.toHaveBeenCalled();
  });
});
