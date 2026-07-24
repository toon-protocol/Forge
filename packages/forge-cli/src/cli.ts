#!/usr/bin/env node
/**
 * `forge` entrypoint.
 *
 * `run` and `review` are live (#24): `run` drives one `agent:implement` issue
 * through forge-core's `runCycle`, and `review` runs the reviewer standalone
 * over one `agent:review` PR — both on the repo's `factory.toml`. `new`
 * resolves a `StampPlan` (#26), stamps it into `--dir` via the stamping
 * engine (#27), runs a post-stamp manifest-validity self-check over the
 * emitted `factory.toml` (#29 — fails the command on any FACTORY_SPEC.md §8
 * violation), then opens (or reuses) the `toon-meta/FACTORY.md` registration
 * PR (#28); `--dry-run` prints the resolved plan instead of
 * writing/validating/registering anything. `validate` (#11) lints
 * `factory.toml` and checks it against the org registry, both directions
 * (registered + pin parity). `doctor` (#12) runs the manifest's full
 * `pr`-surfaced tier ladder against HEAD — cost-ordered, path-filtered — and
 * exits non-zero on red, mechanizing the green-baseline law
 * (toon-meta#178): a gate is wired only once doctor is green. `upgrade`
 * (#13) re-runs the stamping engine over this repo's own `factory.toml`
 * against current templates and, on any diff, opens (or reuses) an ordinary
 * PR through this repo's own gate. The remaining verb (`status`) is a
 * scaffold stub (#212) — it recognizes the surface and exits non-zero so the
 * bin is wired but honest about being empty.
 */

import type { ForgeCommand } from './index.js';
import { version } from './index.js';
import { forgeRun } from './run.js';
import { forgeReview } from './review.js';
import { parseNewArgs, resolveStampPlan, formatStampPlan } from './new.js';
import { stamp } from './stamp.js';
import { validateStampedOutput } from './validate-stamp.js';
import { forgeValidate } from './validate.js';
import { registerFactory } from './register.js';
import { formatDoctorReport, forgeDoctor } from './doctor.js';
import { forgeUpgrade } from './upgrade.js';

const KNOWN: readonly ForgeCommand[] = [
  'run',
  'review',
  'new',
  'validate',
  'doctor',
  'upgrade',
  'status',
];

const STUBBED: readonly ForgeCommand[] = ['status'];

async function main(argv: readonly string[]): Promise<number> {
  const [cmd] = argv;

  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (cmd === 'run') {
    const issueNumber = process.env.SANDCASTLE_ISSUE_NUMBER?.trim();
    if (!issueNumber) {
      process.stderr.write(
        'forge run: SANDCASTLE_ISSUE_NUMBER must be set to the agent:implement issue number.\n'
      );
      return 2;
    }
    const pr = await forgeRun({ issueNumber });
    process.stdout.write(`forge run: opened PR #${pr.number} — ${pr.url}\n`);
    return 0;
  }

  if (cmd === 'review') {
    const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
    if (!prNumber) {
      process.stderr.write(
        'forge review: SANDCASTLE_PR_NUMBER must be set to the agent:review PR number.\n'
      );
      return 2;
    }
    const outcome = await forgeReview({ prNumber });
    process.stdout.write(
      `forge review: ${outcome.pushedCommits} commit(s) pushed to ${outcome.branch}.\n`
    );
    return 0;
  }

  if (cmd === 'new') {
    const args = parseNewArgs(argv.slice(1));
    const plan = await resolveStampPlan(args);
    if (args.dryRun) {
      process.stdout.write(`${formatStampPlan(plan)}\n`);
      return 0;
    }
    const result = await stamp(plan);
    process.stdout.write(
      `forge new: stamped ${result.files.length} file(s) into ${plan.targetDir}\n`
    );

    const validation = await validateStampedOutput(plan);
    for (const warning of validation.warnings) {
      process.stdout.write(`forge new: warning: ${warning}\n`);
    }

    const registration = await registerFactory(result.manifest);
    if (registration.alreadyRegistered) {
      process.stdout.write(
        `forge new: "${plan.factory.name}" is already registered in toon-meta/FACTORY.md — no PR opened.\n`
      );
    } else if (registration.pr) {
      process.stdout.write(
        `forge new: registration PR ${registration.opened ? 'opened' : 'already open'} — #${registration.pr.number} ${registration.pr.url}\n`
      );
    }
    return 0;
  }

  if (cmd === 'validate') {
    const result = await forgeValidate();
    for (const warning of result.warnings) {
      process.stdout.write(`forge validate: warning: ${warning}\n`);
    }
    process.stdout.write(
      `forge validate: "${result.manifest.factory.name}" is valid.\n`
    );
    return 0;
  }

  if (cmd === 'doctor') {
    const report = await forgeDoctor();
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    return report.passed ? 0 : 1;
  }

  if (cmd === 'upgrade') {
    const result = await forgeUpgrade();
    for (const warning of result.warnings) {
      process.stdout.write(`forge upgrade: warning: ${warning}\n`);
    }
    if (!result.changed) {
      process.stdout.write(
        `forge upgrade: "${result.manifest.factory.name}" is already up to date with current templates — no PR opened.\n`
      );
      return 0;
    }
    process.stdout.write(
      `forge upgrade: regenerated ${result.files.length} file(s): ${result.files.join(', ')}\n`
    );
    if (result.pr) {
      process.stdout.write(
        `forge upgrade: PR ${result.opened ? 'opened' : 'already open'} — #${result.pr.number} ${result.pr.url}\n`
      );
    }
    return 0;
  }

  if (cmd !== undefined && (STUBBED as readonly string[]).includes(cmd)) {
    process.stderr.write(
      `forge ${cmd}: not implemented yet (scaffold stub, see #212).\n`
    );
    return 2;
  }

  process.stderr.write(`usage: forge <${KNOWN.join(' | ')}>\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
