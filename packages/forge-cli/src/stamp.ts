/**
 * The template-stamping engine (Forge#27) — turns a resolved `StampPlan`
 * (`new.ts`, Forge#26) into an on-disk factory tree: `factory.toml`,
 * `.sandcastle/`, `.github/workflows/`, `scripts/`, and a `verify/`
 * skeleton, sourced from the already-shipped `templates/` substrate
 * (Forge#9) plus a manifest built from the plan.
 *
 * Writes no PR — that's the sibling registration-PR-opener slice (Forge#28).
 * Pure aside from filesystem I/O: `templatesRoot` is injectable so tests can
 * point at a fixture tree, and every write is a deterministic function of
 * the input `StampPlan` (no timestamps, no randomness) — re-stamping the
 * same plan into the same target dir is idempotent (byte-identical output),
 * satisfying the "verifiable against a temp target dir" acceptance
 * criterion without a real Actions run.
 */
import { mkdir, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify } from 'smol-toml';
import type {
  EnvironmentKind,
  FactoryManifest,
  OracleTier,
  PrivilegedSection,
  Role,
} from '@toon-protocol/forge-core';
import { parseManifest } from '@toon-protocol/forge-core';
import type { StampPlan } from './new.js';

/** Per-role model tiering (toon-meta#202), the org policy default for every stamped factory. */
const DEFAULT_MODELS: Readonly<Record<Role, string>> = {
  planner: 'claude-opus-4-8',
  merger: 'claude-opus-4-8',
  implementer: 'claude-sonnet-5',
  reviewer: 'claude-sonnet-5',
};

/** FACTORY_SPEC.md §5's default stop-and-handoff fraction. */
const DEFAULT_CONTEXT_CEILING = 0.6;

const DEFAULT_LOOP_TEMPLATE = 'parallel-planner-with-review';

interface DefaultLadder {
  readonly tiers: readonly OracleTier[];
  readonly innerGates: readonly string[];
}

function tier(
  id: string,
  run: string,
  on: readonly string[],
  surfaces: OracleTier['surfaces'],
  cost: OracleTier['cost']
): OracleTier {
  return { id, run, on, surfaces, cost, protected: false };
}

/**
 * The `--blank` environment-level oracle ladder (no archetype opinions) —
 * proven per-kind toolchain commands, same shape as this repo's own
 * hand-authored `factory.toml` for `node-pnpm`. `docs` has no established
 * prose linter in the org yet, so its one tier is wired through a `verify/`
 * stub the stamped repo fills in (see {@link verifyStubId}).
 */
function defaultLadderForKind(kind: EnvironmentKind): DefaultLadder {
  switch (kind) {
    case 'node-pnpm':
    case 'npm-workspaces':
      return {
        tiers: [
          tier('t0-lint', 'pnpm lint', ['**/*.ts'], ['inner', 'pr'], 'cheap'),
          tier(
            't1-typecheck',
            'pnpm typecheck',
            ['**/*.ts'],
            ['inner', 'pr'],
            'cheap'
          ),
          tier('t2-test', 'pnpm test', ['**/*.ts'], ['pr'], 'moderate'),
          tier('t3-build', 'pnpm build', ['**/*.ts'], ['pr'], 'moderate'),
        ],
        innerGates: ['t0-lint', 't1-typecheck'],
      };
    case 'docs':
      return {
        tiers: [
          tier(
            't0-prose-check',
            'bash verify/t0-prose-check.sh',
            ['**/*.md'],
            ['pr'],
            'moderate'
          ),
        ],
        innerGates: [],
      };
    case 'bevy-spacetime':
    case 'bevy-spacetime-gpu':
      return {
        tiers: [
          tier(
            't0-fmt-lint',
            'cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings',
            ['**/*.rs'],
            ['inner', 'pr'],
            'cheap'
          ),
          tier(
            't1-build',
            'cargo check --workspace --all-targets',
            ['**/*.rs', 'Cargo.toml', 'Cargo.lock'],
            ['inner', 'pr'],
            'cheap'
          ),
          tier(
            't2-test',
            'cargo test --workspace',
            ['**/*.rs'],
            ['pr'],
            'moderate'
          ),
        ],
        innerGates: ['t0-fmt-lint', 't1-build'],
      };
  }
}

