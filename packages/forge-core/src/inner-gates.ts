/**
 * Inner-gate injection (FACTORY_SPEC.md §4.1) — runs a manifest's cheap
 * oracle tiers as `sandbox.exec()` between implement iterations and before
 * review. Advisory: a failing tier's output becomes the repair prompt fed
 * back to the implementer, never a merge decision (Rule 3).
 */
import type { ExecResult, SandboxExecOptions } from '@ai-hero/sandcastle';
import type { FactoryManifest, OracleTier } from './manifest.js';

/** The minimal `Sandbox.exec()` shape inner-gate injection needs. */
export type Execer = (
  command: string,
  options?: SandboxExecOptions
) => Promise<ExecResult>;

export interface InnerGateResult {
  readonly tierId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly passed: boolean;
}

export interface InnerGateRunReport {
  readonly results: readonly InnerGateResult[];
  readonly passed: boolean;
  /** Built from the red output of every failing tier; undefined when all tiers passed. */
  readonly repairPrompt?: string;
}

/** The manifest's `[loop].inner_gates` tiers, resolved against `[[oracle.tier]]` and filtered to the `inner` surface. */
export function selectInnerGateTiers(
  manifest: FactoryManifest
): readonly OracleTier[] {
  const gateIds = new Set(manifest.loop.innerGates);
  return manifest.oracleTiers.filter(
    (tier) => gateIds.has(tier.id) && tier.surfaces.includes('inner')
  );
}

/**
 * Runs the manifest's inner-gate tiers in declaration order via `exec`
 * (`sandbox.exec()` in production; a stub in tests). Every tier runs — a
 * failure does not short-circuit the rest, so the repair prompt reports
 * everything that's red at once.
 */
export async function runInnerGates(
  exec: Execer,
  manifest: FactoryManifest
): Promise<InnerGateRunReport> {
  const tiers = selectInnerGateTiers(manifest);
  const results: InnerGateResult[] = [];
  for (const tier of tiers) {
    const execResult = await exec(tier.run);
    results.push({
      tierId: tier.id,
      command: tier.run,
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      passed: execResult.exitCode === 0,
    });
  }
  const failures = results.filter((r) => !r.passed);
  return {
    results,
    passed: failures.length === 0,
    repairPrompt: failures.length > 0 ? buildRepairPrompt(failures) : undefined,
  };
}

/** Formats failing inner-gate output into the repair prompt handed back to the implementer. */
export function buildRepairPrompt(
  failures: readonly InnerGateResult[]
): string {
  const sections = failures.map((f) => {
    const output = `${f.stdout}${f.stderr}`.trim();
    return `### ${f.tierId}\n\`${f.command}\` exited ${f.exitCode}.\n\n\`\`\`\n${output}\n\`\`\``;
  });
  return [
    'The inner gate(s) below are red. Fix everything they report, then continue.',
    ...sections,
  ].join('\n\n');
}
