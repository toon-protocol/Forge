import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classify,
  DEFAULT_PROTECTED_PATHS,
  globToRegExp,
  parseProtectedPaths,
} from '../../../templates/scripts/check-rule4.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readTemplate(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8');
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
