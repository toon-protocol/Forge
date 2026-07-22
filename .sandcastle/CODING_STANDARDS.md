# Coding Standards — Forge

Loaded by the reviewer agent during code review (`@.sandcastle/CODING_STANDARDS.md`), so these
are enforced at review time without costing implementation tokens. Forge builds oracle machinery
for the whole org, so the determinism doctrine (`ARCHITECTURE.md` §3) is the standard behind the
standard.

## Style

- TypeScript, ESM (`"type": "module"`), Node ≥ 22. `strict` + `noUncheckedIndexedAccess`.
- Named exports over default exports. `camelCase` values, `PascalCase` types.
- `import type { ... }` for type-only imports (enforced by `consistent-type-imports`).
- No `any` (`@typescript-eslint/no-explicit-any` is an error). Model unknowns as `unknown` and
  narrow.
- Prefix intentionally-unused bindings with `_`.
- Formatting is Prettier (`prettier.config.js`) — do not hand-format; run `pnpm format`.

## Determinism (the load-bearing rule)

- **If an exit code can decide it, it is a script, not an agent.** Lint, typecheck, test, build,
  hashes, thresholds, label transitions, image builds are scripts. Inference is reserved for
  generation, repair, advisory judgment, and decomposition.
- **Never touch a gate/oracle and the code it judges in the same change.** Forge has a *double*
  protected zone: its own `verify/` **and** the shipped `templates/**` gate runners. A PR that
  edits a template gate-runner and the `forge-core` that emits it is invalid by construction.
- **CI is the check of record.** In-loop `sandbox.exec()` gates are advisory; the Actions run on
  the PR ref is the verdict.

## Testing

- Every public function/module gets at least one test. Tests live in `packages/*/src/**/*.test.ts`
  and import from `vitest` explicitly.
- Test names state the expected behavior, not the implementation.
- Golden/fixture regeneration is **never** hand-edited in a feature PR — it runs only through
  `golden-regen.yml` behind the `oracle-owners` environment.

## Architecture

- Keep modules single-responsibility; prefer composition over inheritance.
- **Forge holds zero org state.** No registry, no pins-of-record, nothing authoritative lives in
  this repo — read `toon-meta` at runtime. A change that caches org truth locally is a bug.
- The manifest (`factory.toml`) is the only per-factory variability surface; anything a script can
  decide does not become a manifest field.
