/**
 * `forge doctor` (Forge#12) — the green-baseline law (toon-meta#178)
 * mechanized as a command: runs `factory.toml`'s full `pr`-surfaced tier
 * ladder (forge-core's `runPrGateLadder`) against HEAD, cost-ordered
 * cheapest-first and path-filtered by each tier's `on` globs, and reports a
 * green/red verdict per tier. `forge doctor` is the precondition a gate is
 * wired against: `gate.yml` only becomes enforcing once doctor is green on
 * HEAD (ARCHITECTURE.md).
 *
 * Runs directly on HEAD's working tree, not a sandbox and not a PR diff:
 * unlike the inner loop (advisory, mid-cycle `sandbox.exec()`) or `gate.yml`
 * (path-filtered by a PR's changed files), doctor has no base ref to diff
 * against — it proves the ladder passes over every git-tracked file at HEAD
 * right now, which is exactly the "is the oracle actually green" question
 * the green-baseline law asks before a gate can be turned on.
 * `listFiles`/`exec` are injectable so tests never shell out for real.
 */
import { execFileSync, execSync } from 'node:child_process';
import type {
  FactoryManifest,
  PrGateExecer,
  PrGateReport,
} from '@toon-protocol/forge-core';
import { loadManifest, runPrGateLadder } from '@toon-protocol/forge-core';

export interface DoctorDeps {
  /** Path to the `factory.toml` to run doctor against. Defaults to `./factory.toml`. */
  readonly manifestPath?: string;
  /** Lists the files doctor path-filters tiers against. Defaults to `git ls-files` at HEAD. */
  readonly listFiles?: () => readonly string[];
  /** Runs one tier's command. Defaults to a real host shell (`execSync`). */
  readonly exec?: PrGateExecer;
}

export interface DoctorReport extends PrGateReport {
  readonly manifest: FactoryManifest;
}

/** Every git-tracked file at HEAD, relative to the repo root. */
export function listTrackedFiles(): readonly string[] {
  const output = execFileSync('git', ['ls-files'], { encoding: 'utf-8' });
  return output
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Runs `command` through the host shell. Never throws on a non-zero exit —
 * the exit code is the tier's verdict (Determinism Doctrine Rule 1), not an
 * exception doctor needs to catch.
 */
export const execHost: PrGateExecer = (command) => {
  try {
    const stdout = execSync(command, { encoding: 'utf-8' });
    return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
    };
    return Promise.resolve({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    });
  }
};

/**
 * Loads `factory.toml` and runs its full `pr`-surfaced tier ladder against
 * HEAD's tracked files.
 */
export async function forgeDoctor(
  deps: DoctorDeps = {}
): Promise<DoctorReport> {
  const manifestPath = deps.manifestPath ?? 'factory.toml';
  const listFiles = deps.listFiles ?? listTrackedFiles;
  const exec = deps.exec ?? execHost;

  const manifest = await loadManifest(manifestPath);
  const files = listFiles();
  const ladder = await runPrGateLadder(exec, manifest, files);

  return { manifest, ...ladder };
}

/** Formats a doctor report as one verdict line per tier, plus a summary line. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.results.map((r) => {
    if (r.status === 'skipped') {
      return `  skip  ${r.tierId}  (${r.command}) — no matching paths`;
    }
    const verdict = r.status === 'passed' ? 'green' : 'RED ';
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const outputSuffix =
      r.status === 'failed' && output.length > 0 ? `\n${output}` : '';
    return `  ${verdict} ${r.tierId}  (${r.command}) — exit ${r.exitCode}${outputSuffix}`;
  });
  const summary = report.passed
    ? `forge doctor: green — "${report.manifest.factory.name}" passes its full PR-tier ladder on HEAD.`
    : `forge doctor: RED — "${report.manifest.factory.name}" is not green on HEAD; do not wire the gate until it is.`;
  return [...lines, summary].join('\n');
}
