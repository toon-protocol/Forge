# Forge

**The factory manager for the [toon-protocol](https://github.com/toon-protocol) software-factory substrate.**

[#178](https://github.com/toon-protocol/toon-meta/issues/178) stands up a per-repo software
factory (its own `.sandcastle/`, workflows, Dockerfile, and gate) **by hand** in every execution
repo. Forge turns that hand-rolled pattern into stamped, validated, upgradeable substrate, so the
cost of every factory after the pilot collapses to **its oracle plus a manifest**.

Tracked by epic [toon-meta#198](https://github.com/toon-protocol/toon-meta/issues/198).

## The factory equation

A factory = **Environment × Doctrine × Oracle**, executed by a commodity **Loop**
(`@ai-hero/sandcastle`) over a commodity **Control Plane** (GitHub: issues / labels / PRs /
Actions / branch protection / environments). Factories genuinely differ only in those three
variables — and the Oracle is where the engineering lives. Forge owns the commodities and the
manifest contract; a factory contributes only its three variables via a `factory.toml`.

## Forge holds zero org state

> `toon-meta` is the **source of truth for the org.** Forge is a **stateless client** of it.

The factory registry (`FACTORY.md`), the pinned `@ai-hero/sandcastle` version of record, shared
conventions, and archetype definitions all live in
[toon-meta](https://github.com/toon-protocol/toon-meta) — **never here**. Forge reads that
authority at runtime; it never holds it:

- `forge new` stamps a repo **and** opens a registration PR against `toon-meta/FACTORY.md`.
- `forge validate` treats the registry as authoritative — an unregistered factory does not
  exist; a pin disagreeing with `FACTORY.md` fails validation.

Authority (toon-meta) and capability (Forge) stay separated so neither alone can corrupt the org.

## Layout

```
Forge/
  ARCHITECTURE.md            # design record — the factory equation, determinism doctrine, bootstrap
  FACTORY_SPEC.md            # normative factory.toml contract              (#213)
  packages/
    forge-core/              # manifest loader + loop orchestration (wraps @ai-hero/sandcastle)
    forge-cli/               # forge new | validate | doctor | upgrade | status
  templates/
    workflows/               # agent-implement / agent-review / gate / nightly / golden-regen (#217)
    dockerfiles/             # node-pnpm / npm-workspaces / docs / bevy-spacetime               (#217)
    archetypes/              # opinionated bundles, minted after a pilot                        (#224)
    scripts/                 # gate runners, diff-path separation check, changeset glue         (#217)
```

## Status

Bootstrap in progress — this is the **scaffold** ([toon-meta#212](https://github.com/toon-protocol/toon-meta/issues/212)):
directory shape, buildable stubs, and this design record. No factory behaviour yet. Forge itself
is a factory *consumer* — it runs its own `.sandcastle/` like every other repo — and bootstraps
**hand-rolled first, then self-stamps** (the self-hosting-compiler order). See `ARCHITECTURE.md`.

## Develop

```sh
pnpm install
pnpm build        # tsc project references across the workspace
pnpm typecheck
```

## License

MIT
