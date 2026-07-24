/**
 * The registration-PR opener (Forge#28) — the last leg of `forge new`: after
 * a factory tree is stamped (`stamp.ts`, Forge#27), open a PR against
 * `toon-meta/FACTORY.md` adding the new factory's row to the per-repo
 * factory table (`## Per-repo factory table`). This enforces the
 * authority/capability split from Forge#10 — `forge new` stamps *and*
 * registers, but `toon-meta/FACTORY.md` stays authoritative
 * (FACTORY_SPEC.md §8.2: unregistered → does not exist).
 *
 * Row fields are derived from the stamped `FactoryManifest` (`factory.name`,
 * `[environment]`, `[loop]`, `[[oracle.tier]]`) — no fields are invented.
 * `buildFactoryRow`/`isFactoryRegistered`/`insertFactoryRow`/PR title+body
 * are pure text transforms over markdown, unit-tested directly against a
 * fixture; `registerFactory`'s `gh` dependency is fully injectable (default
 * implementation shells out to the real `gh`, same untested-by-design
 * convention as `new.ts`'s `fetchArchetypeCatalog` / `sandcastle-runners.ts`'s
 * `defaultGhClient`), so the create-branch/insert-row/open-PR flow and its
 * idempotency (no duplicate PR for an already-registered `factory.name`, and
 * no duplicate PR when one is already open on the registration branch) are
 * unit-verifiable with a mocked `gh` client — no live PR in tests.
 */
import { execFileSync } from 'node:child_process';
import type {
  EnvironmentKind,
  FactoryManifest,
  OracleTier,
} from '@toon-protocol/forge-core';
import type { PullRequestRef } from '@toon-protocol/forge-core';
import { splitTableRowCells } from './markdown-table.js';

/** `toon-meta` is the org's single source of truth for the factory registry (FACTORY_SPEC.md §8.2). */
const REGISTRY_REPO = 'toon-protocol/toon-meta';
const REGISTRY_PATH = 'FACTORY.md';
const REGISTRY_BASE_BRANCH = 'main';

const SECTION_HEADING = '## Per-repo factory table';

/**
 * Escapes `|` so a value is safe inside a markdown table cell. Exported so
 * `validate.ts` can build the same escaped form the registered row's pin
 * cells carry before comparing (§8.3 — registry parity).
 */
export function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

/**
 * Maps an environment kind to the `Pkg mgr` column's existing vocabulary
 * (see toon-meta/FACTORY.md's table). Exported: `validate.ts` (Forge#11)
 * recomputes this same value from the local manifest to check it against
 * the registered row's pin (§8.3 — registry parity).
 */
export function pkgMgrLabel(kind: EnvironmentKind): string {
  switch (kind) {
    case 'node-pnpm':
      return 'pnpm';
    case 'npm-workspaces':
      return 'npm workspaces';
    case 'docs':
      return 'npm (docs)';
    case 'bevy-spacetime':
    case 'bevy-spacetime-gpu':
      return 'cargo';
  }
}

/**
 * Joins the manifest's PR-surfaced oracle tiers' `run` commands — the
 * `Gate` column's existing "lint / typecheck / test / build" shape.
 * Exported for the same reason as {@link pkgMgrLabel}.
 */
export function gateSummary(tiers: readonly OracleTier[]): string {
  return tiers
    .filter((t) => t.surfaces.includes('pr'))
    .map((t) => t.run)
    .join(' / ');
}

/** Builds this factory's `| Repo | Pkg mgr | Template | Gate | Status | Merged-PR proof | Notes |` row from its stamped manifest. */
export function buildFactoryRow(manifest: FactoryManifest): string {
  const cells = [
    manifest.factory.name,
    pkgMgrLabel(manifest.environment.kind),
    manifest.loop.template,
    gateSummary(manifest.oracleTiers),
    'Scaffolded via `forge new` — image-build + dry-run plan proofs pending',
    '—',
    `Archetype: \`${manifest.factory.archetype}\`.`,
  ].map(escapeCell);
  return `| ${cells.join(' | ')} |`;
}

