/**
 * Post-stamp self-check (Forge#29) — after `stamp()` (Forge#27) writes a
 * factory tree, re-reads the emitted `factory.toml` from disk and validates
 * it through forge-core's own manifest validator (FACTORY_SPEC.md §8),
 * independently of stamp.ts's pre-write in-memory check (`parseManifest` on
 * the not-yet-written text). Re-reading from disk means a stamping-engine
 * regression that emits well-formed-but-invalid output is caught as a red
 * gate, not a silently broken factory. `forge new` fails the command on any
 * §8 violation this surfaces.
 *
 * Registry parity (§8.2-§8.3 — needs `toon-meta/FACTORY.md`) is out of
 * scope: same "Forge holds zero org state" boundary manifest.ts's own module
 * doc draws; that's `forge validate`'s job (Forge#11).
 *
 * Archetype drift (§2.1) and model divergence from org policy (§5.1) are
 * computed and returned as warnings — reported, never failing the command.
 */
import { join } from 'node:path';
import type { FactoryManifest } from '@toon-protocol/forge-core';
import { loadManifest, ROLES } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';
import type { StampDeps } from './stamp.js';
import {
  DEFAULT_MODELS,
  defaultTemplatesRoot,
  loadArchetypeExample,
} from './stamp.js';

/** The result of a successful post-stamp self-check. */
export interface PostStampValidation {
  readonly manifest: FactoryManifest;
  /** Non-failing surfaces: archetype drift (§2.1) + model divergence (§5.1). */
  readonly warnings: readonly string[];
}

async function archetypeDriftWarnings(
  manifest: FactoryManifest,
  archetype: string,
  templatesRoot: string
): Promise<string[]> {
  if (archetype === 'blank') return [];

  const pinned = await loadArchetypeExample(templatesRoot, archetype);
  const warnings: string[] = [];
  const pinnedById = new Map(pinned.oracleTiers.map((t) => [t.id, t]));

  for (const tier of manifest.oracleTiers) {
    const pinnedTier = pinnedById.get(tier.id);
    if (!pinnedTier) {
      warnings.push(
        `archetype drift: tier "${tier.id}" is not part of archetype "${archetype}"'s pinned ladder (§2.1)`
      );
      continue;
    }
    if (tier.run !== pinnedTier.run) {
      warnings.push(
        `archetype drift: tier "${tier.id}".run diverges from archetype "${archetype}"'s pinned command ` +
          `(stamped "${tier.run}", pinned "${pinnedTier.run}") (§2.1)`
      );
    }
  }
  for (const pinnedTier of pinned.oracleTiers) {
    if (!manifest.oracleTiers.some((t) => t.id === pinnedTier.id)) {
      warnings.push(
        `archetype drift: archetype "${archetype}"'s pinned tier "${pinnedTier.id}" is missing from the stamped ladder (§2.1)`
      );
    }
  }
  return warnings;
}

function modelDivergenceWarnings(manifest: FactoryManifest): string[] {
  const warnings: string[] = [];
  for (const role of ROLES) {
    const actual = manifest.loop.models[role];
    const expected = DEFAULT_MODELS[role];
    if (actual !== expected) {
      warnings.push(
        `model divergence: [loop.models].${role} = "${actual}" diverges from org policy "${expected}" ` +
          `(§5.1) — manifest value is authoritative, this is advisory`
      );
    }
  }
  return warnings;
}

/**
 * Re-reads `<plan.targetDir>/factory.toml` from disk and validates it
 * through forge-core's `loadManifest` — throws `ManifestValidationError` on
 * any FACTORY_SPEC.md §8 structural violation. On success, returns the
 * reparsed manifest plus archetype-drift / model-divergence warnings.
 */
export async function validateStampedOutput(
  plan: StampPlan,
  deps: StampDeps = {}
): Promise<PostStampValidation> {
  const templatesRoot = deps.templatesRoot ?? defaultTemplatesRoot();
  const manifest = await loadManifest(join(plan.targetDir, 'factory.toml'));

  const warnings = [
    ...(await archetypeDriftWarnings(
      manifest,
      plan.factory.archetype,
      templatesRoot
    )),
    ...modelDivergenceWarnings(manifest),
  ];

  return { manifest, warnings };
}
