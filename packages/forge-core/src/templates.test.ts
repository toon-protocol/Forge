import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  classify,
  DEFAULT_PROTECTED_PATHS,
  globToRegExp,
  parseProtectedPaths,
} from '../../../templates/scripts/check-rule4.mjs';
import { parseManifest } from './manifest.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readTemplate(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8');
}

type ArchetypeToml = {
  archetype: {
    name: string;
    environment: string;
    doctrine: string;
    manifest_example: string;
    oracle_tiers: string[];
    status?: unknown;
    minted?: unknown;
    proving_repo?: unknown;
  };
};

function readArchetypeToml(name: string): ArchetypeToml {
  return parseToml(
    readTemplate(`templates/archetypes/${name}/archetype.toml`)
  ) as ArchetypeToml;
}

describe('templates/workflows — inventory (toon-protocol/Forge#9)', () => {
  it('ships exactly the five required workflow templates', () => {
    const files = readdirSync(`${repoRoot}templates/workflows`).sort();
    expect(files).toEqual(
      [
        'agent-implement.yml',
        'agent-review.yml',
        'gate.yml',
        'golden-regen.yml',
        'nightly.yml',
      ].sort()
    );
  });
});

describe('templates/dockerfiles — inventory (four proven/prepared shapes)', () => {
  it('ships node-pnpm, npm-workspaces, docs, and bevy-spacetime shapes', () => {
    const dirs = readdirSync(`${repoRoot}templates/dockerfiles`).sort();
    expect(dirs).toEqual(
      ['node-pnpm', 'npm-workspaces', 'docs', 'bevy-spacetime'].sort()
    );
    for (const dir of dirs) {
      const dockerfile = readTemplate(
        `templates/dockerfiles/${dir}/Dockerfile`
      );
      expect(dockerfile).toContain('claude.ai/install.sh');
      expect(dockerfile).toMatch(/ENTRYPOINT \["sleep", "infinity"\]/);
    }
  });

  it('keeps node absent from the non-node docs and bevy-spacetime shapes (FACTORY_SPEC.md §3)', () => {
    for (const dir of ['docs', 'bevy-spacetime']) {
      const dockerfile = readTemplate(
        `templates/dockerfiles/${dir}/Dockerfile`
      );
      expect(dockerfile).not.toMatch(/FROM node:/);
    }
  });
});

