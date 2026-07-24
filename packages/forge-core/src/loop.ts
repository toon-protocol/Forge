/**
 * Drives inner-gate injection across implement iterations (FACTORY_SPEC.md
 * §4.1): run the manifest's cheap tiers, and when they're red, feed the
 * repair prompt back into the implementer via sandcastle's `resume()` for
 * exactly one more iteration. Advisory only — the outer PR gate is the
 * authoritative verdict (Rule 3); this loop only ever repairs or stops.
 *
 * `Iteration` is structurally compatible with sandcastle's `RunResult` (it
 * has `commits` and an optional `resume`), so this drives a real sandbox in
 * production and a stub in tests without depending on sandcastle's concrete
 * type — see loop.test.ts for the "stubbed loop" acceptance demo.
 */
import type { FactoryManifest } from './manifest.js';
import {
  runInnerGates,
  type Execer,
  type InnerGateRunReport,
} from './inner-gates.js';

export interface Iteration {
  readonly commits: readonly { readonly sha: string }[];
  readonly resume?: (prompt: string) => Promise<Iteration>;
}

export interface InnerGateLoopReport {
  readonly final: Iteration;
  /** One report per inner-gate run — index 0 is the first check, before any repair attempt. */
  readonly gateReports: readonly InnerGateRunReport[];
}

export interface InnerGateLoopOptions {
  readonly manifest: FactoryManifest;
  readonly exec: Execer;
  /** Repair attempts (resume calls) before giving up and returning the last iteration red. Default: 3. */
  readonly maxRepairAttempts?: number;
}

/**
 * Runs the manifest's inner gates after `firstIteration`; on failure, resumes
 * the implementer with the repair prompt and re-checks, up to
 * `maxRepairAttempts` times. Stops as soon as the gates pass, the iteration
 * has no `resume` (nothing left to repair with), or attempts run out.
 */
export async function driveImplementWithInnerGates(
  firstIteration: Iteration,
  options: InnerGateLoopOptions
): Promise<InnerGateLoopReport> {
  const maxRepairAttempts = options.maxRepairAttempts ?? 3;
  const gateReports: InnerGateRunReport[] = [];
  let current = firstIteration;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const report = await runInnerGates(options.exec, options.manifest);
    gateReports.push(report);
    const { repairPrompt } = report;
    if (
      repairPrompt === undefined ||
      !current.resume ||
      attempt === maxRepairAttempts
    ) {
      return { final: current, gateReports };
    }
    current = await current.resume(repairPrompt);
  }

  return { final: current, gateReports };
}

/** Runs the manifest's inner gates once more before review (FACTORY_SPEC.md §4.1). No repair loop — review reads the report. */
export function runPreReviewGate(
  exec: Execer,
  manifest: FactoryManifest
): Promise<InnerGateRunReport> {
  return runInnerGates(exec, manifest);
}
