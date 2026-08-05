/**
 * Manifest loader — parses and validates `factory.toml` against
 * `FACTORY_SPEC.md` (toon-meta#213, Forge#5).
 *
 * Scope: structural validation against the spec document only (§8 rules
 * 1, 4 (partial), 5, 6, 7, 8). Registry parity against `toon-meta/FACTORY.md`
 * (§8 rules 2, 3 — "unregistered → doesn't exist", "pin mismatch → fail") is
 * `forge validate`'s job (Forge#11): it needs the org registry, an external
 * resource forge-core has no business fetching. Forge holds zero org state.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseToml, TomlError } from 'smol-toml';

export type Role = 'planner' | 'merger' | 'implementer' | 'reviewer';

export const ROLES: readonly Role[] = [
  'planner',
  'merger',
  'implementer',
  'reviewer',
];

export type Surface = 'inner' | 'pr' | 'nightly' | 'dispatch';

const SURFACES: readonly Surface[] = ['inner', 'pr', 'nightly', 'dispatch'];

export type TierCost = 'cheap' | 'moderate' | 'expensive';

const TIER_COSTS: readonly TierCost[] = ['cheap', 'moderate', 'expensive'];

export type EnvironmentKind =
  | 'node-pnpm'
  | 'npm-workspaces'
  | 'docs'
  | 'bevy-spacetime'
  | 'bevy-spacetime-gpu';

const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'node-pnpm',
  'npm-workspaces',
  'docs',
  'bevy-spacetime',
  'bevy-spacetime-gpu',
];

const NODE_ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'node-pnpm',
  'npm-workspaces',
];

export type PrivilegedOperation =
  'golden-regen' | 'pin-bump' | 'threshold-change';

const PRIVILEGED_OPERATIONS: readonly PrivilegedOperation[] = [
  'golden-regen',
  'pin-bump',
  'threshold-change',
];

export interface FactorySection {
  readonly name: string;
  readonly repo: string;
  readonly archetype: string;
  readonly description?: string;
}

export interface EnvironmentSection {
  readonly kind: EnvironmentKind;
  readonly node?: string;
  readonly lockfile: string;
  readonly devbox: boolean;
}

export interface OracleTier {
  readonly id: string;
  readonly run: string;
  readonly on: readonly string[];
  readonly surfaces: readonly Surface[];
  readonly cost: TierCost;
  readonly protected: boolean;
  readonly tolerance?: string;
}

export interface LoopSection {
  readonly template: string;
  readonly innerGates: readonly string[];
  readonly contextCeiling: number;
  readonly models: Readonly<Record<Role, string>>;
}

export interface PrivilegedSection {
  readonly environment: string;
  readonly operations: readonly PrivilegedOperation[];
}

/** A `factory.toml` manifest, parsed and validated against FACTORY_SPEC.md. */
export interface FactoryManifest {
  readonly factory: FactorySection;
  readonly environment: EnvironmentSection;
  readonly loop: LoopSection;
  readonly oracleTiers: readonly OracleTier[];
  readonly privileged?: PrivilegedSection;
}

/** Thrown when a `factory.toml` document fails validation. Carries every violation found, not just the first. */
export class ManifestValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(
      `factory.toml failed validation:\n${errors.map((e) => `  - ${e}`).join('\n')}`
    );
    this.name = 'ManifestValidationError';
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function rejectUnknownKeys(
  table: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[]
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      errors.push(
        `${path}: unknown key "${key}" (§1 — unknown tables/keys must fail validation)`
      );
    }
  }
}

const FACTORY_KEYS = ['name', 'repo', 'archetype', 'description'];

