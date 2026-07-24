/**
 * `forge upgrade` (Forge#13, toon-meta#198 epic) — regenerates this repo's
 * stamped files from Forge's *current* `templates/` and lands them as an
 * ordinary PR through the repo's own gate. "Upgrade regenerates what `new`
 * stamped" (the issue's own blocked-by note): it re-runs the exact same
 * stamping engine (`stamp.ts`, Forge#27) over a `StampPlan` rebuilt from the
 * repo's *own* `factory.toml` (`[factory]` + `[environment]`, read via
 * forge-core's `loadManifest`) — no new resolution logic, no archetype
 * catalog lookup. This is how a substrate fix (toon-meta#202's model tiering
 * + handoff-prompt language is the poster child) becomes one template edit
 * fanned out to N gated PRs instead of an N-repo hand sweep
 * (FACTORY_SPEC.md §5.1: the manifest value a repo carries is authoritative
 * for `forge validate`, but `forge upgrade` is precisely the propagation
 * mechanism that value is meant to be upgraded *by* — an ordinary PR a human
 * reviews before merging, never a bypass).
 *
 * No privileged path: this writes a branch + PR through the same `gh pr
 * create` plumbing `register.ts`/`sandcastle-runners.ts` use, gated by
 * nothing but the repo's own `gate.yml` once the PR is open. Idempotent like
 * `register.ts`'s registration PR: an already-open `forge-upgrade/<name>`
 * branch's PR is reused rather than duplicated, and a no-diff regen opens no
 * PR at all.
 *
 * Every seam (`loadManifest`/`stamp`/`validateStampedOutput`/git/`gh`) is
 * injectable — defaults are the real forge-core calls, the real stamping
 * engine, and thin `execFileSync` shims over the host `git`/`gh`, so the
 * regenerate → diff → (maybe) branch/commit/push/PR flow is unit-testable
 * against a fixture tree with no live git repo or PR.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { FactoryManifest, GhClient } from '@toon-protocol/forge-core';
import { loadManifest as loadManifestDefault } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import type { StampDeps, StampResult } from './stamp.js';
import { defaultTemplatesRoot, stamp as stampDefault } from './stamp.js';
import type { PostStampValidation } from './validate-stamp.js';
import { validateStampedOutput as validateStampedOutputDefault } from './validate-stamp.js';

/** The deterministic upgrade-branch name for a factory, mirroring `register.ts`'s `branchForRegistration`. */
export function branchForUpgrade(factoryName: string): string {
  return `forge-upgrade/${factoryName}`;
}

export function formatUpgradePrTitle(manifest: FactoryManifest): string {
  return `forge upgrade: regenerate stamped files for "${manifest.factory.name}"`;
}

export function formatUpgradePrBody(
  manifest: FactoryManifest,
  files: readonly string[]
): string {
  return [
    `Regenerates this factory's stamped files from Forge's current \`templates/\` (\`forge upgrade\`).`,
    '',
    `Archetype: \`${manifest.factory.archetype}\`, environment: \`${manifest.environment.kind}\`.`,
    '',
    'Changed files:',
    ...files.map((f) => `- ${f}`),
    '',
    "This is an ordinary PR through this repo's own gate — no privileged path, no bypass.",
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

function formatUpgradeCommitMessage(manifest: FactoryManifest): string {
  return `forge upgrade: regenerate stamped files for ${manifest.factory.name}`;
}

/** The local-git operations `forgeUpgrade` needs — checkout/add/commit/push, plus a scoped changed-files check. */
export interface UpgradeGitClient {
  /** `git status --porcelain` scoped to `files`, returning only the ones that are actually dirty/untracked. */
  readonly changedFiles: (files: readonly string[]) => readonly string[];
  readonly checkoutBranch: (branch: string) => void;
  readonly add: (files: readonly string[]) => void;
  readonly commit: (message: string) => void;
  readonly push: (branch: string) => void;
}

function defaultGitClient(cwd: string): UpgradeGitClient {
  return {
    changedFiles(files) {
      if (files.length === 0) return [];
      const output = execFileSync(
        'git',
        ['status', '--porcelain', '--', ...files],
        { encoding: 'utf-8', cwd }
      );
      return output
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .sort();
    },
    checkoutBranch(branch) {
      execFileSync('git', ['checkout', '-b', branch], {
        cwd,
        stdio: 'inherit',
      });
    },
    add(files) {
      execFileSync('git', ['add', ...files], { cwd, stdio: 'inherit' });
    },
    commit(message) {
      // Scoped `-c` identity (not a global `git config` mutation) — this is
      // the first place forge-cli commits locally rather than via the GitHub
      // contents API (`register.ts`), same bot identity `golden-regen.yml`
      // uses for its own deterministic regen-and-PR commits.
      execFileSync(
        'git',
        [
          '-c',
          'user.name=toon-backlog-bot',
          '-c',
          'user.email=toon-backlog-bot@users.noreply.github.com',
          'commit',
          '-m',
          message,
        ],
        { cwd, stdio: 'inherit' }
      );
    },
    push(branch) {
      execFileSync('git', ['push', '-u', 'origin', branch], {
        cwd,
        stdio: 'inherit',
      });
    },
  };
}

function defaultGhClient(cwd: string): GhClient {
  return {
    async prList({ branch, state }) {
      const json = execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branch,
          '--state',
          state,
          '--json',
          'number,url',
        ],
        { encoding: 'utf-8', cwd }
      );
      return JSON.parse(json) as { number: number; url: string }[];
    },
    async prCreate({ base, head, title, body }) {
      execFileSync(
        'gh',
        [
          'pr',
          'create',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body',
          body,
        ],
        { cwd, stdio: 'inherit' }
      );
    },
  };
}

