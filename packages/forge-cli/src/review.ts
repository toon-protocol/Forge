/**
 * `forge review` — run forge-core's reviewer standalone over an existing PR
 * (the `agent:review` path, Forge#24b). Resolves the PR's head branch,
 * materialises it as a local branch (the workflow checks out main —
 * toon-meta#275 / connector#634), opens a sandbox on it (`prepareForReview` —
 * no implement phase), runs the reviewer on the manifest's `reviewer` model,
 * and pushes any refinement commits back to the PR branch, verifying they
 * landed (fail-loud, toon-meta#235). Never merges, never closes — a human
 * still merges.
 *
 * Reuses `sandboxSecrets` / `SANDBOX_READY_HOOKS` from `run.ts`. `gh`/manifest/
 * runner seams are injectable so this is unit-testable with no sandbox.
 */
import { execFileSync } from 'node:child_process';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { SandboxProvider, AgentProvider } from '@ai-hero/sandcastle';
import {
  loadManifest,
  createSandcastleRunners,
  resolveRoleAgent,
  type FactoryManifest,
} from '@toon-protocol/forge-core';
import { sandboxSecrets, SANDBOX_READY_HOOKS } from './run.js';

/** Resolves a PR's head branch via the host `gh` (authed by GH_TOKEN). */
function fetchHeadRef(prNumber: string): string {
  return execFileSync(
    'gh',
    ['pr', 'view', prNumber, '--json', 'headRefName', '--jq', '.headRefName'],
    { encoding: 'utf-8' }
  ).trim();
}

/**
 * Materialises the PR head as a LOCAL branch at origin's tip. The
 * `agent:review` workflow checks out MAIN, never the PR head — sandcastle
 * checks the head branch out in its OWN worktree under
 * `.sandcastle/worktrees/`, and git refuses one branch in two worktrees
 * (connector#634's first live run). Without a local branch the engine's
 * `worktree add -b <branch> HEAD` fallback silently reviews an EMPTY diff off
 * main. Forced so a re-labeled PR re-reviews the CURRENT head even after a
 * force-push.
 */
function materialiseHeadBranch(branch: string): void {
  execFileSync('git', ['fetch', 'origin', `+${branch}:${branch}`], {
    stdio: 'inherit',
  });
}

/**
 * Verifies every review commit is reachable from `origin/<branch>` — the
 * fail-loud backstop for a silent in-sandbox push (toon-meta#235). Returns the
 * shas that did NOT land. `compare/<sha>...<branch>` is `ahead`/`identical`
 * when `sha` is an ancestor of (or equal to) the remote head.
 */
function verifyCommitsLanded(
  shas: readonly string[],
  branch: string
): string[] {
  const nwo = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { encoding: 'utf-8' }
  ).trim();
  const missing: string[] = [];
  for (const sha of shas) {
    try {
      const status = execFileSync(
        'gh',
        ['api', `repos/${nwo}/compare/${sha}...${branch}`, '--jq', '.status'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
      if (status !== 'ahead' && status !== 'identical') missing.push(sha);
    } catch {
      missing.push(sha);
    }
  }
  return missing;
}

/** The outcome of a review run: the branch reviewed and how many commits were pushed. */
export interface ReviewOutcome {
  readonly branch: string;
  readonly pushedCommits: number;
}

export interface ForgeReviewOptions {
  /** The PR to review (github.event.pull_request.number). */
  readonly prNumber: string;
  /** Path to the manifest. Default: `"factory.toml"`. */
  readonly manifestPath?: string;
  // Injectable seams (default to the real implementations) — for tests.
  readonly loadManifest?: (path: string) => Promise<FactoryManifest>;
  readonly createRunners?: typeof createSandcastleRunners;
  readonly resolveReviewer?: (manifest: FactoryManifest) => AgentProvider;
  readonly getHeadRef?: (prNumber: string) => string;
  /** Materialises the PR head as a local branch (the workflow checks out main). */
  readonly materialiseHead?: (branch: string) => void;
  readonly verifyPushed?: (shas: readonly string[], branch: string) => string[];
  readonly sandboxProvider?: SandboxProvider;
}

/**
 * Reviews one existing PR: open a sandbox on its head branch, run the reviewer,
 * and push refinement commits back (verified). The sandbox is always torn down
 * (try/finally), even on error.
 */
export async function forgeReview(
  options: ForgeReviewOptions
): Promise<ReviewOutcome> {
  const prNumber = options.prNumber.trim();
  if (!/^\d+$/.test(prNumber)) {
    throw new Error(
      `forge review: PR number must be numeric (got ${JSON.stringify(options.prNumber)}).`
    );
  }

  const loadManifestFn = options.loadManifest ?? loadManifest;
  const createRunners = options.createRunners ?? createSandcastleRunners;
  const resolveReviewer =
    options.resolveReviewer ?? ((m) => resolveRoleAgent(m, 'reviewer'));
  const getHeadRef = options.getHeadRef ?? fetchHeadRef;
  const materialiseHead = options.materialiseHead ?? materialiseHeadBranch;
  const verifyPushed = options.verifyPushed ?? verifyCommitsLanded;
  const sandboxProvider =
    options.sandboxProvider ?? docker({ env: sandboxSecrets() });

  const manifest = await loadManifestFn(options.manifestPath ?? 'factory.toml');
  const branch = getHeadRef(prNumber);
  if (!branch) {
    throw new Error(
      `forge review: could not resolve the head branch for PR #${prNumber}.`
    );
  }
  materialiseHead(branch);

  const runners = createRunners({
    sandboxProvider,
    hooks: SANDBOX_READY_HOOKS,
  });

  try {
    await runners.prepareForReview(branch);
    const review = await runners.runReview(resolveReviewer(manifest), branch);

    if (review.commits.length === 0) {
      return { branch, pushedCommits: 0 };
    }

    const push = await runners.exec(`git push origin ${branch}`);
    if (push.exitCode !== 0) {
      throw new Error(
        `forge review: git push of '${branch}' failed (exit ${push.exitCode}).\n${push.stderr}`
      );
    }

    const missing = verifyPushed(
      review.commits.map((c) => c.sha),
      branch
    );
    if (missing.length > 0) {
      throw new Error(
        `forge review: ${missing.length} reviewer commit(s) are NOT on origin/${branch} ` +
          `(${missing.join(', ')}) — the in-sandbox push failed silently.`
      );
    }

    return { branch, pushedCommits: review.commits.length };
  } finally {
    await runners.close();
  }
}
