/**
 * Concrete, sandcastle-backed phase runners (Forge#33) — production
 * implementations of the `PlanRunner` / `ImplementRunner` / `ReviewRunner` /
 * `PrOpener` injection points `cycle.ts` (Forge#22/#23) takes as stubs.
 *
 * `createSandcastleRunners` wires all four to one `@ai-hero/sandcastle`
 * sandbox: the plan phase is a standalone `sandcastle.run()` (read-only, no
 * branch of its own — generalizes `.sandcastle/plan-dry-run.ts`), while
 * implement/review/PR share a single `createSandbox()` handle so the
 * reviewer sees the implementer's commits and the PR push reads from the
 * same worktree. The shared handle is closed via the returned `close()`.
 *
 * `runPlanAgent`/`createSandbox`/`gh` are injectable (default to the real
 * `@ai-hero/sandcastle` calls and the `gh` CLI) so tests can exercise every
 * runner against a faked/ephemeral sandbox with no live Actions run — the
 * same structural-stub seam `loop.ts`/`cycle.ts` already use for
 * `Iteration`/`Execer`.
 *
 * `openPr`'s `gh pr create` call is wrapped in a bounded, idempotent retry
 * (Forge#43): a transient API blip (observed as a bare 500/GraphQL failure
 * with no exposed HTTP status — `gh` surfaces it as an opaque
 * `execFileSync` throw) must not discard the already-pushed, already-reviewed
 * branch. Before every attempt — including the first — it looks for an
 * existing open OR closed PR for the branch and returns it if found, since a
 * failed attempt can mask a server-side success; a blind retry would then
 * 422 on an already-created PR. If every attempt is exhausted, it throws
 * (the run still exits non-zero) but never before logging the pushed branch
 * name and a copy-pasteable recovery `gh pr create` command, and posting the
 * same as an issue comment when `gh.issueComment` is wired up — the pushed
 * branch itself is never deleted on this path.
 */
import { execFileSync } from 'node:child_process';
import * as sandcastle from '@ai-hero/sandcastle';
import type {
  AgentProvider,
  CreateSandboxOptions,
  OutputObjectDefinition,
  Sandbox,
  SandboxHooks,
  SandboxProvider,
  SandboxRunResult,
} from '@ai-hero/sandcastle';
import type { Iteration } from './loop.js';
import type { Execer } from './inner-gates.js';
import type {
  ImplementRunner,
  PlanRunner,
  PrOpener,
  ReviewRunner,
} from './cycle.js';

export const DEFAULT_PLAN_PROMPT_FILE = '.sandcastle/plan-prompt.md';
export const DEFAULT_IMPLEMENT_PROMPT_FILE = '.sandcastle/implement-prompt.md';
export const DEFAULT_REVIEW_PROMPT_FILE = '.sandcastle/review-prompt.md';

/** One entry of the planner's `<plan>` output — mirrors `plan-prompt.md`'s schema. */
export interface PlannedIssue {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

export interface PlannedIssues {
  readonly issues: readonly PlannedIssue[];
}

/** Validates the planner's parsed `<plan>` JSON. Throws with a human-readable message on a bad shape. */
export function validatePlannedIssues(value: unknown): PlannedIssues {
  if (typeof value !== 'object' || value === null || !('issues' in value)) {
    throw new Error(
      'planner output: expected an object with an "issues" array'
    );
  }
  const { issues } = value as { issues: unknown };
  if (!Array.isArray(issues)) {
    throw new Error('planner output: "issues" MUST be an array');
  }
  issues.forEach((entry, i) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Partial<PlannedIssue>).id !== 'string' ||
      typeof (entry as Partial<PlannedIssue>).title !== 'string' ||
      typeof (entry as Partial<PlannedIssue>).branch !== 'string'
    ) {
      throw new Error(
        `planner output: issues[${i}] MUST be {"id","title","branch"} strings`
      );
    }
  });
  return value as PlannedIssues;
}