export interface ForgeUpgradeDeps {
  /** Path to the `factory.toml` to upgrade. Default: `"factory.toml"`. */
  readonly manifestPath?: string;
  /** Directory the factory tree lives in / is re-stamped into. Default: `"."`. */
  readonly targetDir?: string;
  readonly baseBranch?: string;
  readonly branchName?: (factoryName: string) => string;
  readonly loadManifest?: (path: string) => Promise<FactoryManifest>;
  readonly stamp?: (plan: StampPlan, deps?: StampDeps) => Promise<StampResult>;
  readonly validateStampedOutput?: (
    plan: StampPlan,
    deps?: StampDeps
  ) => Promise<PostStampValidation>;
  readonly templatesRoot?: string;
  readonly git?: UpgradeGitClient;
  readonly gh?: GhClient;
}

/** The outcome of `forgeUpgrade`: whether re-stamping changed anything, and the PR (if one was opened/reused). */
export interface UpgradeResult {
  readonly manifest: FactoryManifest;
  /** Re-stamping produced a diff against the working tree. */
  readonly changed: boolean;
  /** The changed subset of the stamped files, relative to `targetDir`. */
  readonly files: readonly string[];
  /** Non-failing surfaces from the post-stamp self-check: archetype drift (§2.1) + model divergence (§5.1), same as `forge new`'s. */
  readonly warnings: readonly string[];
  /** A new PR was opened by this call (vs. an already-open one being reused). Only set when `changed`. */
  readonly opened?: boolean;
  readonly pr?: { readonly number: number; readonly url: string };
}

/**
 * Regenerates this repo's stamped files from current templates
 * (`factory.toml`'s own `[factory]`/`[environment]` fed back through
 * `stamp()`) and, if anything changed, opens (or reuses) an ordinary PR
 * through the repo's own gate. Never opens a PR for a no-diff regen.
 */
export async function forgeUpgrade(
  deps: ForgeUpgradeDeps = {}
): Promise<UpgradeResult> {
  const targetDir = deps.targetDir ?? '.';
  const manifestPath = deps.manifestPath ?? join(targetDir, 'factory.toml');
  const baseBranch = deps.baseBranch ?? 'main';
  const branchNameFn = deps.branchName ?? branchForUpgrade;
  const loadManifestFn = deps.loadManifest ?? loadManifestDefault;
  const stampFn = deps.stamp ?? stampDefault;
  const validateStampedOutputFn =
    deps.validateStampedOutput ?? validateStampedOutputDefault;
  const templatesRoot = deps.templatesRoot ?? defaultTemplatesRoot();
  const git = deps.git ?? defaultGitClient(targetDir);
  const gh = deps.gh ?? defaultGhClient(targetDir);

  const before = await loadManifestFn(manifestPath);
  const plan: StampPlan = {
    factory: before.factory,
    environment: before.environment,
    targetDir,
  };

  const stampResult = await stampFn(plan, { templatesRoot });
  // Never open a PR onto a regen the manifest validator itself would reject
  // (FACTORY_SPEC.md §8) — a stamping-engine regression must surface as a
  // thrown error here, not as a red gate on an opened PR.
  const validation = await validateStampedOutputFn(plan, { templatesRoot });

  const files = git.changedFiles(stampResult.files);
  if (files.length === 0) {
    return {
      manifest: stampResult.manifest,
      changed: false,
      files: [],
      warnings: validation.warnings,
    };
  }

  const branch = branchNameFn(stampResult.manifest.factory.name);

  const [openPr] = await gh.prList({ branch, state: 'open' });
  if (openPr) {
    return {
      manifest: stampResult.manifest,
      changed: true,
      files,
      warnings: validation.warnings,
      opened: false,
      pr: openPr,
    };
  }

  git.checkoutBranch(branch);
  git.add(files);
  git.commit(formatUpgradeCommitMessage(stampResult.manifest));
  git.push(branch);

  await gh.prCreate({
    base: baseBranch,
    head: branch,
    title: formatUpgradePrTitle(stampResult.manifest),
    body: formatUpgradePrBody(stampResult.manifest, files),
  });

  const [pr] = await gh.prList({ branch, state: 'open' });
  if (!pr) {
    throw new Error(
      `forge upgrade: PR create reported success, but no OPEN PR exists for branch ` +
        `'${branch}' — the push and/or gh pr create likely failed silently.`
    );
  }

  return {
    manifest: stampResult.manifest,
    changed: true,
    files,
    warnings: validation.warnings,
    opened: true,
    pr,
  };
}
