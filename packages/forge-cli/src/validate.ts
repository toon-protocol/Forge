/**
 * `forge validate` (Forge#11) — lints the local `factory.toml` against
 * FACTORY_SPEC.md, then checks it against the org registry
 * (`toon-meta/FACTORY.md`), which `forge validate` treats as authoritative
 * (ARCHITECTURE.md §2): registry parity, proved in **both directions**:
 *
 *   1. **Unregistered → does not exist (§8.2).** No `FACTORY.md` row keyed
 *      by `[factory].name` — fails.
 *   2. **Pin mismatch → fail (§8.3).** A registered row exists, but its
 *      `Pkg mgr` / `Template` / `Gate` pins — the same cells
 *      `register.ts`'s `buildFactoryRow` derives from a manifest at
 *      registration time — disagree with what this manifest resolves to
 *      now — fails.
 *
 * Manifest structural lint (§8 rules 1, 4 partial, 5-8) is forge-core's own
 * `loadManifest` — run first, so a structurally invalid manifest fails fast
 * without ever fetching the registry. The registry-dependent half of rule 4
 * (archetype MUST be `"blank"` or minted in the catalog) closes the "partial"
 * gap manifest.ts's own module doc names, since only `forge validate` has
 * the registry in hand. Archetype drift (§2.1) and model divergence (§5.1)
 * are reused verbatim from the post-stamp self-check (`validate-stamp.ts`,
 * Forge#29) and reported as warnings — visible, never failing.
 *
 * `fetchRegistry` is the one real `gh` seam — untested-by-design, same
 * convention as `new.ts`'s `fetchArchetypeCatalog` / `register.ts`'s
 * `defaultRegistryGhClient`. Everything else is pure/injectable, so both
 * directions of the registry-parity guard are proved against throwaway
 * fixture registry markdown in tests, with no dependence on live org state.
 */
import { execFileSync } from 'node:child_process';
import type { FactoryManifest } from '@toon-protocol/forge-core';
import {
  loadManifest,
  ManifestValidationError,
} from '@toon-protocol/forge-core';
import {
  escapeCell,
  findFactoryRowCells,
  gateSummary,
  pkgMgrLabel,
} from './register.js';
import { parseArchetypeCatalog } from './new.js';
import { defaultTemplatesRoot } from './stamp.js';
import {
  archetypeDriftWarnings,
  modelDivergenceWarnings,
} from './validate-stamp.js';

const REGISTRY_REPO = 'toon-protocol/toon-meta';
const REGISTRY_PATH = 'FACTORY.md';

export interface ValidateDeps {
  /** Path to the `factory.toml` to validate. Defaults to `./factory.toml`. */
  readonly manifestPath?: string;
  /** Root of the `templates/` substrate, for archetype-drift comparison. Defaults to this repo's own `templates/`. */
  readonly templatesRoot?: string;
  /** Fetches `toon-meta/FACTORY.md`'s raw markdown. Defaults to a real `gh api` call. */
  readonly fetchRegistry?: () => Promise<string>;
}

export interface ValidateResult {
  readonly manifest: FactoryManifest;
  /** Non-failing surfaces: archetype drift (§2.1) + model divergence (§5.1). */
  readonly warnings: readonly string[];
}

function decodeBase64(content: string): string {
  return Buffer.from(content, 'base64').toString('utf-8');
}

/** Reads `toon-meta/FACTORY.md` via the host `gh`. */
export function fetchRegistryMarkdown(): Promise<string> {
  const json = execFileSync(
    'gh',
    ['api', `repos/${REGISTRY_REPO}/contents/${REGISTRY_PATH}`],
    { encoding: 'utf-8' }
  );
  const parsed = JSON.parse(json) as { content: string };
  return Promise.resolve(decodeBase64(parsed.content));
}

/** The registered row's pin cells, as `register.ts`'s `buildFactoryRow` would derive them from this manifest right now. */
function expectedPinCells(manifest: FactoryManifest): {
  readonly pkgMgr: string;
  readonly template: string;
  readonly gate: string;
} {
  return {
    pkgMgr: escapeCell(pkgMgrLabel(manifest.environment.kind)),
    template: escapeCell(manifest.loop.template),
    gate: escapeCell(gateSummary(manifest.oracleTiers)),
  };
}

function registryParityErrors(
  manifest: FactoryManifest,
  registry: string
): string[] {
  const errors: string[] = [];
  const row = findFactoryRowCells(registry, manifest.factory.name);

  if (!row) {
    errors.push(
      `[factory].name: "${manifest.factory.name}" has no matching row in toon-meta/FACTORY.md's ` +
        `"## Per-repo factory table" — unregistered factories do not exist (§8.2)`
    );
    return errors;
  }

  const [, registeredPkgMgr, registeredTemplate, registeredGate] = row;
  const expected = expectedPinCells(manifest);
  if (registeredPkgMgr !== expected.pkgMgr) {
    errors.push(
      `[environment].kind: registered "Pkg mgr" pin is "${registeredPkgMgr}", ` +
        `manifest resolves to "${expected.pkgMgr}" (§8.3 — registry parity)`
    );
  }
  if (registeredTemplate !== expected.template) {
    errors.push(
      `[loop].template: registered "Template" pin is "${registeredTemplate}", ` +
        `manifest has "${expected.template}" (§8.3 — registry parity)`
    );
  }
  if (registeredGate !== expected.gate) {
    errors.push(
      `[[oracle.tier]]: registered "Gate" pin is "${registeredGate}", manifest's ` +
        `PR-surfaced tiers resolve to "${expected.gate}" (§8.3 — registry parity)`
    );
  }
  return errors;
}

function archetypeProvenanceErrors(
  manifest: FactoryManifest,
  registry: string
): string[] {
  if (manifest.factory.archetype === 'blank') return [];
  const entry = parseArchetypeCatalog(registry).find(
    (e) => e.name === manifest.factory.archetype
  );
  if (entry?.minted) return [];
  return [
    `[factory].archetype: "${manifest.factory.archetype}" is not a minted archetype in ` +
      `toon-meta/FACTORY.md's catalog (§2.1, §8.4)`,
  ];
}

/**
 * Lints `factory.toml` against FACTORY_SPEC.md, then checks it against the
 * org registry — both directions of registry parity, plus the
 * registry-dependent half of the archetype-provenance rule. Throws
 * `ManifestValidationError` on any failure (structural or registry); on
 * success, returns the manifest plus archetype-drift / model-divergence
 * warnings.
 */
export async function forgeValidate(
  deps: ValidateDeps = {}
): Promise<ValidateResult> {
  const manifestPath = deps.manifestPath ?? 'factory.toml';
  const templatesRoot = deps.templatesRoot ?? defaultTemplatesRoot();
  const fetchRegistry = deps.fetchRegistry ?? fetchRegistryMarkdown;

  // §8 rules 1, 4 (partial), 5-8 — structural lint. Runs first: a
  // structurally invalid manifest fails fast without fetching the registry.
  const manifest = await loadManifest(manifestPath);

  const registry = await fetchRegistry();
  const errors = [
    ...registryParityErrors(manifest, registry),
    ...archetypeProvenanceErrors(manifest, registry),
  ];
  if (errors.length > 0) {
    throw new ManifestValidationError(errors);
  }

  const warnings = [
    ...(await archetypeDriftWarnings(
      manifest,
      manifest.factory.archetype,
      templatesRoot
    )),
    ...modelDivergenceWarnings(manifest),
  ];

  return { manifest, warnings };
}