function sectionBounds(lines: readonly string[]): {
  start: number;
  end: number;
} {
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  if (start === -1) {
    throw new Error(
      `toon-meta/FACTORY.md: could not find "${SECTION_HEADING}" heading`
    );
  }
  const afterHeading = lines.slice(start + 1);
  const nextHeadingOffset = afterHeading.findIndex((l) => l.startsWith('## '));
  const end =
    nextHeadingOffset === -1 ? lines.length : start + 1 + nextHeadingOffset;
  return { start, end };
}

function firstCell(line: string): string | undefined {
  return splitTableRowCells(line)?.[0];
}

function lastTableRowIndex(
  lines: readonly string[],
  start: number,
  end: number
): number {
  const section = lines.slice(start, end);
  let lastOffset = -1;
  for (const [offset, line] of section.entries()) {
    if (line.trim().startsWith('|')) lastOffset = offset;
  }
  if (lastOffset === -1) {
    throw new Error(
      `toon-meta/FACTORY.md: no table rows found under "${SECTION_HEADING}"`
    );
  }
  return start + lastOffset;
}

/** True if the `## Per-repo factory table` section already has a row keyed by `name` — the idempotency check (AC "re-running opens no duplicate PR"). */
export function isFactoryRegistered(markdown: string, name: string): boolean {
  const lines = markdown.split('\n');
  const { start, end } = sectionBounds(lines);
  return lines.slice(start, end).some((l) => firstCell(l) === name);
}

/**
 * Returns the `## Per-repo factory table` row cells keyed by `name`, or
 * `undefined` if no such row exists. Used by `validate.ts` (Forge#11) to
 * check the registered row's pins (Pkg mgr / Template / Gate) against the
 * local manifest — registry parity, §8.3.
 */
export function findFactoryRowCells(
  markdown: string,
  name: string
): readonly string[] | undefined {
  const lines = markdown.split('\n');
  const { start, end } = sectionBounds(lines);
  for (const line of lines.slice(start, end)) {
    const cells = splitTableRowCells(line);
    if (cells && cells[0] === name) return cells;
  }
  return undefined;
}

/** Inserts `row` immediately after the last existing row of the `## Per-repo factory table` section. Pure — returns the updated document text. */
export function insertFactoryRow(markdown: string, row: string): string {
  const lines = markdown.split('\n');
  const { start, end } = sectionBounds(lines);
  const insertAt = lastTableRowIndex(lines, start, end) + 1;
  return [...lines.slice(0, insertAt), row, ...lines.slice(insertAt)].join(
    '\n'
  );
}

/** The deterministic registration-branch name for a factory, mirroring `sandcastle-runners.ts`'s `branchForIssue` convention. */
export function branchForRegistration(name: string): string {
  return `forge-register/${name}`;
}

export function formatRegistrationPrTitle(manifest: FactoryManifest): string {
  return `FACTORY.md: register ${manifest.factory.name}`;
}

