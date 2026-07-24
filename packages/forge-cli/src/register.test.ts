import { describe, expect, it, vi } from 'vitest';
import type { FactoryManifest } from '@toon-protocol/forge-core';
import {
  buildFactoryRow,
  isFactoryRegistered,
  insertFactoryRow,
  branchForRegistration,
  formatRegistrationPrTitle,
  formatRegistrationPrBody,
  registerFactory,
} from './register.js';

const MANIFEST: FactoryManifest = {
  factory: { name: 'widget', repo: 'toon-protocol/widget', archetype: 'blank' },
  environment: {
    kind: 'node-pnpm',
    node: '22',
    lockfile: 'pnpm-lock.yaml',
    devbox: false,
  },
  loop: {
    template: 'parallel-planner-with-review',
    innerGates: ['t0-lint', 't1-typecheck'],
    contextCeiling: 0.6,
    models: {
      planner: 'claude-opus-4-8',
      merger: 'claude-opus-4-8',
      implementer: 'claude-sonnet-5',
      reviewer: 'claude-sonnet-5',
    },
  },
  oracleTiers: [
    {
      id: 't0-lint',
      run: 'pnpm lint',
      on: ['**/*.ts'],
      surfaces: ['inner', 'pr'],
      cost: 'cheap',
      protected: false,
    },
    {
      id: 't1-typecheck',
      run: 'pnpm typecheck',
      on: ['**/*.ts'],
      surfaces: ['inner', 'pr'],
      cost: 'cheap',
      protected: false,
    },
    {
      id: 't2-test',
      run: 'pnpm test',
      on: ['**/*.ts'],
      surfaces: ['pr'],
      cost: 'moderate',
      protected: false,
    },
    {
      id: 't3-build',
      run: 'pnpm build',
      on: ['**/*.ts'],
      surfaces: ['pr'],
      cost: 'moderate',
      protected: false,
    },
  ],
};

const FACTORY_MD = [
  '# FACTORY.md',
  '',
  '## Per-repo factory table',
  '',
  'Intro prose.',
  '',
  '| Repo  | Pkg mgr | Template | Gate | Status | Merged-PR proof | Notes |',
  '|-------|---------|----------|------|--------|------------------|-------|',
  '| relay | pnpm    | parallel-planner-with-review | eslint / typecheck / vitest / build | Live | — | Pilot. |',
  '| store | pnpm    | parallel-planner-with-review | typecheck / vitest / esbuild | Live | — | No lint. |',
  '',
  '## Kept workflows (not retired)',
  '',
  'More prose.',
  '',
].join('\n');

describe('buildFactoryRow', () => {
  it('derives every column from the stamped manifest', () => {
    const row = buildFactoryRow(MANIFEST);
    expect(row).toBe(
      '| widget | pnpm | parallel-planner-with-review | pnpm lint / pnpm typecheck / pnpm test / pnpm build | ' +
        'Scaffolded via `forge new` — image-build + dry-run plan proofs pending | — | Archetype: `blank`. |'
    );
  });

  it('escapes pipe characters in cells', () => {
    const manifest: FactoryManifest = {
      ...MANIFEST,
      oracleTiers: [
        {
          id: 't0',
          run: 'echo a | echo b',
          on: [],
          surfaces: ['pr'],
          cost: 'cheap',
          protected: false,
        },
      ],
    };
    expect(buildFactoryRow(manifest)).toContain('echo a \\| echo b');
  });

  it('maps every environment kind to a Pkg mgr label', () => {
    const kinds: Array<[FactoryManifest['environment']['kind'], string]> = [
      ['node-pnpm', 'pnpm'],
      ['npm-workspaces', 'npm workspaces'],
      ['docs', 'npm (docs)'],
      ['bevy-spacetime', 'cargo'],
      ['bevy-spacetime-gpu', 'cargo'],
    ];
    for (const [kind, label] of kinds) {
      const manifest: FactoryManifest = {
        ...MANIFEST,
        environment: { ...MANIFEST.environment, kind },
      };
      expect(buildFactoryRow(manifest)).toContain(`| ${label} |`);
    }
  });
});

describe('isFactoryRegistered', () => {
  it('is false for a name with no existing row', () => {
    expect(isFactoryRegistered(FACTORY_MD, 'widget')).toBe(false);
  });

  it('is true once the row exists', () => {
    const updated = insertFactoryRow(FACTORY_MD, buildFactoryRow(MANIFEST));
    expect(isFactoryRegistered(updated, 'widget')).toBe(true);
  });

  it('throws if the per-repo table heading is missing', () => {
    expect(() => isFactoryRegistered('# FACTORY.md\n', 'widget')).toThrow(
      /Per-repo factory table/
    );
  });
});

describe('insertFactoryRow', () => {
  it('appends the row after the last existing table row, leaving the rest of the doc untouched', () => {
    const row = buildFactoryRow(MANIFEST);
    const updated = insertFactoryRow(FACTORY_MD, row);
    const lines = updated.split('\n');

    expect(lines).toContain(row);
    const storeIdx = lines.indexOf(
      '| store | pnpm    | parallel-planner-with-review | typecheck / vitest / esbuild | Live | — | No lint. |'
    );
    expect(lines[storeIdx + 1]).toBe(row);
    expect(updated).toContain('## Kept workflows (not retired)');
    expect(updated).toContain('Intro prose.');
  });
});