function validateFactory(
  raw: unknown,
  errors: string[]
): FactorySection | undefined {
  if (!isRecord(raw)) {
    errors.push('[factory]: table is required (§2)');
    return undefined;
  }
  rejectUnknownKeys(raw, FACTORY_KEYS, '[factory]', errors);

  const { name, repo, archetype, description } = raw;
  let ok = true;
  if (typeof name !== 'string' || name.length === 0) {
    errors.push('[factory].name: MUST be a non-empty string (§2)');
    ok = false;
  }
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    errors.push('[factory].repo: MUST be "owner/repo" (§2)');
    ok = false;
  }
  if (typeof archetype !== 'string' || archetype.length === 0) {
    errors.push(
      '[factory].archetype: MUST be a non-empty string, or "blank" (§2.1)'
    );
    ok = false;
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('[factory].description: MUST be a string when present (§2)');
    ok = false;
  }
  if (!ok) return undefined;
  return {
    name: name as string,
    repo: repo as string,
    archetype: archetype as string,
    description: description as string | undefined,
  };
}

const ENVIRONMENT_KEYS = ['kind', 'node', 'lockfile', 'devbox'];

function validateEnvironment(
  raw: unknown,
  errors: string[]
): EnvironmentSection | undefined {
  if (!isRecord(raw)) {
    errors.push('[environment]: table is required (§3)');
    return undefined;
  }
  rejectUnknownKeys(raw, ENVIRONMENT_KEYS, '[environment]', errors);

  const { kind, node, lockfile, devbox } = raw;
  let ok = true;
  if (
    typeof kind !== 'string' ||
    !ENVIRONMENT_KINDS.includes(kind as EnvironmentKind)
  ) {
    errors.push(
      `[environment].kind: MUST be one of ${ENVIRONMENT_KINDS.join(' | ')} (§3)`
    );
    ok = false;
  }
  const isNodeKind =
    typeof kind === 'string' &&
    NODE_ENVIRONMENT_KINDS.includes(kind as EnvironmentKind);
  if (isNodeKind && typeof node !== 'string') {
    errors.push(
      '[environment].node: MUST be present for node kinds (§3, §8.8)'
    );
    ok = false;
  }
  if (!isNodeKind && node !== undefined) {
    errors.push(
      '[environment].node: MUST NOT be present for non-node kinds (§3, §8.8)'
    );
    ok = false;
  }
  if (typeof lockfile !== 'string' || lockfile.length === 0) {
    errors.push('[environment].lockfile: MUST be a non-empty string (§3)');
    ok = false;
  }
  if (devbox !== undefined && typeof devbox !== 'boolean') {
    errors.push('[environment].devbox: MUST be a boolean when present (§3)');
    ok = false;
  }
  if (!ok) return undefined;
  return {
    kind: kind as EnvironmentKind,
    node: node as string | undefined,
    lockfile: lockfile as string,
    devbox: (devbox as boolean | undefined) ?? false,
  };
}

