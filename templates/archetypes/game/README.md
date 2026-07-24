# `templates/archetypes/game/` — the `game` archetype bundle

> **MINT-AFTER-PILOT.** This bundle is *prepared*, not *minted*. It exists only once its first
> game repo proves it end to end (>=1 merged `agent:implement` PR) — see `archetype.toml`
> (`minted = false`, `status = "mint-after-pilot"`) and ARCHITECTURE.md §8. This diff does not
> register `game` in `toon-meta/FACTORY.md` and does not declare it minted anywhere; that registry
> edit is toon-protocol/Forge#16's toon-meta-side scope.

Bevy client + SpacetimeDB server on the pinned game stack (toon-protocol/toon-meta#198).

## Contents

| File | Purpose |
|---|---|
| `archetype.toml` | Provenance record: name, mint-after-pilot status, proving repo (empty until piloted), pointers to the environment/doctrine/manifest example below. |
| `DOCTRINE.md` | Game-specific specialization of the Forge determinism doctrine (`ARCHITECTURE.md` §3): reducer/replay determinism, GPU-tolerance-not-hash for rendering, ECS architecture guidance. |
| `factory.toml.example` | A worked `factory.toml` for a repo minting `archetype = "game"`: `[environment] kind = "bevy-spacetime"` and a T0-T4 oracle tier skeleton (fmt/lint, build, unit test, reducer-replay golden, visual-parity tolerance). |

The **environment** itself (the `bevy-spacetime` Dockerfile shape) is not duplicated here — it
ships once, at `templates/dockerfiles/bevy-spacetime/Dockerfile`, and this bundle's
`factory.toml.example` references it by `[environment] kind`.

## Using this bundle

Nothing here is stampable by `forge new` yet (`forge new`/`forge validate` land in #218/#219).
Until then, this is reference material: a pilot repo copies `factory.toml.example` as a starting
point, fills in real `sim-replay`/`visual-parity` binaries and reducers, and follows `DOCTRINE.md`.
The first repo to run this to a green gate + merged `agent:implement` PR is what mints `game` —
at that point `toon-meta/FACTORY.md` is updated (Forge#16) to record the proving repo and this
bundle's `archetype.toml` status flips from `mint-after-pilot` to minted.

## Consistency with FACTORY_SPEC.md

`archetype.toml`'s shape (name, environment, doctrine, oracle tier ids) mirrors the archetype
provenance fields FACTORY_SPEC.md §2.1 expects a minted catalog entry to carry, and
`factory.toml.example` is a real, schema-valid manifest (validated structurally by
`packages/forge-core/src/manifest.ts`) — promoting `game` from mint-after-pilot to minted is a
status change, not a reshape of either file.
