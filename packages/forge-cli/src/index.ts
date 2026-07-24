/**
 * @toon-protocol/forge-cli — the `forge` command surface.
 *
 * Verbs (all stubs at scaffold time, #212):
 *   forge new <archetype>  — stamp a factory + open the FACTORY.md registration PR (#218)
 *   forge validate         — manifest lint + registry parity, both directions (#219)
 *   forge doctor           — run the full PR-tier ladder against HEAD (#220)
 *   forge upgrade          — regenerate stamped files from templates as a gated PR (#221)
 */

import { FORGE_CORE_VERSION } from '@toon-protocol/forge-core';

/** The `forge` verbs planned for this CLI. */
export type ForgeCommand =
  'run' | 'new' | 'validate' | 'doctor' | 'upgrade' | 'status';

/** Scaffold placeholder: reports the linked forge-core version. */
export function version(): string {
  return FORGE_CORE_VERSION;
}
