# `templates/archetypes/service/` — the `service` archetype bundle

> **MINT-AFTER-PILOT.** This bundle is *prepared*, not *minted*. It exists only once its pilot
> proves it end to end (relay, toon-protocol/relay — merged `agent:implement` PRs #70/#77/#81) —
> see ARCHITECTURE.md §8. Per `toon-meta/docs/adr/0002-registry-is-sole-mint-authority.md`,
> `toon-meta/FACTORY.md` is the sole authority on whether `service` is minted; `archetype.toml`
> describes the opinion only and carries no `status`/`minted`/`proving_repo` field. This diff does
> not register `service` in `toon-meta/FACTORY.md` and does not declare it minted anywhere; that
> registry edit is toon-meta#207's toon-meta-side scope.

Payment-fronted node service on the pinned `node-pnpm` stack (toon-protocol/toon-meta#207),
pinned from its pilot: **relay** (toon-protocol/relay).

## Contents

| File | Purpose |
|---|---|
| `archetype.toml` | Provenance record: name, environment, doctrine, and manifest-example pointers. Whether the archetype is minted is decided solely by `toon-meta/FACTORY.md`, never by this file. |
| `DOCTRINE.md` | Service-specific specialization of the Forge determinism doctrine (`ARCHITECTURE.md` §3): what relay's real tree proves vs. what #207 aspired to, devbox-as-load-bearing, deterministic-and-post-merge image publish. |
| `factory.toml.example` | A worked `factory.toml` for a repo minting `archetype = "service"`: `[environment] kind = "node-pnpm"`, `devbox = true`, and a T0-T4 oracle tier ladder (lint/typecheck/test/build, plus a devbox toolchain smoke-build tier) traced to relay's real `.github/workflows/ci.yml`. |

The **environment** itself (the `node-pnpm` Dockerfile shape) is not duplicated here — it ships
once, at `templates/dockerfiles/node-pnpm/Dockerfile`, and this bundle's `factory.toml.example`
references it by `[environment] kind`.

## What was pinned from relay's real tree, and what wasn't

Read directly off `toon-protocol/relay` (`gh api repos/toon-protocol/relay/...`), not off
toon-meta#207's description of `service`:

- **Pinned, and present in relay:**
  - `.github/workflows/ci.yml` — lint/build/typecheck/test (the `[[oracle.tier]]` ladder here).
  - `.github/workflows/release.yml` — changesets → npm publish + Release PR.
  - `.github/workflows/publish-relay-image.yml` / `publish-relay-connector-image.yml` — GHCR
    image publish, post-merge, not a PR gate.
  - A `deploy/` bundle directory (Dockerfile + compose + connector config + env example).
  - `devbox.json` + `devbox.lock`, asserted live by a `devbox-validate` CI job — hence
    `[environment].devbox = true` and `t4-devbox-validate`.
  - `[environment] kind = "node-pnpm"` — relay is a pnpm workspace, not `npm-workspaces`.
- **Named by #207 but NOT present in relay — not invented here:**
  - `e2e.yml` — absent.
  - `journey.yml` — absent.
  - `deploy-*.yml` — absent; relay's `deploy/` is a drop-in compose bundle, not a CI-driven
    deploy workflow.

See `DOCTRINE.md` for the full pinned-vs-aspirational table and rationale.

## Why not `connector`

`connector` (toon-protocol/connector) is `npm-workspaces`, not `node-pnpm` — per FACTORY_SPEC.md
§2.1 "alternate opinions are new archetypes, not flags", it stays `--blank` rather than widening
this archetype to accommodate a second environment kind.

## Using this bundle

Nothing here is stampable by `forge new` yet for its release/deploy/image-publish workflows —
`stamp.ts` currently stamps only the base five workflows every factory gets
(`templates/workflows/`) plus this bundle's `factory.toml.example` (oracle ladder) and
`DOCTRINE.md`. Until archetype-specific workflow stamping exists, a `service` pilot copies
`factory.toml.example` as a starting point and adds `release.yml` / `publish-*-image.yml` /
`deploy/` by hand, following relay as the reference. The first repo to run this to a green gate +
merged `agent:implement` PR is what mints `service` — at that point `toon-meta/FACTORY.md` is
updated (toon-meta#207) to record the proving repo (relay).

## Consistency with FACTORY_SPEC.md

`archetype.toml`'s shape (name, environment, doctrine, oracle tier ids) mirrors the archetype
provenance fields FACTORY_SPEC.md §2.1 expects a minted catalog entry to carry, and
`factory.toml.example` is a real, schema-valid manifest (validated structurally by
`packages/forge-core/src/manifest.ts`) — promoting `service` from mint-after-pilot to minted is a
registry change (`toon-meta/FACTORY.md`), not a reshape of either file.
