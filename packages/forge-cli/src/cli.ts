#!/usr/bin/env node
/**
 * `forge` entrypoint.
 *
 * `run` is live (#24): it drives one `agent:implement` issue through
 * forge-core's `runCycle` on the repo's `factory.toml`. The remaining verbs
 * are scaffold stubs (#212) — they recognize the surface and exit non-zero so
 * the bin is wired but honest about being empty. They land in #218-#221.
 */

import type { ForgeCommand } from './index.js';
import { version } from './index.js';
import { forgeRun } from './run.js';

const KNOWN: readonly ForgeCommand[] = [
  'run',
  'new',
  'validate',
  'doctor',
  'upgrade',
  'status',
];

const STUBBED: readonly ForgeCommand[] = [
  'new',
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
