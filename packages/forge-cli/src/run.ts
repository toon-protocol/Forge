/**
 * `forge run` — drive one labeled issue through forge-core's full
 * label→plan→implement→inner-gates→review→PR cycle (`runCycle`) on the repo's
 * `factory.toml`, in PR mode (open a PR and stop; a human merges).
 *
 * This is the Actions entrypoint the `agent:implement` workflow invokes,
 * replacing the stage-0 `.sandcastle/agent-implement-issue.ts`. The host
 * orchestrates; `runCycle` drives a real `@ai-hero/sandcastle` sandbox through
 * `createSandcastleRunners`. `runCycle` is plan-first by construction, so the
 * planner also acts as a blocked-issue gate — it throws if the labeled issue
 * is blocked (see `createSandcastleRunners.runPlan`, Forge#33).
 *
 * Unlike the stage-0 runner there is NO auto-merge toggle: `runCycle` has no
 * merge phase, so this path is PR-mode by construction.
 *
 * `loadManifest`/`createRunners`/`runCycle`/`getIssueTitle`/`sandboxProvider`
 * are injectable (default to the real forge-core + `gh`/`docker` calls) so this
 * is unit-testable with no sandbox — the same structural-stub seam forge-core
 * uses internally.
 */
import { execFileSync } from 'node:child_process';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { SandboxHooks, SandboxProvider } from '@ai-hero/sandcastle';
import {
  loadManifest,
  createSandcastleRunners,
  runCycle,
  type FactoryManifest,
  type LabeledIssueRef,
  type PullRequestRef,
} from '@toon-protocol/forge-core';

/** Host env vars forwarded into the sandbox — claude-code auth + `gh`/`git` push auth. */
const PASSTHROUGH_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'] as const;

/**
 * The subset of {@link PASSTHROUGH_KEYS} set on the host, as `docker({ env })`.
 * Undefined vars are omitted (never `KEY=undefined`) so a local `.sandcastle/.env`
 * is not clobbered. Mirrors `.sandcastle/sandbox-secrets.ts` — @ai-hero/sandcastle
 * only forwards keys that appear in `.sandcastle/.env`, absent in CI, so the
 * provider `env` option is the only reliable path (relay#68).
 */
export function sandboxSecrets(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * `onSandboxReady` hooks wiring a DETERMINISTIC `git push` and a frozen
 * install inside the container (toon-meta#235/#236): @ai-hero/sandcastle@0.12.0
 * does no credential setup, so a bare `git push` is unauthenticated and fails
 * silently. `gh auth setup-git` installs `gh` as git's credential helper (reads
 * GH_TOKEN at push time); unsetting the checkout `http.extraheader` stops the
 * default GITHUB_TOKEN from overriding it. Guarded on GH_TOKEN so local dev
 * without a token no-ops instead of aborting sandbox setup.
 */
export const SANDBOX_READY_HOOKS: SandboxHooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
      { command: 'pnpm install --frozen-lockfile' },
    ],
  },
};

/** Fetches an issue's title from GitHub via the host `gh` (authed by GH_TOKEN). */
function fetchIssueTitle(issueNumber: string): string {
  return execFileSync(
    'gh',
    ['issue', 'view', issueNumber, '--json', 'title', '--jq', '.title'],
    { encoding: 'utf-8' }
  ).trim();
}

export interface ForgeRunOptions {
  /** The `agent:implement` issue to build (github.event.issue.number). */
  readonly issueNumber: string;
  /** Path to the manifest. Default: `"factory.toml"`. */
  readonly manifestPath?: string;
  // Injectable seams (default to the real implementations) — for tests.
  readonly loadManifest?: (path: string) => Promise<FactoryManifest>;
  readonly createRunners?: typeof createSandcastleRunners;
  readonly runCycle?: typeof runCycle;
  readonly getIssueTitle?: (issueNumber: string) => string;
  readonly sandboxProvider?: SandboxProvider;
}

/**
 * Runs one labeled issue through `runCycle` in PR mode and returns the opened
 * PR. The sandbox `runCycle` creates is always torn down (try/finally), even
 * when the cycle throws.
 */
export async function forgeRun(
  options: ForgeRunOptions
): Promise<PullRequestRef> {
  const issueNumber = options.issueNumber.trim();
  if (!/^\d+$/.test(issueNumber)) {
    throw new Error(
      `forge run: issue number must be numeric (got ${JSON.stringify(options.issueNumber)}).`
    );
  }

  const loadManifestFn = options.loadManifest ?? loadManifest;
  const createRunners = options.createRunners ?? createSandcastleRunners;
  const runCycleFn = options.runCycle ?? runCycle;
  const getIssueTitle = options.getIssueTitle ?? fetchIssueTitle;
  const sandboxProvider =
    options.sandboxProvider ?? docker({ env: sandboxSecrets() });

  const manifest = await loadManifestFn(options.manifestPath ?? 'factory.toml');
  const issue: LabeledIssueRef = {
    id: issueNumber,
    title: getIssueTitle(issueNumber),
  };

  const runners = createRunners({
    sandboxProvider,
    hooks: SANDBOX_READY_HOOKS,
  });

  try {
    const report = await runCycleFn(issue, {
      manifest,
      exec: runners.exec,
      runPlan: runners.runPlan,
      runImplement: runners.runImplement,
      runReview: runners.runReview,
      openPr: runners.openPr,
    });
    return report.pr;
  } finally {
    await runners.close();
  }
}
