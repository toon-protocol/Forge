/**
 * @toon-protocol/forge-core — factory engine.
 *
 * Wraps `@ai-hero/sandcastle` with a manifest loader (`factory.toml` per
 * FACTORY_SPEC.md, #213), inner-gate injection (#215), and the
 * plan→implement(+inner-gates) cycle (#22). The remaining
 * review→PR half of the full label→plan→implement→inner-gates→review→PR
 * orchestration is not yet implemented here — see Forge#8.
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
  runPlanImplementCycle,
} from './cycle.js';

/** forge-core semantic version, surfaced for `forge doctor`/`status`. */
export const FORGE_CORE_VERSION = '0.0.0';
