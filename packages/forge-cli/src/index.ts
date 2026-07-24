/**
 * @toon-protocol/forge-cli — the `forge` command surface.
 *
 * Verbs:
 *   forge run              — drive one agent:implement issue via forge-core's runCycle (#24a)
 *   forge review           — run the reviewer standalone over an agent:review PR (#24b)
 *   forge new <archetype>  — stamp a factory (#26, #27); registration-PR opener is #28
 *   forge validate         — manifest lint + registry parity, both directions (#219, stub)
 *   forge doctor           — run the full PR-tier ladder against HEAD (#220, stub)
 *   forge upgrade          — regenerate stamped files from templates as a gated PR (#221, stub)
 */

import { FORGE_CORE_VERSION } from '@toon-protocol/forge-core';

/** The `forge` verbs planned for this CLI. */
export type ForgeCommand =
  'run' | 'review' | 'new' | 'validate' | 'doctor' | 'upgrade' | 'status';

/** Scaffold placeholder: reports the linked forge-core version. */
export function version(): string {
  return FORGE_CORE_VERSION;
}
