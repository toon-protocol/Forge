/**
 * Plan → implement (with inner-gates) cycle composition (FACTORY_SPEC.md
 * §5, Forge#22) — the first half of forge-core's full label→plan→implement
 * →inner-gates→review→PR run (Forge#8).
 *
 * Given a labeled issue and a loaded `FactoryManifest`, resolves the
 * planner/implementer agents via `resolveRoleAgents` (#202 per-role
 * tiering), runs the plan phase to produce an implement dispatch (task +
 * branch), starts the implement phase, and drives it through the existing
 * `driveImplementWithInnerGates` so the manifest's cheap inner-gate tiers
 * fire between iterations. `runPlan`/`runImplement` are injected the same
 * way `Iteration`/`Execer` are in loop.ts — a real sandcastle-backed
 * implementation in production, a stub in tests — so this composes existing
 * building blocks without depending on a concrete sandbox.
 */
import type { AgentProvider } from '@ai-hero/sandcastle';
import type { FactoryManifest } from './manifest.js';
import { resolveRoleAgents } from './models.js';
import {
  driveImplementWithInnerGates,
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