describe('branchForRegistration', () => {
  it('is deterministic per factory name', () => {
    expect(branchForRegistration('widget')).toBe('forge-register/widget');
  });
});

describe('formatRegistrationPrTitle / formatRegistrationPrBody', () => {
  it('title names the factory', () => {
    expect(formatRegistrationPrTitle(MANIFEST)).toBe(
      'FACTORY.md: register widget'
    );
  });

  it('body cites the repo, archetype, and environment', () => {
    const body = formatRegistrationPrBody(MANIFEST);
    expect(body).toContain('`widget`');
    expect(body).toContain('`toon-protocol/widget`');
    expect(body).toContain('archetype `blank`');
    expect(body).toContain('environment `node-pnpm`');
  });
});

describe('registerFactory', () => {
  function fakeGh(overrides: Partial<ReturnType<typeof baseGh>> = {}) {
    return { ...baseGh(), ...overrides };
  }

  function baseGh() {
    return {
      prList: vi.fn(async () => []),
      getFile: vi.fn(async () => ({ content: FACTORY_MD, sha: 'file-sha' })),
      getBaseSha: vi.fn(async () => 'base-sha'),
      createBranch: vi.fn(async () => {}),
      updateFile: vi.fn(async () => {}),
      prCreate: vi.fn(async () => {}),
    };
  }

  it('creates a branch, inserts the row, and opens a PR when unregistered', async () => {
    const openedPr = {
      number: 9,
      url: 'https://github.com/toon-protocol/toon-meta/pull/9',
    };
    const gh = fakeGh({
      prList: vi
        .fn()
        .mockResolvedValueOnce([]) // no existing open PR yet
        .mockResolvedValueOnce([openedPr]), // fetched back after prCreate
    });

    const result = await registerFactory(MANIFEST, { gh: gh as never });

    expect(result).toEqual({
      alreadyRegistered: false,
      opened: true,
      pr: openedPr,
    });
    expect(gh.getFile).toHaveBeenCalledTimes(1);
    expect(gh.createBranch).toHaveBeenCalledWith(
      'forge-register/widget',
      'base-sha'
    );
    expect(gh.updateFile).toHaveBeenCalledTimes(1);
    const updateArgs = gh.updateFile.mock.calls[0]![0];
    expect(updateArgs.branch).toBe('forge-register/widget');
    expect(updateArgs.sha).toBe('file-sha');
    expect(updateArgs.content).toContain(buildFactoryRow(MANIFEST));
    expect(gh.prCreate).toHaveBeenCalledWith({
      base: 'main',
      head: 'forge-register/widget',
      title: 'FACTORY.md: register widget',
      body: formatRegistrationPrBody(MANIFEST),
    });
  });

  it('is idempotent: opens no PR when the row already exists', async () => {
    const registered = insertFactoryRow(FACTORY_MD, buildFactoryRow(MANIFEST));
    const gh = fakeGh({
      getFile: vi.fn(async () => ({ content: registered, sha: 'file-sha' })),
    });

    const result = await registerFactory(MANIFEST, { gh: gh as never });

    expect(result).toEqual({ alreadyRegistered: true, opened: false });
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.updateFile).not.toHaveBeenCalled();
    expect(gh.prCreate).not.toHaveBeenCalled();
  });

  it('is idempotent: reuses an already-open registration PR without re-creating it', async () => {
    const existingPr = {
      number: 5,
      url: 'https://github.com/toon-protocol/toon-meta/pull/5',
    };
    const gh = fakeGh({ prList: vi.fn(async () => [existingPr]) });

    const result = await registerFactory(MANIFEST, { gh: gh as never });

    expect(result).toEqual({
      alreadyRegistered: false,
      opened: false,
      pr: existingPr,
    });
    expect(gh.getFile).not.toHaveBeenCalled();
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.prCreate).not.toHaveBeenCalled();
  });

  it('fails loud if gh reports success but no PR is found afterward', async () => {
    const gh = fakeGh({ prList: vi.fn(async () => []) });

    await expect(
      registerFactory(MANIFEST, { gh: gh as never })
    ).rejects.toThrow(/no OPEN PR exists/);
  });

  it('honors a custom branchName function', async () => {
    const openedPr = {
      number: 3,
      url: 'https://github.com/toon-protocol/toon-meta/pull/3',
    };
    const gh = fakeGh({
      prList: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([openedPr]),
    });
    await registerFactory(MANIFEST, {
      gh: gh as never,
      branchName: (name) => `custom/${name}`,
    });
    expect(gh.prList).toHaveBeenCalledWith({
      head: 'custom/widget',
      state: 'open',
    });
    expect(gh.createBranch).toHaveBeenCalledWith('custom/widget', 'base-sha');
  });
});
