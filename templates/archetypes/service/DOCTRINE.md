# Service doctrine — `service` archetype (mint-after-pilot)

> Status: **mint-after-pilot** (ARCHITECTURE.md §8) — decided solely by `toon-meta/FACTORY.md`,
> never by this bundle. This doctrine is prepared, not proven — it becomes binding for stamped
> repos once the first `service` pilot merges. It specializes the Forge-level determinism
> doctrine (`ARCHITECTURE.md` §3) for a payment-fronted node service on the pinned `node-pnpm`
> stack; it does not replace it.

## Stack

- **Runtime:** Node 22, pnpm workspaces (`[environment] kind = "node-pnpm"`,
  `templates/dockerfiles/node-pnpm/`).
- **Devbox is load-bearing, not optional** (`[environment].devbox = true`): relay pins its
  toolchain (`nodejs` 22, `pnpm_8` 8.15.9) in `devbox.json`/`devbox.lock`, and CI asserts those
  versions resolve and smoke-build inside devbox (`t4-devbox-validate` below) before trusting the
  bare-runner build.
- **Deploy shape:** a `deploy/` bundle (Dockerfile + compose + connector config + env example)
  fronts the service behind a TOON connector (payment proxy) — see relay's `deploy/README.md` for
  the pilot's concrete topology. This bundle does not copy that topology verbatim (it is relay's
  business logic, not an org-wide opinion); it pins that a `service` factory ships **a** `deploy/`
  bundle and publishes the images that bundle runs.

## What relay actually proves (pin what's real, not #207's aspiration)

toon-meta#207 describes `service` as carrying "deploy bundle + e2e / journey / deploy-* /
image-publish workflows". Read against relay's real tree
(`gh api repos/toon-protocol/relay/contents/...`), that is **partly aspirational**:

| Claimed by #207            | Present in relay?                                                          |
| --------------------------- | --------------------------------------------------------------------------- |
| `e2e.yml`                    | **No.**                                                                     |
| `journey.yml`                | **No.**                                                                     |
| `deploy-*.yml`               | **No** — relay has no deploy-triggering workflow; `deploy/` is a drop-in compose bundle, not a CI-driven deploy. |
| image-publish workflow(s)    | **Yes** — `publish-relay-image.yml` (app image) and `publish-relay-connector-image.yml` (connector image, pinned `CONNECTOR_TAG`), both to GHCR, both on push-to-main + `v*` tags. |
| deploy bundle                | **Yes** — `deploy/` (Dockerfile, docker-compose.yml, connector.yaml, .env.example, README.md).   |
| release workflow             | Not named by #207, but present and load-bearing: `release.yml` (changesets → npm publish + Release PR via an org GitHub App token). |

If a future `service` repo genuinely needs `e2e`/`journey` gates, that is either a doctrine
revision to this bundle (registry-first, per ARCHITECTURE.md §8's "opinions are pinned in
toon-meta ... revising one is registry-first") or a distinct archetype — not something this
bundle invents ahead of a pilot proving it.

## Determinism, specialized for a service archetype

The Forge-level rule ("if an exit code can decide it, it is a script, never an agent") applies in
full, same as the bare `node-pnpm` ladder. Two service-specific corollaries:

1. **Image publish is deterministic and post-merge, never a PR gate.** `publish-relay-image.yml`
   and `publish-relay-connector-image.yml` run on push to `main`/`v*` tags — they are exit-code
   deterministic (the build either succeeds or it doesn't) but are not part of the
   `[[oracle.tier]]` ladder because they publish artifacts, they don't judge a diff.
2. **The connector-image pin is a version bump, not a free-floating tag.** `CONNECTOR_TAG` is
   pinned deliberately (relay: `3.28.0`) so the config schema and HTTP-envelope contract stay
   frozen against a known connector; bumping it is a pin-bump change (FACTORY_SPEC.md
   `[privileged]` territory once a repo protects that decision), not a silent latest-tracks-latest
   float.

## Testing (T0-T4, see `factory.toml.example`)

| Tier | What                                                        | Surface    | Cost     |
| ---- | ------------------------------------------------------------ | ---------- | -------- |
| T0   | `pnpm lint`                                                   | inner + pr | cheap    |
| T1   | `pnpm typecheck`                                              | inner + pr | cheap    |
| T2   | `pnpm -r test --if-present`                                   | pr         | moderate |
| T3   | `pnpm -r build`                                               | pr         | moderate |
| T4   | Devbox-pinned toolchain smoke build (`devbox run -- ...`)     | pr         | moderate |

This ladder is the bare `node-pnpm` toolchain ladder (T0-T3, identical to `forge new --blank`'s
default for this kind) plus the one thing relay's CI actually adds beyond it: `t4-devbox-validate`.
Release (`release.yml`) and image-publish (`publish-*-image.yml`) are real and pinned as part of
this archetype's doctrine (see the table above), but are not `[[oracle.tier]]` entries — they are
post-merge publish workflows, not PR-gating checks, and today's stamping engine (`stamp.ts`) does
not yet stamp archetype-specific workflow files beyond the base five every factory gets
(`templates/workflows/`). Until that capability exists, a `service` pilot adds `release.yml` and
the two `publish-*-image.yml` workflows by hand, following relay's as the reference.

## What this bundle is not

- Not a minted archetype — minting is decided solely by `toon-meta/FACTORY.md`
  (`toon-meta/docs/adr/0002-registry-is-sole-mint-authority.md`), never by this bundle. No repo's
  `factory.toml` can declare `archetype = "service"` and pass `forge validate` until a pilot
  merges and the registry records it.
- Not a `toon-meta/FACTORY.md` edit — the org registry entry for `service` is out of scope for
  this bundle (toon-meta#207's toon-meta-side scope).
- Not `spa` — `spa`'s pilot (rig-web) is unresolved; that bundle is explicitly out of scope here.
- Not `connector` — `connector` is `npm-workspaces`, not `node-pnpm`. Per FACTORY_SPEC.md §2.1
  "alternate opinions are new archetypes, not flags", it stays `--blank` rather than widening this
  archetype to a second environment kind.
