/**
 * Full label→plan→implement→inner-gates→review→PR cycle composition
 * (FACTORY_SPEC.md §5, Forge#8): `runPlanImplementCycle` composes the first
 * half (plan → implement + inner-gates, Forge#22); `runCycle` extends it
 * with the second half (pre-review-gate → review → PR, Forge#23).
 *
 * Given a labeled issue and a loaded `FactoryManifest`, resolves the
 * planner/implementer/reviewer agents via `resolveRoleAgents` (#202 per-role
 * tiering), runs the plan phase to produce an implement dispatch (task +
 * branch), starts the implement phase, and drives it through the existing
 * `driveImplementWithInnerGates` so the manifest's cheap inner-gate tiers
 * fire between iterations. After implement returns, `runCycle` runs the
 * same inner gates once more via `runPreReviewGate` (advisory — it never
 * blocks review, Rule 3), runs the review phase on the reviewer model, and
 * opens a PR from the implement branch (PR mode: open + stop, no
 * auto-merge, matching `.sandcastle/agent-implement-issue.ts`).
 * `runPlan`/`runImplement`/`runReview`/`openPr` are injected the same way
 * `Iteration`/`Execer` are in loop.ts — a real sandcastle-backed
 * implementation in production, a stub in tests — so this composes existing
 * building blocks without depending on a concrete sandbox.
 */
import type { AgentProvider } from '@ai-hero/sandcastle';
import type { FactoryManifest } from './manifest.js';
import { resolveRoleAgents } from './models.js';
import {
  driveImplementWithInnerGates,
  runPreReviewGate,
  type Iteration,
  type InnerGateLoopOptions,
} from './loop.js';
import type { InnerGateRunReport, Execer } from './inner-gates.js';

/** Minimal reference to a labeled `agent:implement` issue — the plan phase's input. */
export interface LabeledIssueRef {
  readonly id: string;
  readonly title: string;
}

/** The plan phase's output: what to implement and which branch to implement it on. */
export interface ImplementDispatch {
  readonly task: string;
  readonly branch: string;
}

/** Runs the plan phase for one issue on the given (planner) agent. */
export type PlanRunner = (
  agent: AgentProvider,
  issue: LabeledIssueRef
) => Promise<ImplementDispatch>;

/** Starts the implement phase for a dispatch on the given (implementer) agent, returning the first iteration. */
export type ImplementRunner = (
  agent: AgentProvider,
  dispatch: ImplementDispatch
) => Promise<Iteration>;

export interface PlanImplementCycleOptions {
  readonly manifest: FactoryManifest;
  readonly exec: Execer;
  readonly runPlan: PlanRunner;
  readonly runImplement: ImplementRunner;
  /** Forwarded to `driveImplementWithInnerGates` — repair attempts before giving up. Default: 3. */
  readonly maxRepairAttempts?: InnerGateLoopOptions['maxRepairAttempts'];
}

export interface PlanImplementCycleReport {
  readonly dispatch: ImplementDispatch;
  readonly final: Iteration;
  /** One report per inner-gate run — index 0 is the first check, before any repair attempt. */
  readonly gateReports: readonly InnerGateRunReport[];
}

/**
 * Composes the plan and implement(+inner-gates) phases for one labeled
 * issue: resolve per-role agents from the manifest, run the plan phase on
 * the planner, start the implement phase on the implementer, then drive it
 * through `driveImplementWithInnerGates`.
 */
export async function runPlanImplementCycle(
  issue: LabeledIssueRef,
  options: PlanImplementCycleOptions
): Promise<PlanImplementCycleReport> {
  const agents = resolveRoleAgents(options.manifest);

  const dispatch = await options.runPlan(agents.planner, issue);
  const firstIteration = await options.runImplement(
    agents.implementer,
    dispatch
  );

  const { final, gateReports } = await driveImplementWithInnerGates(
    firstIteration,
    {
      manifest: options.manifest,
      exec: options.exec,
      maxRepairAttempts: options.maxRepairAttempts,
    }
  );

  return { dispatch, final, gateReports };
}

/** The review phase's output: the reviewer's refinement commits (if any) on the implement branch. Mirrors `Iteration`'s `commits` shape. */
export interface ReviewResult {
  readonly commits: readonly { readonly sha: string }[];
}

/** Runs the review phase on the given (reviewer) agent, against the implement branch. Generalizes `.sandcastle/agent-review-pr.ts`. */
export type ReviewRunner = (
  agent: AgentProvider,
  branch: string
) => Promise<ReviewResult>;

/** A reference to the PR opened by the PR phase. */
export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

/** Runs the PR phase: pushes the implement branch and opens a PR (PR mode — open + stop, no auto-merge). Generalizes the open-pr step of `.sandcastle/agent-implement-issue.ts`. */
export type PrOpener = (
  dispatch: ImplementDispatch,
  issue: LabeledIssueRef
) => Promise<PullRequestRef>;

export interface RunCycleOptions extends PlanImplementCycleOptions {
  readonly runReview: ReviewRunner;
  readonly openPr: PrOpener;
}

export interface RunCycleReport extends PlanImplementCycleReport {
  /** The inner gates run once more before review (FACTORY_SPEC.md §4.1) — advisory, never blocks review (Rule 3). */
  readonly preReviewGate: InnerGateRunReport;
  readonly review: ReviewResult;
  readonly pr: PullRequestRef;
}

/**
 * Composes the full plan → implement → inner-gates → pre-review-gate →
 * review → PR cycle for one labeled issue: `runPlanImplementCycle` for the
 * first half, then the manifest's inner gates once more via
 * `runPreReviewGate`, the review phase on the manifest's reviewer model, and
 * the PR phase (open + stop, no auto-merge).
 */
export async function runCycle(
  issue: LabeledIssueRef,
  options: RunCycleOptions
): Promise<RunCycleReport> {
  const agents = resolveRoleAgents(options.manifest);

  const planImplement = await runPlanImplementCycle(issue, options);

  const preReviewGate = await runPreReviewGate(options.exec, options.manifest);

  const review = await options.runReview(
    agents.reviewer,
    planImplement.dispatch.branch
  );

  const pr = await options.openPr(planImplement.dispatch, issue);

  return { ...planImplement, preReviewGate, review, pr };
}