const VERIFY_STUB_RUN = /^bash verify\/(.+)\.sh$/;

/** Extracts the verify-script id a tier's `run` command wires to, if any. */
function verifyStubId(run: string): string | undefined {
  return VERIFY_STUB_RUN.exec(run)?.[1];
}

export interface StampDeps {
  /** Root of the `templates/` substrate. Defaults to this repo's own `templates/`. */
  readonly templatesRoot?: string;
}

export interface StampResult {
  readonly manifest: FactoryManifest;
  /** Relative (posix) paths written under the target dir, sorted. */
  readonly files: readonly string[];
}

function defaultTemplatesRoot(): string {
  return fileURLToPath(new URL('../../../templates/', import.meta.url));
}

async function readTemplateFile(
  templatesRoot: string,
  relPath: string
): Promise<string> {
  return readFile(join(templatesRoot, relPath), 'utf-8');
}

async function readTemplateFileIfExists(
  templatesRoot: string,
  relPath: string
): Promise<string | undefined> {
  try {
    return await readTemplateFile(templatesRoot, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeStampedFile(
  targetDir: string,
  relPath: string,
  content: string,
  options: { readonly executable?: boolean } = {}
): Promise<void> {
  const abs = join(targetDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  if (options.executable) {
    await chmod(abs, 0o755);
  }
}

/** Builds the raw (TOML-shape) object `factory.toml` serializes from. */
function toRawManifest(manifest: FactoryManifest): Record<string, unknown> {
  return {
    factory: { ...manifest.factory },
    environment: { ...manifest.environment },
    loop: {
      template: manifest.loop.template,
      inner_gates: manifest.loop.innerGates,
      context_ceiling: manifest.loop.contextCeiling,
      models: { ...manifest.loop.models },
    },
    oracle: {
      tier: manifest.oracleTiers.map((t) => ({
        id: t.id,
        run: t.run,
        on: t.on,
        surfaces: t.surfaces,
        cost: t.cost,
        ...(t.protected ? { protected: t.protected } : {}),
        ...(t.tolerance !== undefined ? { tolerance: t.tolerance } : {}),
      })),
    },
    ...(manifest.privileged
      ? {
          privileged: {
            environment: manifest.privileged.environment,
            operations: manifest.privileged.operations,
          },
        }
      : {}),
  };
}

/** Serializes a {@link FactoryManifest} to `factory.toml` source text. */
export function serializeManifest(manifest: FactoryManifest): string {
  return stringify(toRawManifest(manifest));
}

/**
 * Loads an archetype's worked `factory.toml.example` (§2.1 pinned template
 * set) from `templates/archetypes/<name>/`. Only reachable when a
 * `StampPlan` names a non-`"blank"` archetype — `resolveStampPlan` (Forge#26)
 * only produces one for archetypes minted in `toon-meta/FACTORY.md`'s
 * catalog, so this throws (rather than reports "unminted") on a name it
 * can't find: by the time a plan reaches the stamping engine, that check
 * already happened upstream.
 */
async function loadArchetypeExample(
  templatesRoot: string,
  archetype: string
): Promise<FactoryManifest> {
  const source = await readTemplateFile(
    templatesRoot,
    `archetypes/${archetype}/factory.toml.example`
  );
  return parseManifest(source);
}

interface ResolvedLadder {
  readonly oracleTiers: readonly OracleTier[];
  readonly loopTemplate: string;
  readonly innerGates: readonly string[];
  readonly privileged?: PrivilegedSection;
}

async function resolveLadder(
  plan: StampPlan,
  templatesRoot: string
): Promise<ResolvedLadder> {
  if (plan.factory.archetype === 'blank') {
    const ladder = defaultLadderForKind(plan.environment.kind);
    return {
      oracleTiers: ladder.tiers,
      loopTemplate: DEFAULT_LOOP_TEMPLATE,
      innerGates: ladder.innerGates,
      privileged: undefined,
    };
  }

  const example = await loadArchetypeExample(
    templatesRoot,
    plan.factory.archetype
  );
  return {
    // A protected tier's real oracle logic (golden/hash checks) is the
    // pilot's own engineering, not something the stamping engine can
    // fabricate — rewire it to a verify/ stub the pilot fills in, same
    // convention as the blank ladder's `bash verify/<id>.sh` tiers.
    oracleTiers: example.oracleTiers.map((t) =>
      t.protected ? { ...t, run: `bash verify/${t.id}.sh` } : t
    ),
    loopTemplate: example.loop.template,
    innerGates: example.loop.innerGates,
    privileged: example.privileged,
  };
}

/** Builds the {@link FactoryManifest} a `StampPlan` stamps — the AC's "cost-ordered `[[oracle.tier]]` ladder + required `[loop.models]`". */
async function buildManifest(
  plan: StampPlan,
  templatesRoot: string
): Promise<FactoryManifest> {
  const ladder = await resolveLadder(plan, templatesRoot);
  return {
    factory: plan.factory,
    environment: plan.environment,
    loop: {
      template: ladder.loopTemplate,
      innerGates: ladder.innerGates,
      contextCeiling: DEFAULT_CONTEXT_CEILING,
      models: { ...DEFAULT_MODELS },
    },
    oracleTiers: ladder.oracleTiers,
    privileged: ladder.privileged,
  };
}

function gateCommandsMarkdown(manifest: FactoryManifest): string {
  const prTiers = manifest.oracleTiers.filter((t) => t.surfaces.includes('pr'));
  return prTiers.map((t) => `- ${t.id}: \`${t.run}\``).join('\n');
}

function substituteStampTimeTokens(
  content: string,
  manifest: FactoryManifest
): string {
  const contextCeilingPct = `${Math.round(manifest.loop.contextCeiling * 100)}%`;
  return content
    .replaceAll('__GATE_COMMANDS__', gateCommandsMarkdown(manifest))
    .replaceAll('__CONTEXT_CEILING_PCT__', contextCeilingPct);
}

/** Verbatim-copy templates (no stamp-time substitution) making up the `.sandcastle/` prompt bundle. */
const SANDCASTLE_VERBATIM_FILES = [
  'plan-prompt.md',
  'CODING_STANDARDS.md',
  '.env.example',
  '.gitignore',
] as const;

/** Templates requiring `__GATE_COMMANDS__`/`__CONTEXT_CEILING_PCT__` substitution. */
const SANDCASTLE_TEMPLATED_FILES = [
  'implement-prompt.md',
  'review-prompt.md',
] as const;

function verifyReadme(manifest: FactoryManifest): string {
  const rows = manifest.oracleTiers
    .map(
      (t) =>
        `| \`${t.id}\` | \`${t.run}\` | ${t.surfaces.join(', ')} | ${t.cost} | ${t.protected ? 'yes' : 'no'} |`
    )
    .join('\n');
  return `# \`verify/\` — this factory's oracle-protected zone

Rule 4 (ARCHITECTURE.md §3): no PR may touch this factory's oracle code and the
system-under-test it judges in the same diff. \`scripts/check-rule4.mjs\`
defaults the protected zone to \`verify/**\` — put this factory's real gate
runners here as they're implemented.

## This factory's oracle tiers (\`factory.toml\`)

| id | run | surfaces | cost | protected |
|---|---|---|---|---|
${rows}

Tiers whose \`run\` invokes \`bash verify/<id>.sh\` are wired to a stub script in
this directory — fill in the real check before relying on it.
`;
}

function verifyStubScript(id: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# TODO: implement this factory's "${id}" oracle tier (factory.toml's
# [[oracle.tier]] id = "${id}"). See verify/README.md for the full ladder.
echo "verify/${id}.sh: not yet implemented" >&2
exit 1
`;
}

/**
 * Stamps a resolved {@link StampPlan} into an on-disk factory tree:
 * `factory.toml`, `.sandcastle/`, `.github/workflows/`, `scripts/`, and a
 * `verify/` skeleton. Writes nothing else (no PR — Forge#28).
 */
export async function stamp(
  plan: StampPlan,
  deps: StampDeps = {}
): Promise<StampResult> {
  const templatesRoot = deps.templatesRoot ?? defaultTemplatesRoot();
  const targetDir = plan.targetDir;

  const manifest = await buildManifest(plan, templatesRoot);
  const manifestText = serializeManifest(manifest);
  // Self-check: the emitted factory.toml must itself be spec-valid before
  // it's written (FACTORY_SPEC.md, forge-core's own validator).
  parseManifest(manifestText);

  const files: string[] = [];

  await writeStampedFile(targetDir, 'factory.toml', manifestText);
  files.push('factory.toml');

  const workflowFiles = (
    await readdir(join(templatesRoot, 'workflows'))
  ).sort();
  for (const name of workflowFiles) {
    const content = await readTemplateFile(templatesRoot, `workflows/${name}`);
    const relPath = `.github/workflows/${name}`;
    await writeStampedFile(targetDir, relPath, content);
    files.push(relPath);
  }

  const dockerfile = await readTemplateFile(
    templatesRoot,
    `dockerfiles/${manifest.environment.kind}/Dockerfile`
  );
  await writeStampedFile(targetDir, '.sandcastle/Dockerfile', dockerfile);
  files.push('.sandcastle/Dockerfile');

  for (const name of SANDCASTLE_VERBATIM_FILES) {
    const content = await readTemplateFile(templatesRoot, `sandcastle/${name}`);
    const relPath = `.sandcastle/${name}`;
    await writeStampedFile(targetDir, relPath, content);
    files.push(relPath);
  }
  for (const name of SANDCASTLE_TEMPLATED_FILES) {
    const raw = await readTemplateFile(templatesRoot, `sandcastle/${name}`);
    const relPath = `.sandcastle/${name}`;
    await writeStampedFile(
      targetDir,
      relPath,
      substituteStampTimeTokens(raw, manifest)
    );
    files.push(relPath);
  }

  const scriptFiles = (await readdir(join(templatesRoot, 'scripts'))).sort();
  for (const name of scriptFiles) {
    const content = await readTemplateFile(templatesRoot, `scripts/${name}`);
    const relPath = `scripts/${name}`;
    await writeStampedFile(targetDir, relPath, content);
    files.push(relPath);
  }

  await writeStampedFile(targetDir, 'verify/README.md', verifyReadme(manifest));
  files.push('verify/README.md');
  for (const t of manifest.oracleTiers) {
    const id = verifyStubId(t.run);
    if (id === undefined) continue;
    const relPath = `verify/${id}.sh`;
    await writeStampedFile(targetDir, relPath, verifyStubScript(id), {
      executable: true,
    });
    files.push(relPath);
  }

  // The archetype branch applies the archetype's pinned template set (AC a);
  // `--blank` stamps a bare environment with zero archetype opinions (AC b)
  // — so DOCTRINE.md, the archetype-specific doctrine, is only ever written
  // when an archetype was actually resolved.
  if (plan.factory.archetype !== 'blank') {
    const doctrine = await readTemplateFileIfExists(
      templatesRoot,
      `archetypes/${plan.factory.archetype}/DOCTRINE.md`
    );
    if (doctrine !== undefined) {
      await writeStampedFile(targetDir, 'DOCTRINE.md', doctrine);
      files.push('DOCTRINE.md');
    }
  }

  return { manifest, files: files.sort() };
}
