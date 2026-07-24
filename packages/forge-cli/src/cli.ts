#!/usr/bin/env node
/**
 * `forge` entrypoint.
 *
 * `run` and `review` are live (#24): `run` drives one `agent:implement` issue
 * through forge-core's `runCycle`, and `review` runs the reviewer standalone
 * over one `agent:review` PR — both on the repo's `factory.toml`. `new`
 * resolves a `StampPlan` (#26) and stamps it into `--dir` via the stamping
 * engine (#27); `--dry-run` prints the resolved plan instead of writing
 * anything. Opening the `FACTORY.md` registration PR is the sibling #28
 * slice, not yet wired in here. The remaining verbs are scaffold stubs
 * (#212) — they recognize the surface and exit non-zero so the bin is wired
 * but honest about being empty. They land in #219-#221.
 */

import type { ForgeCommand } from './index.js';
import { version } from './index.js';
import { forgeRun } from './run.js';
import { forgeReview } from './review.js';
import { parseNewArgs, resolveStampPlan, formatStampPlan } from './new.js';
import { stamp } from './stamp.js';

const KNOWN: readonly ForgeCommand[] = [
  'run',
  'review',
  'new',
  'validate',
  'doctor',
  'upgrade',
  'status',
];

const STUBBED: readonly ForgeCommand[] = [
  'validate',
  'doctor',
  'upgrade',
  'status',
];

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