const planOutputSchema = {
  '~standard': {
    version: 1,
    vendor: 'forge-core',
    validate(value: unknown) {
      try {
        return { value: validatePlannedIssues(value) };
      } catch (err) {
        return {
          issues: [
            { message: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    },
  },
};

/** The subset of `sandcastle.run()` the plan phase needs — narrowed to the `Output.object` overload. */
export type PlanAgentRun = (options: {
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly hooks?: SandboxHooks;
  readonly maxIterations?: number;
  readonly promptFile: string;
  readonly output: OutputObjectDefinition<PlannedIssues>;
}) => Promise<{ readonly output: PlannedIssues }>;

const defaultRunPlanAgent: PlanAgentRun = (options) => sandcastle.run(options);

/** The subset of `sandcastle.createSandbox()` the implement/review/PR phases need. */
export type CreateSandboxFn = (
  options: CreateSandboxOptions
) => Promise<Sandbox>;

/** Deterministic branch naming (`plan-prompt.md`'s contract): `sandcastle/issue-{id}`. */
export function branchForIssue(issueId: string): string {
  return `sandcastle/issue-${issueId}`;
}

const ISSUE_ID_FROM_BRANCH = /^sandcastle\/issue-(.+)$/;

/** Recovers the issue id encoded in a dispatch's branch — the inverse of {@link branchForIssue}. */
function issueIdFromBranch(branch: string): string {
  const id = ISSUE_ID_FROM_BRANCH.exec(branch)?.[1];
  if (!id) {
    throw new Error(
      `branch "${branch}" does not match the sandcastle/issue-<id> convention`
    );
  }
  return id;
}

/** Adapts sandcastle's `SandboxRunResult` (recursive `resume`) to the narrower `Iteration` shape `loop.ts` drives. */
function toIteration(result: SandboxRunResult): Iteration {
  const { resume } = result;
  return {
    commits: result.commits,
    resume: resume
      ? (prompt: string) => resume(prompt).then(toIteration)
      : undefined,
  };
}

/** A minimal GitHub client for the deterministic push+PR step (toon-meta#235 — no agent, plain plumbing). */
export interface GhClient {
  readonly prList: (args: {
    readonly branch: string;
    readonly state: 'open' | 'all';
  }) => Promise<readonly { readonly number: number; readonly url: string }[]>;
  readonly prCreate: (args: {
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
  /** Best-effort recovery breadcrumb (Forge#43) — leaves the pushed branch + recovery command on the issue when every `prCreate` retry is exhausted. Optional: no-op if omitted. */
  readonly issueComment?: (args: {
    readonly issue: string;
    readonly body: string;
  }) => Promise<void>;
}

const defaultGhClient: GhClient = {
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
      { encoding: 'utf8' }
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
      { stdio: 'inherit' }
    );
  },
  async issueComment({ issue, body }) {
    execFileSync('gh', ['issue', 'comment', issue, '--body', body], {
      stdio: 'inherit',
    });
  },
};

/** Delays (ms) waited before each retry of a failed `gh pr create` (Forge#43) — the outage this guards against saw transient 500s clear within minutes. */
export const DEFAULT_PR_CREATE_RETRY_DELAYS_MS: readonly number[] = [
  2000, 8000, 30000, 60000, 120000,
];

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Idempotency check (Forge#43): a transient `prCreate` failure (500/GraphQL blip) can mask a server-side success, so every attempt — including the first — looks for an existing PR (open OR closed) before creating another. */
async function findExistingPr(
  gh: GhClient,
  branch: string
): Promise<{ readonly number: number; readonly url: string } | undefined> {
  const [existing] = await gh.prList({ branch, state: 'all' });
  return existing;
}

export interface SandcastleRunnersConfig {
  /** Sandbox provider shared by every phase (e.g. `docker({ env: sandboxSecrets() })`). */
  readonly sandboxProvider: SandboxProvider;
  readonly hooks?: SandboxHooks;
  /** Base branch for the implement sandbox and the opened PR. Default: `"main"`. */
  readonly baseBranch?: string;
  /** Forwarded to the implement phase's `maxIterations`. Default: 100 (matches `.sandcastle/agent-implement-issue.ts`). */
  readonly maxImplementIterations?: number;
  readonly promptFiles?: {
    readonly plan?: string;
    readonly implement?: string;
    readonly review?: string;
  };
  readonly gh?: GhClient;
  readonly runPlanAgent?: PlanAgentRun;
  readonly createSandbox?: CreateSandboxFn;
  /** Retry policy for the PR-open step's `gh pr create` call (Forge#43). Default: {@link DEFAULT_PR_CREATE_RETRY_DELAYS_MS} with a real `setTimeout`-backed sleep. */
  readonly prCreateRetry?: {
    /** Delay before each retry — length is the retry count (attempts = length + 1). Default: {@link DEFAULT_PR_CREATE_RETRY_DELAYS_MS}. */
    readonly delaysMs?: readonly number[];
    readonly sleep?: Sleep;
  };
}

export interface SandcastleRunners {
  readonly runPlan: PlanRunner;
  readonly runImplement: ImplementRunner;
  readonly exec: Execer;
  readonly runReview: ReviewRunner;
  readonly openPr: PrOpener;
  /**
   * Opens the shared sandbox on an EXISTING branch (a PR head) so `runReview`
   * / `exec` can run without an implement phase — the standalone `agent:review`
   * path (Forge#24b). Unlike `runImplement` it passes no `baseBranch`, so the
   * existing branch is checked out rather than branched from `main`.
   */
  readonly prepareForReview: (branch: string) => Promise<void>;
  /** Tears down the sandbox `runImplement`/`prepareForReview` created. No-op if neither ran. */
  readonly close: () => Promise<void>;
}

/**
 * Builds the four `runCycle()` injection points (plus `exec`) backed by one
 * shared sandbox, so `runCycle()` can drive a real `@ai-hero/sandcastle` run
 * with no stub injection remaining.
 */
export function createSandcastleRunners(
  config: SandcastleRunnersConfig
): SandcastleRunners {
  const baseBranch = config.baseBranch ?? 'main';
  const maxImplementIterations = config.maxImplementIterations ?? 100;
  const planPromptFile = config.promptFiles?.plan ?? DEFAULT_PLAN_PROMPT_FILE;
  const implementPromptFile =
    config.promptFiles?.implement ?? DEFAULT_IMPLEMENT_PROMPT_FILE;
  const reviewPromptFile =
    config.promptFiles?.review ?? DEFAULT_REVIEW_PROMPT_FILE;
  const gh = config.gh ?? defaultGhClient;
  const runPlanAgent = config.runPlanAgent ?? defaultRunPlanAgent;
  const createSandboxFn = config.createSandbox ?? sandcastle.createSandbox;
  const prCreateRetryDelaysMs =
    config.prCreateRetry?.delaysMs ?? DEFAULT_PR_CREATE_RETRY_DELAYS_MS;
  const sleep = config.prCreateRetry?.sleep ?? defaultSleep;

  let sandbox: Sandbox | undefined;

  function requireSandbox(): Sandbox {
    if (!sandbox) {
      throw new Error(
        'sandcastle-runners: no sandbox yet — runImplement must run before exec/runReview/openPr.'
      );
    }
    return sandbox;
  }

  const runPlan: PlanRunner = async (agent, issue) => {
    const { output } = await runPlanAgent({
      agent,
      sandbox: config.sandboxProvider,
      hooks: config.hooks,
      maxIterations: 1,
      promptFile: planPromptFile,
      output: sandcastle.Output.object({
        tag: 'plan',
        schema: planOutputSchema,
      }),
    });

    const planned = output.issues.find((i) => i.id === issue.id);
    if (!planned) {
      throw new Error(
        `planner did not include issue #${issue.id} in its plan — it may be blocked by another open issue.`
      );
    }
    const branch = branchForIssue(issue.id);
    if (planned.branch !== branch) {
      throw new Error(
        `planner returned branch "${planned.branch}" for issue #${issue.id}, expected the deterministic "${branch}".`
      );
    }
    return { task: issue.title, branch };
  };

  const runImplement: ImplementRunner = async (agent, dispatch) => {
    sandbox = await createSandboxFn({
      branch: dispatch.branch,
      baseBranch,
      sandbox: config.sandboxProvider,
      hooks: config.hooks,
    });
    const result = await sandbox.run({
      name: 'implementer',
      agent,
      maxIterations: maxImplementIterations,
      promptFile: implementPromptFile,
      promptArgs: {
        TASK_ID: issueIdFromBranch(dispatch.branch),
        ISSUE_TITLE: dispatch.task,
        BRANCH: dispatch.branch,
      },
    });
    return toIteration(result);
  };

  const prepareForReview = async (branch: string): Promise<void> => {
    sandbox = await createSandboxFn({
      branch,
      sandbox: config.sandboxProvider,
      hooks: config.hooks,
    });
  };

  const exec: Execer = async (command, options) =>
    requireSandbox().exec(command, options);

  const runReview: ReviewRunner = async (agent, branch) => {
    // review-prompt.md now requires ISSUE_NUMBER/ISSUE_TITLE (the Spec axis,
    // toon-meta#275) — an unresolved {{...}} placeholder fails the run. The
    // ReviewRunner seam only carries the branch, so recover the issue number
    // from the deterministic `sandcastle/issue-<id>` convention (the same id
    // the factory PR body's `Closes #n` names); a branch outside the
    // convention gets a Standards-only review. The reviewer reads the issue
    // itself in-sandbox (`gh issue view`), so the title here is cosmetic.
    // This path does not yet CONSUME the reviewer's <review> verdict —
    // enforcement lives in the stage-0 label runners (via
    // .sandcastle/review-verdict.ts); wiring it into forge-core is part of
    // the auto-merge work (toon-meta#270).
    const issueId = ISSUE_ID_FROM_BRANCH.exec(branch)?.[1];
    const result = await requireSandbox().run({
      name: 'reviewer',
      agent,
      maxIterations: 1,
      promptFile: reviewPromptFile,
      promptArgs: {
        BRANCH: branch,
        ISSUE_NUMBER: issueId ?? 'none',
        ISSUE_TITLE: issueId
          ? `(issue #${issueId} — read it with \`gh issue view ${issueId}\`)`
          : '(no target issue resolved)',
      },
    });
    return { commits: result.commits };
  };

  const openPr: PrOpener = async (dispatch, issue) => {
    const push = await requireSandbox().exec(
      `git push -u origin ${dispatch.branch}`
    );
    if (push.exitCode !== 0) {
      throw new Error(
        `git push of '${dispatch.branch}' failed (exit ${push.exitCode}).\n${push.stderr}`
      );
    }

    const prBody =
      'Produced by the sandcastle `agent:implement` runner; awaiting human review.\n\n' +
      `Closes #${issue.id}\n\n` +
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    const recoveryCommand =
      `gh pr create --base ${baseBranch} --head ${dispatch.branch} ` +
      `--title ${JSON.stringify(issue.title)} --body ${JSON.stringify(prBody)}`;

    // No delay before the first attempt, then one entry per retry.
    const delaySchedule: readonly (number | undefined)[] = [
      undefined,
      ...prCreateRetryDelaysMs,
    ];
    const attempts = delaySchedule.length;
    let lastError: unknown;

    for (const delayMs of delaySchedule) {
      const existing = await findExistingPr(gh, dispatch.branch);
      if (existing) {
        return existing;
      }

      if (delayMs !== undefined) {
        await sleep(delayMs);
      }

      try {
        await gh.prCreate({
          base: baseBranch,
          head: dispatch.branch,
          title: issue.title,
          body: prBody,
        });
      } catch (err) {
        lastError = err;
        continue;
      }

      const [pr] = await gh.prList({ branch: dispatch.branch, state: 'open' });
      if (pr) {
        return pr;
      }
      lastError = new Error(
        `the open-pr phase reported success, but no OPEN PR exists for branch '${dispatch.branch}' — the push and/or gh pr create likely failed silently.`
      );
    }

    // Every attempt exhausted (Forge#43): the expensive implement+review work
    // is already pushed to origin and must not be discarded — surface loud,
    // actionable recovery instead of a bare throw.
    const message =
      `open-pr: gave up after ${attempts} attempts to create a PR for branch '${dispatch.branch}'.\n` +
      `The branch IS pushed to origin — the completed implement+review work is NOT lost.\n` +
      `Recover by running:\n  ${recoveryCommand}\n` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    console.error(message);
    if (gh.issueComment) {
      await gh.issueComment({
        issue: issue.id,
        body:
          `⚠️ PR creation failed after ${attempts} attempts, but branch \`${dispatch.branch}\` ` +
          `is pushed and the work is complete. Recover with:\n\n\`\`\`\n${recoveryCommand}\n\`\`\``,
      });
    }
    throw new Error(message);
  };

  const close = async (): Promise<void> => {
    if (sandbox) {
      await sandbox.close();
      sandbox = undefined;
    }
  };

  return {
    runPlan,
    runImplement,
    exec,
    runReview,
    openPr,
    prepareForReview,
    close,
  };
}
