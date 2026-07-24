# Game doctrine — `game` archetype (mint-after-pilot)

> Status: **mint-after-pilot** (`archetype.toml`). This doctrine is prepared, not proven — it
> becomes binding for stamped repos once the first `game` pilot merges (ARCHITECTURE.md §8).
> It specializes the Forge-level determinism doctrine (`ARCHITECTURE.md` §3) for a Bevy client +
> SpacetimeDB server on the pinned stack; it does not replace it.

## Stack

- **Client:** Bevy (ECS), Rust edition per the org Rust pin (`toon-meta` — this doctrine points
  at the pin, it does not restate it as its own truth, per Forge's zero-org-state rule).
- **Server:** SpacetimeDB modules — reducers are the only place server state mutates.
- **Environment:** `[environment] kind = "bevy-spacetime"` (`templates/dockerfiles/bevy-spacetime/`).
  A GPU-backed variant (`bevy-spacetime-gpu`) exists in the manifest schema for repos that need
  rendered-frame checks; see the tolerance rule below before picking it.

## Determinism, specialized for a game archetype

The Forge-level rule ("if an exit code can decide it, it is a script, never an agent") applies
in full. Two game-specific corollaries:

1. **Reducers are the oracle's favorite target.** SpacetimeDB reducers are pure state transitions
   over deterministic inputs — replay a recorded input trace and diff the resulting state hash
   against a committed golden trace (`t3-sim-replay-golden` in `factory.toml.example`). This is a
   hash-equality check, same as any other golden fixture, and follows the same rule: it is
   oracle-protected and regenerates only through `golden-regen.yml` (`oracle-owners`).
2. **Rendering is not.** The GPU driver is not bit-reproducible (FACTORY_SPEC.md §3). Any tier
   that judges rendered frames **MUST** use a `tolerance` metric (e.g. `ssim>=0.98`), never a hash
   or golden-fixture comparison, and **MUST NOT** run on every PR — it belongs on `nightly` or
   `dispatch` (`t4-visual-parity`). A tier setting both `tolerance` and a golden/hash check on the
   same check is invalid (FACTORY_SPEC.md §8 rule 9).

## Architecture

- Keep gameplay logic in plain Rust functions/systems that don't require a running `App` to unit
  test; reserve integration tests (T2) for behavior that only exists once systems are wired
  together.
- Reducers stay free of client-only concerns (rendering, input polling); client systems stay free
  of server-authoritative state mutation. The client renders and predicts; the server decides.
- Prefer small, composable Bevy plugins over one monolithic plugin — mirrors the Forge-level
  preference for composition over inheritance (`.sandcastle/CODING_STANDARDS.md`).

## Testing (T0-T4, see `factory.toml.example`)

| Tier | What | Surface | Cost |
|------|------|---------|------|
| T0 | `cargo fmt --check` + `cargo clippy -D warnings` | inner + pr | cheap |
| T1 | `cargo check --workspace` | inner + pr | cheap |
| T2 | `cargo test --workspace` (unit + integration) | pr | moderate |
| T3 | Reducer/replay parity vs. a committed golden trace | pr | moderate, **protected** |
| T4 | Rendered-frame visual parity, tolerance metric | nightly + dispatch | expensive |

This ladder is a **skeleton**: the pilot repo fills in real reducers, a real `sim-replay` binary,
and a real `visual-parity` harness. Nothing here is proven until that pilot's `agent:implement` PR
merges — treat the `run` commands in `factory.toml.example` as the org's current intent, not a
battle-tested recipe (same caveat `templates/dockerfiles/bevy-spacetime/Dockerfile` carries).

## What this bundle is not

- Not a minted archetype — `archetype.toml` in this directory carries `minted = false`. No repo's
  `factory.toml` can declare `archetype = "game"` and pass `forge validate` until a pilot merges.
- Not a `toon-meta/FACTORY.md` edit — the org registry entry for `game` is out of scope for this
  bundle (toon-protocol/Forge#16's toon-meta-side half).
