import { describe, expect, it } from 'vitest';
import { resolveRoleAgent, resolveRoleAgents } from './models.js';
import { parseManifest } from './manifest.js';

// #202 values: planner Opus 4.8, implementer + reviewer Sonnet-5.
const MANIFEST_SOURCE = `
[factory]
name = "example"
repo = "toon-protocol/example"
archetype = "blank"

[environment]
kind = "node-pnpm"
node = "22"
lockfile = "pnpm-lock.yaml"

[loop]
template = "parallel-planner-with-review"
inner_gates = []
[loop.models]
planner = "claude-opus-4-8"
merger = "claude-opus-4-8"
implementer = "claude-sonnet-5"
reviewer = "claude-sonnet-5"

[[oracle.tier]]
id = "t0-lint"
run = "pnpm lint"
on = []
surfaces = ["pr"]
cost = "cheap"
`;

function modelOf(provider: ReturnType<typeof resolveRoleAgent>): string {
  const { command } = provider.buildPrintCommand({
    prompt: 'hi',
    dangerouslySkipPermissions: true,
  });
  const match = /--model '([^']+)'/.exec(command);
  if (!match) throw new Error(`no --model flag in: ${command}`);
  return match[1]!;
}

describe('resolveRoleAgents', () => {
  it('applies the manifest per-role models to sandcastle claudeCode() providers (#202)', () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    const agents = resolveRoleAgents(manifest);

    expect(modelOf(agents.planner)).toBe('claude-opus-4-8');
    expect(modelOf(agents.merger)).toBe('claude-opus-4-8');
    expect(modelOf(agents.implementer)).toBe('claude-sonnet-5');
    expect(modelOf(agents.reviewer)).toBe('claude-sonnet-5');
  });

  it('resolveRoleAgent resolves a single role independently', () => {
    const manifest = parseManifest(MANIFEST_SOURCE);
    expect(modelOf(resolveRoleAgent(manifest, 'implementer'))).toBe(
      'claude-sonnet-5'
    );
  });

  it('follows a manifest that diverges from the #202 defaults (manifest is authoritative, §5.1)', () => {
    const manifest = parseManifest(
      MANIFEST_SOURCE.replace(
        'implementer = "claude-sonnet-5"',
        'implementer = "claude-haiku-4-5-20251001"'
      )
    );
    expect(modelOf(resolveRoleAgent(manifest, 'implementer'))).toBe(
      'claude-haiku-4-5-20251001'
    );
  });
});
