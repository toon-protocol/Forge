/**
 * `forge new` — parse `forge new <archetype>` / `forge new --blank` (plus
 * `--repo`/`--dir`/environment/`--dry-run` flags) and resolve them into a
 * single validated in-memory `StampPlan` (FACTORY_SPEC.md §2-§3). This
 * module writes no files and opens no PR itself — `cli.ts` hands the
 * resolved plan to the sibling stamping engine (`stamp.ts`, #27); opening
 * the `FACTORY.md` registration PR is #28. The deliverable here is a
 * resolved plan, built from `FactorySection`/`EnvironmentSection` so it
 * matches exactly what forge-core's manifest surface consumes downstream —
 * `--dry-run` prints it (`formatStampPlan`) instead of stamping.
 *
 * `parseNewArgs`/`resolveStampPlan` are pure/injectable (no `gh` call) so
 * they're unit-testable directly. `fetchArchetypeCatalog` is the one real
 * `gh` seam (reads `toon-meta/FACTORY.md`'s archetype catalog, §2.1) — like
 * `run.ts`'s `fetchIssueTitle`, it's a thin, untested-by-design shim; the
 * markdown-table parsing it delegates to (`parseArchetypeCatalog`) is pure
 * and unit-tested against a fixture instead.
 */
import { execFileSync } from 'node:child_process';
import type {
  EnvironmentKind,
  EnvironmentSection,
  FactorySection,
} from '@toon-protocol/forge-core';

const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'node-pnpm',
  'npm-workspaces',
  'docs',
  'bevy-spacetime',
  'bevy-spacetime-gpu',
];

const NODE_ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'node-pnpm',
  'npm-workspaces',
];

/** One row of `toon-meta/FACTORY.md`'s archetype catalog (§2.1). */
export interface ArchetypeCatalogEntry {
  readonly name: string;
  readonly environment: EnvironmentKind;
  readonly minted: boolean;
}

/** The resolved output of `forge new`: what the (sibling) stamping engine consumes. */
export interface StampPlan {
  readonly factory: FactorySection;
  readonly environment: EnvironmentSection;
  readonly targetDir: string;
}

/** `forge new <archetype>` / `forge new --blank`, parsed into typed fields. */
export interface ParsedNewArgs {
  readonly archetype?: string;
  readonly blank: boolean;
  readonly repo?: string;
  readonly dir: string;
  readonly kind?: EnvironmentKind;
  readonly node?: string;
  readonly lockfile?: string;
  readonly devbox: boolean;
  readonly dryRun: boolean;
}

const FLAGS_WITH_VALUES = [
  '--repo',
  '--dir',
  '--kind',
  '--node',
  '--lockfile',
] as const;

/**
 * Parses `forge new` argv into {@link ParsedNewArgs}. Pure — throws
 * `Error` on malformed usage, does no I/O and touches no registry.
 */