const TIER_KEYS = [
  'id',
  'run',
  'on',
  'surfaces',
  'cost',
  'protected',
  'tolerance',
];
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateOracleTiers(
  raw: unknown,
  errors: string[]
): OracleTier[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.tier) || raw.tier.length === 0) {
    errors.push('[[oracle.tier]]: 1 or more tiers are required (§1, §4)');
    return undefined;
  }
  if (Object.keys(raw).some((k) => k !== 'tier')) {
    rejectUnknownKeys(raw, ['tier'], '[oracle]', errors);
  }

  const tiers: OracleTier[] = [];
  const seenIds = new Set<string>();
  let ok = true;
  raw.tier.forEach((entry: unknown, i: number) => {
    const path = `[[oracle.tier]] (index ${i})`;
    if (!isRecord(entry)) {
      errors.push(`${path}: MUST be a table`);
      ok = false;
      return;
    }
    rejectUnknownKeys(entry, TIER_KEYS, path, errors);

    const {
      id,
      run,
      on,
      surfaces,
      cost,
      protected: isProtected,
      tolerance,
    } = entry;
    let tierOk = true;
    if (typeof id !== 'string' || !KEBAB_CASE.test(id)) {
      errors.push(`${path}.id: MUST be a unique kebab-case string (§4)`);
      tierOk = false;
    } else if (seenIds.has(id)) {
      errors.push(
        `${path}.id: duplicate tier id "${id}" (§4 — MUST be unique)`
      );
      tierOk = false;
    } else {
      seenIds.add(id);
    }
    if (typeof run !== 'string' || run.length === 0) {
      errors.push(`${path}.run: MUST be a non-empty command string (§4)`);
      tierOk = false;
    }
    if (!isStringArray(on)) {
      errors.push(`${path}.on: MUST be an array of path globs (§4)`);
      tierOk = false;
    }
    let surfacesValue: Surface[] = [];
    if (
      !isStringArray(surfaces) ||
      surfaces.length === 0 ||
      !surfaces.every((s) => SURFACES.includes(s as Surface))
    ) {
      errors.push(
        `${path}.surfaces: MUST be a non-empty subset of ${SURFACES.join(' | ')} (§4)`
      );
      tierOk = false;
    } else {
      surfacesValue = surfaces as Surface[];
    }
    if (typeof cost !== 'string' || !TIER_COSTS.includes(cost as TierCost)) {
      errors.push(
        `${path}.cost: MUST be one of ${TIER_COSTS.join(' | ')} (§4)`
      );
      tierOk = false;
    }
    if (isProtected !== undefined && typeof isProtected !== 'boolean') {
      errors.push(`${path}.protected: MUST be a boolean when present (§4)`);
      tierOk = false;
    }
    if (tolerance !== undefined && typeof tolerance !== 'string') {
      errors.push(`${path}.tolerance: MUST be a string when present (§4)`);
      tierOk = false;
    }
    if (tierOk) {
      if (surfacesValue.includes('inner') && !surfacesValue.includes('pr')) {
        errors.push(
          `${path}: lists surface "inner" but not "pr" — advisory feedback needs an authoritative backstop (§4.1, §8.6)`
        );
        tierOk = false;
      }
      if (surfacesValue.includes('inner') && cost === 'expensive') {
        errors.push(
          `${path}: lists surface "inner" but cost is "expensive" — inner tiers MUST be cheap (§4.1, §8.6)`
        );
        tierOk = false;
      }
    }
    if (!tierOk) {
      ok = false;
      return;
    }
    tiers.push({
      id: id as string,
      run: run as string,
      on: on as string[],
      surfaces: surfacesValue,
      cost: cost as TierCost,
      protected: (isProtected as boolean | undefined) ?? false,
      tolerance: tolerance as string | undefined,
    });
  });

  return ok ? tiers : undefined;
}

const LOOP_KEYS = ['template', 'inner_gates', 'context_ceiling', 'models'];
const LOOP_MODELS_KEYS: readonly string[] = ROLES;
const DEFAULT_CONTEXT_CEILING = 0.6;

function validateLoop(
  raw: unknown,
  tierIds: ReadonlySet<string> | undefined,
  errors: string[]
): LoopSection | undefined {
  if (!isRecord(raw)) {
    errors.push('[loop]: table is required (§5)');
    return undefined;
  }
  rejectUnknownKeys(raw, LOOP_KEYS, '[loop]', errors);

  const {
    template,
    inner_gates: innerGates,
    context_ceiling: contextCeiling,
    models,
  } = raw;
  let ok = true;
  if (typeof template !== 'string' || template.length === 0) {
    errors.push('[loop].template: MUST be a non-empty string (§5)');
    ok = false;
  }
  if (!isStringArray(innerGates)) {
    errors.push('[loop].inner_gates: MUST be an array of tier ids (§5)');
    ok = false;
  } else if (tierIds) {
    for (const gateId of innerGates) {
      if (!tierIds.has(gateId)) {
        errors.push(
          `[loop].inner_gates: tier id "${gateId}" is not declared in [[oracle.tier]] (§5)`
        );
        ok = false;
      }
    }
  }
  let ceiling: number;
  if (contextCeiling === undefined) {
    ceiling = DEFAULT_CONTEXT_CEILING;
  } else if (
    typeof contextCeiling === 'number' &&
    contextCeiling > 0 &&
    contextCeiling <= 1
  ) {
    ceiling = contextCeiling;
  } else {
    errors.push('[loop].context_ceiling: MUST satisfy 0 < x <= 1 (§5)');
    ok = false;
    ceiling = DEFAULT_CONTEXT_CEILING;
  }
  if (!isRecord(models)) {
    errors.push('[loop.models]: table is required (§5.1, §8.5)');
    ok = false;
  } else {
    rejectUnknownKeys(models, LOOP_MODELS_KEYS, '[loop.models]', errors);
    for (const role of ROLES) {
      if (
        typeof models[role] !== 'string' ||
        (models[role] as string).length === 0
      ) {
        errors.push(
          `[loop.models].${role}: MUST be present (§5.1, §8.5 — all four roles are required)`
        );
        ok = false;
      }
    }
  }
  if (!ok) return undefined;
  const modelsTable = models as Record<string, unknown>;
  return {
    template: template as string,
    innerGates: innerGates as string[],
    contextCeiling: ceiling,
    models: Object.fromEntries(
      ROLES.map((role) => [role, modelsTable[role] as string])
    ) as Record<Role, string>,
  };
}

