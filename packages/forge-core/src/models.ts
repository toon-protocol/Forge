/**
 * Per-role model tiering (toon-meta#202) — configures sandcastle's four
 * loop roles from a manifest's `[loop.models]` table (FACTORY_SPEC.md §5.1).
 */
import {
  claudeCode,
  type AgentProvider,
  type ClaudeCodeOptions,
} from '@ai-hero/sandcastle';
import type { FactoryManifest, Role } from './manifest.js';

/** One `claudeCode(model)` agent provider per loop role, resolved from the manifest. */
export type RoleAgents = Readonly<Record<Role, AgentProvider>>;

/** Resolves a single role's agent provider from the manifest's `[loop.models]` table. */
export function resolveRoleAgent(
  manifest: FactoryManifest,
  role: Role,
  options?: ClaudeCodeOptions
): AgentProvider {
  return claudeCode(manifest.loop.models[role], options);
}

/** Resolves all four loop roles (planner, merger, implementer, reviewer) from the manifest. */
export function resolveRoleAgents(manifest: FactoryManifest): RoleAgents {
  return {
    planner: resolveRoleAgent(manifest, 'planner'),
    merger: resolveRoleAgent(manifest, 'merger'),
    implementer: resolveRoleAgent(manifest, 'implementer'),
    reviewer: resolveRoleAgent(manifest, 'reviewer'),
  };
}
