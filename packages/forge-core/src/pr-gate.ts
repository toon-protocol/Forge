/**
 * PR-surfaced tier ladder (FACTORY_SPEC.md §4.1) — the same ladder `gate.yml`
 * runs authoritatively on a PR ref: every tier listing surface `pr`,
 * cost-ordered cheapest-first, path-filtered by its `on` globs. `forge
 * doctor` (Forge#12) drives this same selection against HEAD's full tracked
 * file listing to mechanize the green-baseline law (toon-meta#178) — a gate
 * is wired only once this ladder is green. Path globs use the same
 * `*`/`**` semantics as `templates/scripts/check-rule4.mjs`'s hand-rolled
 * matcher (no glob dependency added for this).
 */
import type { FactoryManifest, OracleTier, TierCost } from './manifest.js';

/** The minimal command-runner shape the PR-gate ladder needs. */
export type Execer = (command: string) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

export interface PrGateTierResult {
  readonly tierId: string;
  readonly command: string;
  readonly cost: TierCost;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface PrGateReport {
  readonly results: readonly PrGateTierResult[];
  readonly passed: boolean;
}

const COST_ORDER: Readonly<Record<TierCost, number>> = {
  cheap: 0,
  moderate: 1,
  expensive: 2,
};

function escapeRegExpLiteral(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converts a path glob (`*`/`**`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('**')
    .map((segment) => segment.split('*').map(escapeRegExpLiteral).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * A tier is armed when its `on` globs are empty (§4 — "always armed") or at
 * least one of `files` matches one of them.
 */
export function isArmed(tier: OracleTier, files: readonly string[]): boolean {
  if (tier.on.length === 0) return true;
  const regexps = tier.on.map(globToRegExp);
  return files.some((f) => regexps.some((re) => re.test(f)));
}

/** The manifest's `pr`-surfaced tiers, cost-ordered cheapest-first. */
export function selectPrGateTiers(
  manifest: FactoryManifest
): readonly OracleTier[] {
  return manifest.oracleTiers
    .filter((tier) => tier.surfaces.includes('pr'))
    .slice()
    .sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]);
}

/**
 * Runs the manifest's full `pr`-surfaced tier ladder via `exec`, cost-ordered
 * cheapest-first, skipping any tier not armed by `files`. Every armed tier
 * runs regardless of an earlier tier's failure, so the report always names
 * every red tier at once — never just the first.
 */
export async function runPrGateLadder(
  exec: Execer,
  manifest: FactoryManifest,
  files: readonly string[]
): Promise<PrGateReport> {
  const tiers = selectPrGateTiers(manifest);
  const results: PrGateTierResult[] = [];
  for (const tier of tiers) {
    if (!isArmed(tier, files)) {
      results.push({
        tierId: tier.id,
        command: tier.run,
        cost: tier.cost,
        status: 'skipped',
      });
      continue;
    }
    const execResult = await exec(tier.run);
    results.push({
      tierId: tier.id,
      command: tier.run,
      cost: tier.cost,
      status: execResult.exitCode === 0 ? 'passed' : 'failed',
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    });
  }
  return {
    results,
    passed: results.every((r) => r.status !== 'failed'),
  };
}
