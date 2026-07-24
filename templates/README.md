# `templates/` — the stampable substrate

Content shipped here is inert text: it is not built, linted, or type-checked by Forge's own
gate (`eslint.config.js` / `vitest.config.ts` both exclude `templates/**`). It is validated
structurally by `packages/forge-core/src/templates.test.ts` instead, and — once `forge new`
exists (toon-protocol/Forge#10/#218) — by diffing its output against golden fixtures
(`pnpm verify:golden`, `protected = true` in `factory.toml`).

## Stamped destinations

| Source | Destination in a stamped repo |
|---|---|
| `templates/workflows/*.yml` | `.github/workflows/*.yml` |
| `templates/dockerfiles/<kind>/Dockerfile` | `.sandcastle/Dockerfile`, where `<kind>` matches `factory.toml`'s `[environment] kind` |
| `templates/scripts/*.mjs` | `scripts/*.mjs` (repo root) |

## `templates/workflows/`

- `agent-implement.yml` / `agent-review.yml` — the label→runner pair (toon-protocol/toon-meta#178
  vocabulary: `agent:implement` / `agent:review`). Environment-kind-agnostic: the orchestration
  harness (`@ai-hero/sandcastle` via `.sandcastle/*.ts`, run through `pnpm sandcastle:*`) is
  uniformly Node/pnpm on the Actions runner regardless of what `[environment] kind` the sandbox
  Dockerfile uses.
- `gate.yml` — the outer, authoritative gate (ARCHITECTURE.md §4). Embeds the Rule-4 diff-path
  separation check (`rule-4` job, calling `scripts/check-rule4.mjs`) ahead of the tier ladder.
- `nightly.yml` — the scheduled surface for `expensive` oracle tiers; files a triaged issue with
  reproducer artifacts on regression.
- `golden-regen.yml` — `workflow_dispatch`-only, gated behind the `oracle-owners` GitHub
  environment (required reviewers). The only path golden/baseline fixtures may change through.

All workflow templates carry toon-protocol/toon-meta#202's per-role model tiering
(planner/merger = `claude-opus-4-8`, implementer/reviewer = `claude-sonnet-5`) and the
`context_ceiling = 0.60` stop-and-handoff rule as documented defaults — see the header comment in
`agent-implement.yml` / `agent-review.yml`. `forge-core` reads the concrete values from
`factory.toml`'s `[loop.models]` / `context_ceiling` (FACTORY_SPEC.md §5); until it ships, a
hand-rolled `.sandcastle/*.ts` sets them directly, as this repo's own does.

## `templates/dockerfiles/`

Four shapes, one per `[environment] kind`: `node-pnpm` and `npm-workspaces` are **proven**
(extracted from the toon-protocol/toon-meta#178 relay pattern / this repo's own bootstrap);
`docs` generalizes the same recipe to a non-Node prose oracle; `bevy-spacetime` is **prepared**
for the game archetype pilot but unproven until that pilot's first `agent:implement` PR merges
(ARCHITECTURE.md §8).

## `templates/scripts/`

`check-rule4.mjs` — the Rule-4 diff-path separation check (ARCHITECTURE.md §3 rule 4): a script,
not an agent judgment, per the determinism doctrine. Exports a pure `classify()` so its logic is
unit-testable without shelling out to `git`.
