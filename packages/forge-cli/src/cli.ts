#!/usr/bin/env node
/**
 * `forge` entrypoint. Scaffold stub (#212): recognizes the verb surface and
 * exits non-zero for anything not yet implemented, so the bin is wired but
 * honest about being empty. Real verbs land in #218-#221.
 */

import type { ForgeCommand } from "./index.js";
import { version } from "./index.js";

const KNOWN: readonly ForgeCommand[] = ["new", "validate", "doctor", "upgrade", "status"];

function main(argv: readonly string[]): number {
  const [cmd] = argv;
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (cmd !== undefined && (KNOWN as readonly string[]).includes(cmd)) {
    process.stderr.write(`forge ${cmd}: not implemented yet (scaffold stub, see #212).\n`);
    return 2;
  }
  process.stderr.write(`usage: forge <${KNOWN.join(" | ")}>\n`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
