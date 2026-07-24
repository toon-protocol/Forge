import { describe, expect, it } from 'vitest';
import {
  parseNewArgs,
  resolveStampPlan,
  parseArchetypeCatalog,
  formatStampPlan,
  type ArchetypeCatalogEntry,
} from './new.js';

describe('parseNewArgs', () => {
  it('parses a positional archetype plus flags', () => {
    const args = parseNewArgs([
      'game',
      '--repo',
      'toon-protocol/asteroids',
      '--dir',
      './out',
      '--node',
      '22',
      '--lockfile',
      'pnpm-lock.yaml',
      '--devbox',
    ]);
    expect(args).toEqual({
      archetype: 'game',
      blank: false,
      repo: 'toon-protocol/asteroids',
      dir: './out',
      kind: undefined,
      node: '22',
      lockfile: 'pnpm-lock.yaml',
      devbox: true,
      dryRun: false,
    });
  });

  it('parses --blank with no archetype positional', () => {
    const args = parseNewArgs(['--blank', '--repo', 'toon-protocol/lib']);
    expect(args.blank).toBe(true);
    expect(args.archetype).toBeUndefined();
    expect(args.dir).toBe('.');
    expect(args.devbox).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('parses --dry-run', () => {
    const args = parseNewArgs([
      '--blank',
      '--repo',
      'toon-protocol/lib',
      '--dry-run',
    ]);
    expect(args.dryRun).toBe(true);
  });

  it('rejects --blank combined with an archetype positional', () => {
    expect(() => parseNewArgs(['game', '--blank'])).toThrow(
      /mutually exclusive/
    );
  });

  it('rejects neither an archetype nor --blank', () => {
    expect(() => parseNewArgs([])).toThrow(/usage: forge new/);
  });

  it('rejects more than one positional', () => {
    expect(() => parseNewArgs(['game', 'service'])).toThrow(
      /single <archetype> positional/
    );
  });

  it('rejects an unknown flag', () => {
    expect(() => parseNewArgs(['game', '--wat'])).toThrow(/unknown flag/);
  });

  it('rejects a value-flag with no value', () => {
    expect(() => parseNewArgs(['game', '--repo'])).toThrow(/requires a value/);
  });

  it('rejects an invalid --kind', () => {
    expect(() => parseNewArgs(['--blank', '--kind', 'bogus'])).toThrow(
      /--kind must be one of/
    );
  });
});

describe('resolveStampPlan', () => {
  const CATALOG: readonly ArchetypeCatalogEntry[] = [
    { name: 'game', environment: 'bevy-spacetime', minted: true },
    { name: 'service', environment: 'node-pnpm', minted: true },
    { name: 'spa', environment: 'node-pnpm', minted: false },
  ];
  const fetchArchetypeCatalog = async () => CATALOG;

  it('resolves --blank with an explicit --kind, applying no archetype opinions', async () => {
    const plan = await resolveStampPlan(
      parseNewArgs([
        '--blank',
        '--repo',
        'toon-protocol/widget',
        '--kind',
        'node-pnpm',
        '--node',
        '22',
        '--lockfile',
        'pnpm-lock.yaml',
      ]),
      { fetchArchetypeCatalog }
    );
    expect(plan).toEqual({
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
      targetDir: '.',
    });
  });

  it('requires --kind for --blank (no archetype opinion to derive it from)', async () => {
    await expect(
      resolveStampPlan(
        parseNewArgs(['--blank', '--repo', 'toon-protocol/widget']),
        { fetchArchetypeCatalog }
      )
    ).rejects.toThrow(/--kind is required/);
  });

  it('resolves a minted archetype, deriving environment kind from the catalog', async () => {
    const plan = await resolveStampPlan(
      parseNewArgs([
        'game',
        '--repo',
        'toon-protocol/asteroids',
        '--lockfile',
        'pnpm-lock.yaml',
      ]),
      { fetchArchetypeCatalog }
    );
    expect(plan.factory).toEqual({
      name: 'asteroids',
      repo: 'toon-protocol/asteroids',
      archetype: 'game',
    });
    expect(plan.environment.kind).toBe('bevy-spacetime');
    expect(plan.environment.node).toBeUndefined();
  });

  it('fails fast on an archetype the catalog has never minted', async () => {
    await expect(
      resolveStampPlan(parseNewArgs(['spa', '--repo', 'toon-protocol/site']), {
        fetchArchetypeCatalog,
      })
    ).rejects.toThrow(/"spa" is not a minted archetype/);
  });

  it('fails fast on an archetype absent from the catalog entirely', async () => {
    await expect(
      resolveStampPlan(
        parseNewArgs(['ghost', '--repo', 'toon-protocol/site']),
        { fetchArchetypeCatalog }
      )
    ).rejects.toThrow(/"ghost" is not a minted archetype/);
  });

  it("rejects a --kind that conflicts with the archetype's pinned environment", async () => {
    await expect(
      resolveStampPlan(
        parseNewArgs([
          'game',
          '--repo',
          'toon-protocol/asteroids',
          '--kind',
          'node-pnpm',
        ]),
        { fetchArchetypeCatalog }
      )
    ).rejects.toThrow(/alternate opinions are new archetypes, not flags/);
  });

  it('requires --repo', async () => {
    await expect(
      resolveStampPlan(parseNewArgs(['--blank', '--kind', 'docs']))
    ).rejects.toThrow(/--repo <owner\/repo> is required/);
  });

  it('requires --node for node-kind environments and rejects it for non-node kinds', async () => {
    await expect(
      resolveStampPlan(
        parseNewArgs([
          '--blank',
          '--repo',
          'toon-protocol/widget',
          '--kind',
          'node-pnpm',
          '--lockfile',
          'pnpm-lock.yaml',
        ])
      )
    ).rejects.toThrow(/--node is required/);

    await expect(
      resolveStampPlan(
        parseNewArgs([
          '--blank',
          '--repo',
          'toon-protocol/widget',
          '--kind',
          'docs',
          '--node',
          '22',
          '--lockfile',
          'pnpm-lock.yaml',
        ])
      )
    ).rejects.toThrow(/--node MUST NOT be given/);
  });
});

describe('parseArchetypeCatalog', () => {
  it('parses a markdown table of minted/unminted archetypes', () => {
    const markdown = `
# FACTORY.md

## Archetypes

| Archetype | Environment      | Status           |
|-----------|------------------|------------------|
| game      | bevy-spacetime   | mint-after-pilot |
| service   | node-pnpm        | minted           |

## Repos
`;
    expect(parseArchetypeCatalog(markdown)).toEqual([
      { name: 'game', environment: 'bevy-spacetime', minted: false },
      { name: 'service', environment: 'node-pnpm', minted: true },
    ]);
  });

  it('returns an empty catalog when there is no archetype table', () => {
    expect(parseArchetypeCatalog('# FACTORY.md\n\nno tables here\n')).toEqual(
      []
    );
  });
});

describe('formatStampPlan', () => {
  it('prints the plan as readable JSON', () => {
    const printed = formatStampPlan({
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
      targetDir: '.',
    });
    expect(JSON.parse(printed)).toMatchObject({ factory: { name: 'widget' } });
  });
});