export function parseNewArgs(argv: readonly string[]): ParsedNewArgs {
  const values: Record<string, string> = {};
  let blank = false;
  let devbox = false;
  let dryRun = false;
  const positionals: string[] = [];

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === '--blank') {
      blank = true;
      continue;
    }
    if (arg === '--devbox') {
      devbox = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if ((FLAGS_WITH_VALUES as readonly string[]).includes(arg)) {
      const value = rest.shift();
      if (value === undefined) {
        throw new Error(`forge new: ${arg} requires a value`);
      }
      values[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`forge new: unknown flag "${arg}"`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new Error(
      `forge new: expected a single <archetype> positional (got ${positionals.join(', ')})`
    );
  }
  const archetype = positionals[0];

  if (blank && archetype !== undefined) {
    throw new Error(
      'forge new: --blank and <archetype> are mutually exclusive (§2.1)'
    );
  }
  if (!blank && archetype === undefined) {
    throw new Error(
      'forge new: usage: forge new <archetype> | forge new --blank'
    );
  }

  const kind = values.kind;
  if (
    kind !== undefined &&
    !ENVIRONMENT_KINDS.includes(kind as EnvironmentKind)
  ) {
    throw new Error(
      `forge new: --kind must be one of ${ENVIRONMENT_KINDS.join(' | ')} (§3)`
    );
  }

  return {
    archetype,
    blank,
    repo: values.repo,
    dir: values.dir ?? '.',
    kind: kind as EnvironmentKind | undefined,
    node: values.node,
    lockfile: values.lockfile,
    devbox,
    dryRun,
  };
}

function buildEnvironmentSection(
  kind: EnvironmentKind,
  args: ParsedNewArgs
): EnvironmentSection {
  const isNodeKind = NODE_ENVIRONMENT_KINDS.includes(kind);
  if (isNodeKind && args.node === undefined) {
    throw new Error(
      `forge new: --node is required for environment kind "${kind}" (§3, §8.8)`
    );
  }
  if (!isNodeKind && args.node !== undefined) {
    throw new Error(
      `forge new: --node MUST NOT be given for environment kind "${kind}" (§3, §8.8)`
    );
  }
  if (args.lockfile === undefined) {
    throw new Error('forge new: --lockfile is required (§3)');
  }
  return {
    kind,
    node: isNodeKind ? args.node : undefined,
    lockfile: args.lockfile,
    devbox: args.devbox,
  };
}

export interface ResolveStampPlanDeps {
  readonly fetchArchetypeCatalog?: () => Promise<
    readonly ArchetypeCatalogEntry[]
  >;
}

/**
 * Resolves parsed `forge new` args into a {@link StampPlan}. Pure aside from
 * the injected catalog fetch — no files are written, no PR is opened.
 */
export async function resolveStampPlan(
  args: ParsedNewArgs,
  deps: ResolveStampPlanDeps = {}
): Promise<StampPlan> {
  if (args.repo === undefined) {
    throw new Error('forge new: --repo <owner/repo> is required');
  }
  const repoMatch = /^[^/\s]+\/([^/\s]+)$/.exec(args.repo);
  const name = repoMatch?.[1];
  if (name === undefined) {
    throw new Error('forge new: --repo must be "owner/repo" (§2)');
  }

  let archetype: string;
  let kind: EnvironmentKind;

  if (args.blank) {
    archetype = 'blank';
    if (args.kind === undefined) {
      throw new Error(
        'forge new --blank: --kind is required (no archetype opinion to derive it from, §2.1)'
      );
    }
    kind = args.kind;
  } else {
    const fetchArchetypeCatalogFn =
      deps.fetchArchetypeCatalog ?? fetchArchetypeCatalog;
    const catalog = await fetchArchetypeCatalogFn();
    const entry = catalog.find((e) => e.name === args.archetype);
    if (!entry || !entry.minted) {
      const minted = catalog
        .filter((e) => e.minted)
        .map((e) => e.name)
        .join(', ');
      throw new Error(
        `forge new: "${args.archetype}" is not a minted archetype in toon-meta/FACTORY.md's ` +
          `catalog (§2.1). Minted archetypes: ${minted || '(none)'}. Use --blank for a bare environment.`
      );
    }
    if (args.kind !== undefined && args.kind !== entry.environment) {
      throw new Error(
        `forge new: --kind "${args.kind}" conflicts with archetype "${args.archetype}"'s ` +
          `pinned environment "${entry.environment}" — alternate opinions are new archetypes, not flags (§2.1)`
      );
    }
    archetype = entry.name;
    kind = entry.environment;
  }

  const environment = buildEnvironmentSection(kind, args);
  const factory: FactorySection = { name, repo: args.repo, archetype };

  return { factory, environment, targetDir: args.dir };
}

/**
 * Parses `toon-meta/FACTORY.md`'s archetype-catalog markdown table (§2.1)
 * into typed rows. Looks for a table whose header row mentions "archetype"
 * and "status"; a status of exactly `"minted"` (case-insensitive) marks a
 * row minted — any other status (e.g. `"mint-after-pilot"`, matching
 * `templates/archetypes/*\/archetype.toml`'s `status` field) is unminted.
 */
export function parseArchetypeCatalog(
  markdown: string
): ArchetypeCatalogEntry[] {
  const lines = markdown.split('\n');
  const entries: ArchetypeCatalogEntry[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());

    if (!inTable) {
      const header = cells.map((c) => c.toLowerCase());
      if (header.includes('archetype') && header.includes('status')) {
        inTable = true;
      }
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) {
      continue; // header separator row
    }
    const [name, environment, status] = cells;
    if (!name || !environment || !status) continue;
    entries.push({
      name,
      environment: environment as EnvironmentKind,
      minted: status.toLowerCase() === 'minted',
    });
  }

  return entries;
}

/** Reads `toon-meta/FACTORY.md` via the host `gh` and parses its archetype catalog. */
export function fetchArchetypeCatalog(): Promise<ArchetypeCatalogEntry[]> {
  const content = execFileSync(
    'gh',
    [
      'api',
      'repos/toon-protocol/toon-meta/contents/FACTORY.md',
      '--jq',
      '.content',
    ],
    { encoding: 'utf-8' }
  ).trim();
  const markdown = Buffer.from(content, 'base64').toString('utf-8');
  return Promise.resolve(parseArchetypeCatalog(markdown));
}

/** Pretty-prints a resolved {@link StampPlan} (the "dry-run" output this slice delivers). */
export function formatStampPlan(plan: StampPlan): string {
  return JSON.stringify(plan, null, 2);
}