const PRIVILEGED_KEYS = ['environment', 'operations'];

function validatePrivileged(
  raw: unknown,
  errors: string[]
): PrivilegedSection | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push('[privileged]: MUST be a table when present (§6)');
    return undefined;
  }
  rejectUnknownKeys(raw, PRIVILEGED_KEYS, '[privileged]', errors);

  const { environment, operations } = raw;
  let ok = true;
  if (typeof environment !== 'string' || environment.length === 0) {
    errors.push('[privileged].environment: MUST be a non-empty string (§6)');
    ok = false;
  }
  if (
    !isStringArray(operations) ||
    operations.length === 0 ||
    !operations.every((op) =>
      PRIVILEGED_OPERATIONS.includes(op as PrivilegedOperation)
    )
  ) {
    errors.push(
      `[privileged].operations: MUST be a non-empty subset of ${PRIVILEGED_OPERATIONS.join(' | ')} (§6)`
    );
    ok = false;
  }
  if (!ok) return undefined;
  return {
    environment: environment as string,
    operations: operations as PrivilegedOperation[],
  };
}

const TOP_LEVEL_KEYS = [
  'factory',
  'environment',
  'loop',
  'oracle',
  'privileged',
];

/**
 * Validates a parsed TOML document against FACTORY_SPEC.md and returns the
 * typed manifest. Throws {@link ManifestValidationError} with every
 * violation found (not just the first) when the document fails.
 */
export function validateManifest(raw: unknown): FactoryManifest {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    throw new ManifestValidationError([
      'factory.toml: document root MUST be a table',
    ]);
  }
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, '(root)', errors);

  const factory = validateFactory(raw.factory, errors);
  const environment = validateEnvironment(raw.environment, errors);
  const oracleTiers = validateOracleTiers(raw.oracle, errors);
  const loop = validateLoop(
    raw.loop,
    oracleTiers ? new Set(oracleTiers.map((t) => t.id)) : undefined,
    errors
  );
  const privileged = validatePrivileged(raw.privileged, errors);

  if (oracleTiers && oracleTiers.some((t) => t.protected)) {
    if (!privileged || !privileged.operations.includes('golden-regen')) {
      errors.push(
        '[privileged]: a protected tier exists, so [privileged].operations MUST include "golden-regen" (§6, §8.7)'
      );
    }
  }

  if (errors.length > 0 || !factory || !environment || !loop || !oracleTiers) {
    throw new ManifestValidationError(errors);
  }

  return { factory, environment, loop, oracleTiers, privileged };
}

/** Parses a `factory.toml` source string and validates it against FACTORY_SPEC.md. */
export function parseManifest(source: string): FactoryManifest {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new ManifestValidationError([
        `factory.toml: TOML syntax error — ${err.message}`,
      ]);
    }
    throw err;
  }
  return validateManifest(raw);
}

/** Reads and validates the `factory.toml` at `path`. */
export async function loadManifest(path: string): Promise<FactoryManifest> {
  const source = await readFile(path, 'utf-8');
  return parseManifest(source);
}
const red272Proof: number = "deliberately red";