describe('templates/sandcastle/ — .sandcastle/ prompt bundle (toon-protocol/Forge#27)', () => {
  it('ships exactly the six bundle files', () => {
    const files = readdirSync(`${repoRoot}templates/sandcastle`).sort();
    expect(files).toEqual(
      [
        'plan-prompt.md',
        'implement-prompt.md',
        'review-prompt.md',
        'CODING_STANDARDS.md',
        '.env.example',
        '.gitignore',
      ].sort()
    );
  });

  it('leaves sandcastle runtime tokens untouched but carries stamp-time placeholders', () => {
    const implement = readTemplate('templates/sandcastle/implement-prompt.md');
    expect(implement).toContain('{{TASK_ID}}');
    expect(implement).toContain('{{ISSUE_TITLE}}');
    expect(implement).toContain('{{BRANCH}}');
    expect(implement).toContain('__GATE_COMMANDS__');
    expect(implement).toContain('__CONTEXT_CEILING_PCT__');

    const review = readTemplate('templates/sandcastle/review-prompt.md');
    expect(review).toContain('{{TARGET_BRANCH}}');
    expect(review).toContain('__GATE_COMMANDS__');
    expect(review).toContain('__CONTEXT_CEILING_PCT__');
  });

  it('does not hardcode Forge-specific gate commands (generalized for any stamped factory)', () => {
    for (const file of ['implement-prompt.md', 'review-prompt.md']) {
      const contents = readTemplate(`templates/sandcastle/${file}`);
      expect(contents).not.toMatch(/pnpm run typecheck/);
      expect(contents).not.toMatch(/Forge's (real )?gate/);
    }
  });
});

describe('gate.yml — Rule-4 diff-path separation (ARCHITECTURE.md §3 rule 4)', () => {
  const gate = readTemplate('templates/workflows/gate.yml');

  it('runs the Rule-4 check as a script, not an agent step', () => {
    expect(gate).toContain('scripts/check-rule4.mjs');
    expect(gate).toMatch(/rule-4:/);
  });

  it('gates the rule-4 job on pull_request events', () => {
    expect(gate).toMatch(/if: github\.event_name == 'pull_request'/);
  });
});

describe('golden-regen.yml — dispatch-only behind oracle-owners (FACTORY_SPEC.md §6)', () => {
  const goldenRegen = readTemplate('templates/workflows/golden-regen.yml');

  it('is gated behind the oracle-owners environment', () => {
    expect(goldenRegen).toMatch(/environment:\s*oracle-owners/);
  });

  it('triggers only on workflow_dispatch — never pull_request or push', () => {
    const onBlock = goldenRegen.slice(
      goldenRegen.indexOf('\non:'),
      goldenRegen.indexOf('\njobs:')
    );
    expect(onBlock).toContain('workflow_dispatch');
    expect(onBlock).not.toContain('pull_request');
    expect(onBlock).not.toMatch(/\bpush:/);
  });
});

describe('runtime policy defaults — toon-meta#202 tiering + 60%-handoff (ARCHITECTURE.md §6)', () => {
  it.each(['agent-implement.yml', 'agent-review.yml'])(
    '%s documents per-role model tiering and the context ceiling',
    (file) => {
      const workflow = readTemplate(`templates/workflows/${file}`);
      expect(workflow).toContain('claude-opus-4-8');
      expect(workflow).toContain('claude-sonnet-5');
      expect(workflow).toContain('context_ceiling');
      expect(workflow).toMatch(/0\.60/);
      expect(workflow.toLowerCase()).toContain('stop-and-handoff');
    }
  );
});

describe('check-rule4.mjs — classify() (pure, unit-testable per the determinism doctrine)', () => {
  it('defaults the protected zone to verify/**', () => {
    expect(DEFAULT_PROTECTED_PATHS).toEqual(['verify/**']);
  });

  it('flags a violation when a diff touches both protected and system-under-test paths', () => {
    const { protectedFiles, sutFiles } = classify(
      ['verify/gate.test.ts', 'src/index.ts'],
      ['verify/**']
    );
    expect(protectedFiles).toEqual(['verify/gate.test.ts']);
    expect(sutFiles).toEqual(['src/index.ts']);
  });

  it('passes when only protected paths change', () => {
    const { protectedFiles, sutFiles } = classify(
      ['verify/gate.test.ts', 'verify/fixtures/golden.json'],
      ['verify/**']
    );
    expect(protectedFiles).toHaveLength(2);
    expect(sutFiles).toEqual([]);
  });

  it('passes when only system-under-test paths change', () => {
    const { protectedFiles, sutFiles } = classify(
      ['src/a.ts', 'src/b.ts'],
      ['verify/**']
    );
    expect(protectedFiles).toEqual([]);
    expect(sutFiles).toHaveLength(2);
  });

  it('supports a double-protected zone (Forge itself: verify/** and templates/**)', () => {
    const { protectedFiles, sutFiles } = classify(
      ['templates/workflows/gate.yml', 'packages/forge-core/src/index.ts'],
      ['verify/**', 'templates/**']
    );
    expect(protectedFiles).toEqual(['templates/workflows/gate.yml']);
    expect(sutFiles).toEqual(['packages/forge-core/src/index.ts']);
  });

  it('parses RULE4_PROTECTED_PATHS from a comma- or newline-separated env value', () => {
    expect(parseProtectedPaths('verify/**,templates/**')).toEqual([
      'verify/**',
      'templates/**',
    ]);
    expect(parseProtectedPaths('verify/**\ntemplates/**\n')).toEqual([
      'verify/**',
      'templates/**',
    ]);
    expect(parseProtectedPaths(undefined)).toEqual(DEFAULT_PROTECTED_PATHS);
    expect(parseProtectedPaths('')).toEqual(DEFAULT_PROTECTED_PATHS);
  });

  it('anchors glob translation so partial path matches do not leak', () => {
    const re = globToRegExp('verify/**');
    expect(re.test('verify/gate.ts')).toBe(true);
    expect(re.test('not-verify/gate.ts')).toBe(false);
    expect(re.test('verify')).toBe(false);
  });
});

describe('templates/archetypes/game — mint-after-pilot bundle (toon-protocol/Forge#31, #16)', () => {
  const manifest = parseManifest(
    readTemplate('templates/archetypes/game/factory.toml.example')
  );

  it('ships exactly the four bundle files', () => {
    const files = readdirSync(`${repoRoot}templates/archetypes/game`).sort();
    expect(files).toEqual(
      [
        'archetype.toml',
        'DOCTRINE.md',
        'factory.toml.example',
        'README.md',
      ].sort()
    );
  });

  it('archetype.toml carries no status/minted/proving_repo field (ADR-0002: registry is sole mint authority)', () => {
    const parsed = readArchetypeToml('game');
    expect(parsed.archetype.name).toBe('game');
    expect(parsed.archetype.status).toBeUndefined();
    expect(parsed.archetype.minted).toBeUndefined();
    expect(parsed.archetype.proving_repo).toBeUndefined();
    expect(parsed.archetype.environment).toBe('bevy-spacetime');
    expect(parsed.archetype.oracle_tiers).toEqual([
      't0-fmt-lint',
      't1-build',
      't2-unit-test',
      't3-sim-replay-golden',
      't4-visual-parity',
    ]);
  });

  it('every doc in the bundle says mint-after-pilot / not minted, never declares the archetype minted', () => {
    for (const file of ['README.md', 'DOCTRINE.md', 'factory.toml.example']) {
      const contents = readTemplate(`templates/archetypes/game/${file}`);
      expect(contents.toLowerCase()).toContain('mint-after-pilot');
    }
  });

  it('does not touch a FACTORY.md registry file (toon-meta-side scope stays out of this diff)', () => {
    const files = readdirSync(`${repoRoot}templates/archetypes/game`);
    expect(files).not.toContain('FACTORY.md');
  });

  it('factory.toml.example is a schema-valid manifest declaring archetype = "game" on bevy-spacetime (FACTORY_SPEC.md)', () => {
    expect(manifest.factory.archetype).toBe('game');
    expect(manifest.environment.kind).toBe('bevy-spacetime');
    expect(manifest.environment.node).toBeUndefined();
    expect(manifest.oracleTiers.map((t) => t.id)).toEqual([
      't0-fmt-lint',
      't1-build',
      't2-unit-test',
      't3-sim-replay-golden',
      't4-visual-parity',
    ]);
  });

  it('a T4 rendering tier uses tolerance, not a hash/golden check, and never runs on the inner loop (FACTORY_SPEC.md §3, §4.1)', () => {
    const t4 = manifest.oracleTiers.find((t) => t.id === 't4-visual-parity');
    expect(t4?.tolerance).toBe('ssim>=0.98');
    expect(t4?.surfaces).not.toContain('inner');
    expect(t4?.cost).toBe('expensive');
  });

  it('the protected T3 golden tier is backed by a golden-regen privileged operation (FACTORY_SPEC.md §6, §8.7)', () => {
    const t3 = manifest.oracleTiers.find(
      (t) => t.id === 't3-sim-replay-golden'
    );
    expect(t3?.protected).toBe(true);
    expect(manifest.privileged?.environment).toBe('oracle-owners');
    expect(manifest.privileged?.operations).toContain('golden-regen');
  });
});

describe('templates/archetypes/service — pinned from the relay pilot (toon-protocol/Forge#49, toon-meta#207)', () => {
  const manifest = parseManifest(
    readTemplate('templates/archetypes/service/factory.toml.example')
  );

  it('ships exactly the four bundle files', () => {
    const files = readdirSync(`${repoRoot}templates/archetypes/service`).sort();
    expect(files).toEqual(
      [
        'archetype.toml',
        'DOCTRINE.md',
        'factory.toml.example',
        'README.md',
      ].sort()
    );
  });

  it('archetype.toml carries no status/minted/proving_repo field (ADR-0002: registry is sole mint authority)', () => {
    const parsed = readArchetypeToml('service');
    expect(parsed.archetype.name).toBe('service');
    expect(parsed.archetype.status).toBeUndefined();
    expect(parsed.archetype.minted).toBeUndefined();
    expect(parsed.archetype.proving_repo).toBeUndefined();
    expect(parsed.archetype.environment).toBe('node-pnpm');
    expect(parsed.archetype.oracle_tiers).toEqual([
      't0-lint',
      't1-typecheck',
      't2-test',
      't3-build',
      't4-devbox-validate',
    ]);
  });

  it('every doc in the bundle says mint-after-pilot, never declares the archetype minted', () => {
    for (const file of ['README.md', 'DOCTRINE.md', 'factory.toml.example']) {
      const contents = readTemplate(`templates/archetypes/service/${file}`);
      expect(contents.toLowerCase()).toContain('mint-after-pilot');
    }
  });

  it('does not touch a FACTORY.md registry file (toon-meta-side scope stays out of this diff)', () => {
    const files = readdirSync(`${repoRoot}templates/archetypes/service`);
    expect(files).not.toContain('FACTORY.md');
  });

  it('factory.toml.example is a schema-valid manifest declaring archetype = "service" on node-pnpm, devbox-enabled (FACTORY_SPEC.md)', () => {
    expect(manifest.factory.archetype).toBe('service');
    expect(manifest.environment.kind).toBe('node-pnpm');
    expect(manifest.environment.node).toBe('22');
    expect(manifest.environment.devbox).toBe(true);
    expect(manifest.oracleTiers.map((t) => t.id)).toEqual([
      't0-lint',
      't1-typecheck',
      't2-test',
      't3-build',
      't4-devbox-validate',
    ]);
  });

  it('pins one environment (node-pnpm) and no protected tier — relay proves no golden/hash oracle (FACTORY_SPEC.md §2.1)', () => {
    expect(manifest.oracleTiers.every((t) => !t.protected)).toBe(true);
    expect(manifest.privileged).toBeUndefined();
  });
});

describe('archetype bundles — ADR-0002 (registry is sole mint authority)', () => {
  it.each(['game', 'service'])(
    '%s/archetype.toml carries only the opinion fields, never status/minted/proving_repo',
    (name) => {
      const parsed = readArchetypeToml(name);
      expect(Object.keys(parsed.archetype).sort()).toEqual(
        [
          'name',
          'environment',
          'doctrine',
          'manifest_example',
          'oracle_tiers',
        ].sort()
      );
    }
  );
});
