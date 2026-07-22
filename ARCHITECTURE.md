# Forge — Architecture

> Design record, drafted with the scaffold ([toon-meta#212](https://github.com/toon-protocol/toon-meta/issues/212)).
> Normative details of the manifest contract live in `FACTORY_SPEC.md` ([#213](https://github.com/toon-protocol/toon-meta/issues/213)).
> Epic: [toon-meta#198](https://github.com/toon-protocol/toon-meta/issues/198).
> Design decisions of record: `toon-meta/context/decisions.md` → *Software factory (Forge)*.

## 1. What Forge is

Forge is the **factory manager**. It turns the hand-rolled per-repo software factory proved by
[#178](https://github.com/toon-protocol/toon-meta/issues/178) into stamped, validated,
upgradeable substrate. After the pilot, the cost of a new factory collapses to **its oracle plus
a manifest**.

**The factory equation:**

```
factory = Environment × Doctrine × Oracle
          └───────────── executed by ─────────────┘
          Loop (@ai-hero/sandcastle)  over  Control Plane (GitHub)
```

The Loop and the Control Plane are **commodities** — identical across every factory. Factories
differ only in the three variables, and the Oracle is where the real engineering lives. Forge
owns the commodities and the manifest contract; a factory contributes only `factory.toml`.

## 2. What Forge is *not*: zero org state

`toon-meta` is the org's source of truth. Forge is a **stateless client** of it — it holds no
registry, no pins-of-record, nothing authoritative. The registry (`FACTORY.md`), the pinned
`@ai-hero/sandcastle` version, shared conventions, and archetype definitions all live in
toon-meta.

- `forge new` stamps a repo **and** opens a registration PR to `toon-meta/FACTORY.md`.
- `forge validate` treats the registry as authoritative: unregistered → does not exist; pin
  mismatch vs `FACTORY.md` → validation failure.

Authority (toon-meta) and capability (Forge) are separated by construction, so neither alone can
corrupt the org. This is an invariant, audited at the end of the epic
([#225](https://github.com/toon-protocol/toon-meta/issues/225)).

## 3. Determinism doctrine (Forge-level law, inherited by every factory)

1. **Exit codes beat inference.** If a step's correctness can be decided by a script's exit code,
   it is a script, never an agent: lint, typecheck, test, build, publish, versioning,
   hash/threshold checks, label transitions, image builds.
2. **Inference is reserved for four jobs:** generation (diffs), repair (reading a red gate and
   producing the fixing diff — the script decides failure, the agent interprets it), advisory
   judgment (never merge authority), and decomposition (the smart zone, human-in-loop).
3. **CI is the check of record.** In-sandbox `sandbox.exec()` gates are fast advisory feedback
   inside the loop; the Actions run on the PR ref is the only verdict, enforced by branch
   protection. The agent can see the oracle but cannot *be* the oracle.
4. **Oracle code is a protected zone.** No PR touches gate scripts / `verify/` and the
   system-under-test in the same diff (deterministic diff-path check in the gate + CODEOWNERS).
   Golden/baseline regeneration is `workflow_dispatch` behind a GitHub environment with required
   reviewers.
5. **Publishing is a pipeline, not a task.** Agent involvement in release ends at a changeset
   file; version / tag / publish run as scripts on merge.

## 4. Two-loop verification topology

1. **Inner loop** — forge-core injects the manifest's cheap tiers as `sandbox.exec()` between
   implement iterations and before review; red output becomes the repair prompt. *Advisory.*
2. **Outer loop** — `gate.yml` on the PR: the full tier ladder, cost-ordered, path-filtered
   (expensive tiers fire only when their paths change). *Authoritative.*
3. **Scheduled** — nightly for tiers too expensive per-PR; regressions open triaged issues with
   reproducer artifacts (the oracle generates work orders; the same loop consumes them).
4. **Dispatch (privileged)** — golden regen, pin bumps, threshold changes: environment-gated,
   human-approved. The migration labor is agent work; the approval is not.

## 5. Components

| Component | Responsibility | Lands in |
|-----------|----------------|----------|
| `FACTORY_SPEC.md` | Normative `factory.toml` contract: `[factory]` (incl. `archetype` provenance), `[environment]`, `[[oracle.tier]]`, `[loop]` (incl. `inner_gates` + **per-role models**), `[privileged]`. | [#213](https://github.com/toon-protocol/toon-meta/issues/213) |
| `packages/forge-core` | Wraps `@ai-hero/sandcastle`: manifest loader, inner-gate injection, and full label→plan→implement→inner-gates→review→PR orchestration, configuring roles from the manifest. | [#215](https://github.com/toon-protocol/toon-meta/issues/215), [#216](https://github.com/toon-protocol/toon-meta/issues/216) |
| `packages/forge-cli` | `forge new` (stamp + registration PR), `validate` (manifest lint + registry parity), `doctor` (run the PR-tier ladder against HEAD — the green-baseline law as a command), `upgrade` (regenerate stamped files as a gated PR). | [#218](https://github.com/toon-protocol/toon-meta/issues/218)–[#221](https://github.com/toon-protocol/toon-meta/issues/221) |
| `templates/**` | The stampable substrate: workflows, Dockerfiles, archetype bundles, gate scripts. **Also oracle code for downstream repos** — hence Forge's double protected zone (§7). | [#217](https://github.com/toon-protocol/toon-meta/issues/217), [#224](https://github.com/toon-protocol/toon-meta/issues/224) |

## 6. Runtime policy inheritance (#202)

`@ai-hero/sandcastle` defaults all four roles (planner / implementer / reviewer / merger) to
Opus. The org runtime policy
([#202](https://github.com/toon-protocol/toon-meta/issues/202)) sets **planner = `claude-opus-4-8`**,
**implementer + reviewer = `claude-sonnet-5`**, plus a ~60%-context stop-and-handoff ceiling.

Two consequences:

- **`FACTORY_SPEC.md` must express per-role model fields** — forge-core configures the roles from
  the manifest, so `factory.toml` needs a per-role model field (in `[loop]` or a `[models]`
  block).
- **`templates/**` ship #202's tiering + the 60%-handoff prompt language as baked-in defaults**,
  so the policy propagates by `forge upgrade` (one template change + N gated PRs) instead of an
  8-repo hand sweep. #202 is the poster-child `forge upgrade` case.

## 7. Forge is itself a factory (self-hosting bootstrap)

Forge is a TS monorepo, and by org doctrine every execution repo runs the two-zone pipeline — so
Forge runs its own `.sandcastle/` like every other repo. The tool that stamps factories cannot
stamp itself into existence, so Forge is **hand-rolled first, then self-stamps**:

- **Early — `forge:bootstrap` (stage-0, [#214](https://github.com/toon-protocol/toon-meta/issues/214)):**
  a hand-rolled `.sandcastle/` running **raw** `@ai-hero/sandcastle` (no `factory.toml` yet),
  applied from the relay-extracted recipe with impl + review = Sonnet-5 per #202. `forge-core` is
  then developed **under this gate** — the only bootstrap order that never runs ungated codegen to
  produce the gate that gates it.
- **Late — `forge:self-host` (checkpoint, [#223](https://github.com/toon-protocol/toon-meta/issues/223)):**
  `forge new` on Forge **swaps the engine** from raw sandcastle to a `forge-core`-driven
  `factory.toml`, reaching **green (behavioral, not byte) parity** — gate green **and** ≥1 real
  `agent:implement` PR merges under the forge-core factory. Steady-state Forge runs forge-core.

**Two distinct self-hosting proofs, kept separate:** self-host (above) is incestuous — the same
authors wrote Forge's hand-rolled factory and the templates — so it cannot catch generalization
bugs. The **external re-stamp** ([#222](https://github.com/toon-protocol/toon-meta/issues/222))
re-stamps an existing #178 repo (relay) to green parity with *its* hand-rolled setup: the
load-bearing surprise.

**Forge's double oracle-protected zone.** Unlike other repos (one protected zone: their own
`verify/`), the `templates/**` gate runners Forge ships **are oracle code for downstream repos**.
So two zones are Rule-4 protected: (i) Forge's own `verify/` + gate scripts, and (ii) the shipped
`templates/**` gate runners — no PR touches a template gate-runner and the `forge-core` that emits
it in one diff. Forge's signature gate tier (T2) diffs `forge new` output against committed
**golden fixtures**; those regenerate **only** via `golden-regen.yml` behind the `oracle-owners`
environment, so the golden test can't self-certify. Self-host parity (T4) is a nightly/dispatch
tier, not a per-PR gate — a full self-stamp is too expensive to gate every PR.

## 8. Archetypes — Forge is opinionated

The front door is `forge new <archetype>`, named for **what you build** (`game`), over parts named
for **what they contain** (`bevy-spacetime`).

- **Opinions are pinned in toon-meta**, next to the sandcastle pin; revising one is registry-first,
  then fans out via `forge upgrade`.
- **An archetype exists only after its pilot** (≥1 merged `agent:implement` PR end-to-end). The
  first game repo *mints* `game`; it is not built from it.
- **Opinionated, not closed** — `forge new --blank` is the escape hatch; `forge validate` reports
  manifest-vs-archetype drift so divergence is visible, never silent.
- **Alternate opinions are new archetypes, not flags** (a Rapier-both-sides game becomes
  `game-dynamics`, never `--rapier`).
- **Forge itself mints no archetype** — it self-stamps with `forge new --blank` + the `node-pnpm`
  environment. Forge builds tooling, not a domain, and there is exactly one of it. The non-game
  catalog (`service`, `spa`; libraries + Forge stay `--blank`) is defined in
  [#207](https://github.com/toon-protocol/toon-meta/issues/207) and catalogued in `FACTORY.md`
  via [#224](https://github.com/toon-protocol/toon-meta/issues/224).

## 9. Build order (this epic)

`#212 scaffold` → `#213 FACTORY_SPEC` · `#214 bootstrap` → `#215/#216 forge-core` ·
`#217 templates` → `#218 forge new` → `#219 validate` · `#220 doctor` · `#221 upgrade` →
`#222 external re-stamp` → `#223 self-host` · `#224 archetype catalog` → `#225 no-state audit`.

Hard external edges: the #178 relay pilot must be green before bootstrap/templates; #202's policy
must land in the relay-proven pattern before forge-core extracts templates from it.
