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
};

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
    const result = await requireSandbox().run({
      name: 'reviewer',
      agent,
      maxIterations: 1,
      promptFile: reviewPromptFile,
      promptArgs: { BRANCH: branch },
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

    const [existingPr] = await gh.prList({
      branch: dispatch.branch,
      state: 'open',
    });
    if (existingPr) {
      return existingPr;
    }

    await gh.prCreate({
      base: baseBranch,
      head: dispatch.branch,
      title: issue.title,
      body:
        'Produced by the sandcastle `agent:implement` runner; awaiting human review.\n\n' +
        `Closes #${issue.id}\n\n` +
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    });

    const openPrs = await gh.prList({ branch: dispatch.branch, state: 'open' });
    const pr = openPrs[0];
    if (!pr) {
      throw new Error(
        `the open-pr phase reported success, but no OPEN PR exists for branch '${dispatch.branch}' — the push and/or gh pr create likely failed silently.`
      );
    }
    return pr;
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
