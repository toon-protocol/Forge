/**
 * @toon-protocol/forge-core — factory engine.
 *
 * Wraps `@ai-hero/sandcastle` with a manifest loader (`factory.toml` per
 * FACTORY_SPEC.md, #213), inner-gate injection (#215), the full
 * label→plan→implement→inner-gates→review→PR cycle composition (`runCycle`,
 * Forge#22/#23), and concrete sandcastle-backed phase runners
 * (`createSandcastleRunners`, Forge#33) that wire `runCycle` to a real
 * sandbox with no stub injection remaining. Driving that from a real Actions
 * run against labeled issues (`forge run` or equivalent) is Forge#24.
 */

export {
  type EnvironmentKind,
  type EnvironmentSection,
  type FactoryManifest,
  type FactorySection,
  type LoopSection,
  ManifestValidationError,
  type OracleTier,
  type PrivilegedOperation,
  type PrivilegedSection,
  type Role,
  ROLES,
  type Surface,
  type TierCost,
  loadManifest,
  parseManifest,
  validateManifest,
} from './manifest.js';

export {
  type Execer,
  type InnerGateResult,
  type InnerGateRunReport,
  buildRepairPrompt,
  runInnerGates,
  selectInnerGateTiers,
} from './inner-gates.js';

export {
  type RoleAgents,
  resolveRoleAgent,
  resolveRoleAgents,
} from './models.js';

export {
  type Iteration,
  type InnerGateLoopOptions,
  type InnerGateLoopReport,
  driveImplementWithInnerGates,
  runPreReviewGate,
} from './loop.js';

export {
  type LabeledIssueRef,
  type ImplementDispatch,
  type PlanRunner,
  type ImplementRunner,
  type PlanImplementCycleOptions,
  type PlanImplementCycleReport,
  type ReviewResult,
  type ReviewRunner,
  type PullRequestRef,
  type PrOpener,
  type RunCycleOptions,
  type RunCycleReport,
  runPlanImplementCycle,
  runCycle,
} from './cycle.js';

export {
  DEFAULT_PLAN_PROMPT_FILE,
  DEFAULT_IMPLEMENT_PROMPT_FILE,
  DEFAULT_REVIEW_PROMPT_FILE,
  type PlannedIssue,
  type PlannedIssues,
  validatePlannedIssues,
  type PlanAgentRun,
  type CreateSandboxFn,
  type GhClient,
  type SandcastleRunnersConfig,
  type SandcastleRunners,
  branchForIssue,
  createSandcastleRunners,
} from './sandcastle-runners.js';

/** forge-core semantic version, surfaced for `forge doctor`/`status`. */
export const FORGE_CORE_VERSION = '0.0.0';