export function formatRegistrationPrBody(manifest: FactoryManifest): string {
  return [
    `Registers \`${manifest.factory.name}\` (\`${manifest.factory.repo}\`) in the per-repo factory table.`,
    '',
    `Stamped via \`forge new\` — archetype \`${manifest.factory.archetype}\`, environment \`${manifest.environment.kind}\`.`,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

/** A minimal GitHub client for the registration PR's create-branch/edit-file/open-PR steps (no agent — plain plumbing, same convention as `sandcastle-runners.ts`'s `GhClient`). */
export interface RegistryGhClient {
  readonly getFile: () => Promise<{
    readonly content: string;
    readonly sha: string;
  }>;
  readonly getBaseSha: () => Promise<string>;
  readonly createBranch: (branch: string, sha: string) => Promise<void>;
  readonly updateFile: (args: {
    readonly branch: string;
    readonly content: string;
    readonly sha: string;
    readonly message: string;
  }) => Promise<void>;
  readonly prList: (args: {
    readonly head: string;
    readonly state: 'open' | 'all';
  }) => Promise<readonly PullRequestRef[]>;
  readonly prCreate: (args: {
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
}

function decodeBase64(content: string): string {
  return Buffer.from(content, 'base64').toString('utf-8');
}

const defaultRegistryGhClient: RegistryGhClient = {
  async getFile() {
    const json = execFileSync(
      'gh',
      ['api', `repos/${REGISTRY_REPO}/contents/${REGISTRY_PATH}`],
      { encoding: 'utf-8' }
    );
    const parsed = JSON.parse(json) as { content: string; sha: string };
    return { content: decodeBase64(parsed.content), sha: parsed.sha };
  },
  async getBaseSha() {
    return execFileSync(
      'gh',
      [
        'api',
        `repos/${REGISTRY_REPO}/git/refs/heads/${REGISTRY_BASE_BRANCH}`,
        '--jq',
        '.object.sha',
      ],
      { encoding: 'utf-8' }
    ).trim();
  },
  async createBranch(branch, sha) {
    execFileSync(
      'gh',
      [
        'api',
        `repos/${REGISTRY_REPO}/git/refs`,
        '-f',
        `ref=refs/heads/${branch}`,
        '-f',
        `sha=${sha}`,
      ],
      { stdio: 'inherit' }
    );
  },
  async updateFile({ branch, content, sha, message }) {
    execFileSync(
      'gh',
      [
        'api',
        `repos/${REGISTRY_REPO}/contents/${REGISTRY_PATH}`,
        '-X',
        'PUT',
        '-f',
        `message=${message}`,
        '-f',
        `content=${Buffer.from(content, 'utf-8').toString('base64')}`,
        '-f',
        `branch=${branch}`,
        '-f',
        `sha=${sha}`,
      ],
      { stdio: 'inherit' }
    );
  },
  async prList({ head, state }) {
    const json = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        REGISTRY_REPO,
        '--head',
        head,
        '--state',
        state,
        '--json',
        'number,url',
      ],
      { encoding: 'utf-8' }
    );
    return JSON.parse(json) as PullRequestRef[];
  },
  async prCreate({ base, head, title, body }) {
    execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        REGISTRY_REPO,
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body',
        body,
      ],
      { stdio: 'inherit' }
    );
  },
};

export interface RegisterFactoryDeps {
  readonly gh?: RegistryGhClient;
  readonly branchName?: (name: string) => string;
}

/** The outcome of `registerFactory`: whether the factory was already registered/has an open PR, and the PR (if one is open). */
export interface RegistrationResult {
  /** `factory.name` already had a row in `FACTORY.md` on the base branch — no PR was opened. */
  readonly alreadyRegistered: boolean;
  /** A new registration PR was opened by this call (vs. an already-open one being reused). */
  readonly opened: boolean;
  readonly pr?: PullRequestRef;
}

/**
 * Opens (or reuses) the registration PR for a stamped factory. Idempotent:
 * an already-registered `factory.name` opens no PR, and an already-open
 * registration PR is returned rather than duplicated.
 */
export async function registerFactory(
  manifest: FactoryManifest,
  deps: RegisterFactoryDeps = {}
): Promise<RegistrationResult> {
  const gh = deps.gh ?? defaultRegistryGhClient;
  const branchNameFn = deps.branchName ?? branchForRegistration;
  const branch = branchNameFn(manifest.factory.name);

  const [openPr] = await gh.prList({ head: branch, state: 'open' });
  if (openPr) {
    return { alreadyRegistered: false, opened: false, pr: openPr };
  }

  const file = await gh.getFile();
  if (isFactoryRegistered(file.content, manifest.factory.name)) {
    return { alreadyRegistered: true, opened: false };
  }

  const baseSha = await gh.getBaseSha();
  await gh.createBranch(branch, baseSha);

  await gh.updateFile({
    branch,
    content: insertFactoryRow(file.content, buildFactoryRow(manifest)),
    sha: file.sha,
    message: `FACTORY.md: register ${manifest.factory.name}`,
  });

  await gh.prCreate({
    base: REGISTRY_BASE_BRANCH,
    head: branch,
    title: formatRegistrationPrTitle(manifest),
    body: formatRegistrationPrBody(manifest),
  });

  const [pr] = await gh.prList({ head: branch, state: 'open' });
  if (!pr) {
    throw new Error(
      `forge new: registration PR create reported success, but no OPEN PR exists for branch ` +
        `'${branch}' on ${REGISTRY_REPO} — the branch push and/or gh pr create likely failed silently.`
    );
  }

  return { alreadyRegistered: false, opened: true, pr };
}
