# FACTORY_SPEC.md — the `factory.toml` contract

> **Normative.** This document defines `factory.toml`, the manifest a repository contributes so
> Forge can drive its factory. A manifest either **conforms** to this spec or **fails**
> `forge validate`. Words in the RFC 2119 sense — **MUST**, **MUST NOT**, **SHOULD**, **MAY** —
> carry their usual weight.
>
> Epic [toon-meta#198](https://github.com/toon-protocol/toon-meta/issues/198) · ticket
> [toon-meta#213](https://github.com/toon-protocol/toon-meta/issues/213). Design record:
> `toon-meta/context/decisions.md` → *Software factory (Forge)*. Architecture: `ARCHITECTURE.md`.

## 0. Why a manifest exists

A factory = **Environment × Doctrine × Oracle**, executed by a commodity **Loop**
(`@ai-hero/sandcastle`) over a commodity **Control Plane** (GitHub). The Loop and the Control
Plane are identical everywhere; a factory differs only in those three variables. `factory.toml` is
where a repo declares its three variables — nothing more. Anything a script's exit code can decide
is a script, never a manifest field (Determinism Doctrine, Rule 1).

`forge-core` reads `factory.toml` to configure the loop; `forge validate` checks it against this
spec **and** against the org registry (`toon-meta/FACTORY.md`), which is authoritative. Forge holds
no state: the manifest points *at* toon-meta's pins, it does not restate them as its own truth.

## 1. Document shape

`factory.toml` lives at the repo root. TOML v1.0.0. Top-level tables:

| Table | Cardinality | Purpose |
|-------|-------------|---------|
| `[factory]` | exactly 1 | Identity + archetype provenance + registry linkage. |
| `[environment]` | exactly 1 | The toolchain the sandbox/runner is built from. |
| `[loop]` | exactly 1 | Orchestration template, per-role models, inner gates. |
| `[[oracle.tier]]` | 1 or more | The tier ladder: each gate, its trigger surfaces, and its runner. |
| `[privileged]` | 0 or 1 | Dispatch-gated operations (golden regen, pin bumps, thresholds). |

Unknown tables or keys **MUST** fail validation (no silent forward-compat — drift must be visible).

## 2. `[factory]`

```toml
[factory]
name        = "relay"                 # MUST equal the repo's FACTORY.md row key
repo        = "toon-protocol/relay"   # owner/repo; MUST match the repo it lives in
archetype   = "service"               # see §2.1
description = "Payment-fronted Nostr relay."
```

| Key | Type | Req | Rule |
|-----|------|-----|------|
| `name` | string | **MUST** | Registry key. `forge validate` fails if no `FACTORY.md` row matches (**unregistered → does not exist**). |
| `repo` | string | **MUST** | `owner/repo`. **MUST** match the hosting repo. |
| `archetype` | string | **MUST** | An archetype name, or the literal `"blank"`. See §2.1. |
| `description` | string | SHOULD | One line; surfaced by `forge status`. |

### 2.1 Archetype provenance

- `archetype` names **what you build** (`game`, `service`, `spa`), not what parts contain.
- An archetype value other than `"blank"` **MUST** correspond to a minted archetype in
  `FACTORY.md`'s archetype catalog. An archetype exists only after its pilot (≥1 merged
  `agent:implement` PR); referencing an unminted archetype **MUST** fail validation.
- `"blank"` is the escape hatch (`forge new --blank`): no archetype opinions apply. Libraries and
  one-offs (including Forge itself) use `"blank"` + a bare environment.
- Alternate opinions are **new archetypes, not flags**. There is no `[factory.options]` for
  swapping a pinned choice; a divergent opinion is a different `archetype`.
- `forge validate` reports **archetype drift**: where this manifest diverges from its declared
  archetype's pinned definition. Drift is a warning surface, never silently allowed.

## 3. `[environment]`

Declares the toolchain the sandbox image and CI runner are built from — the one place a
Devbox/Nix lockfile feeds dev shell, sandbox image, and runner install alike.

```toml
[environment]
kind       = "node-pnpm"          # node-pnpm | npm-workspaces | docs | bevy-spacetime | bevy-spacetime-gpu
node       = "22"                 # major; omit for non-node kinds
lockfile   = "pnpm-lock.yaml"     # the toolchain lock of record
devbox     = true                 # true => a devbox.json/flake backs the image + runner
```

| Key | Type | Req | Rule |
|-----|------|-----|------|
| `kind` | enum | **MUST** | One of the prepared environment shapes. Adding a `kind` is a Forge template change, not a manifest freedom. |
| `node` | string | cond. | **MUST** be present for node kinds; **MUST NOT** for others. |
| `lockfile` | string | **MUST** | Path to the toolchain lock committed in the repo. |
| `devbox` | bool | MAY | Defaults `false`. `true` asserts a Devbox/Nix lock backs the environment. |

**Determinism stops at the GPU driver by design.** `bevy-spacetime-gpu` environments pair with
tolerance-metric oracle tiers (§4), never hash equality, because the driver is not reproducible.

## 4. `[[oracle.tier]]`

The tier ladder — the Oracle, where the real engineering lives. One `[[oracle.tier]]` per gate,
**cost-ordered cheapest-first**. Each tier is a **script** whose exit code is the verdict (Rule 1);
the loop may *read* a tier but may never *be* one (Rule 3).

```toml
[[oracle.tier]]
id      = "t0-lint"
run     = "pnpm lint"           # exit 0 = pass; anything else = fail
on       = ["**/*.ts"]           # path globs that arm this tier
surfaces = ["inner", "pr"]       # where it fires: inner | pr | nightly | dispatch
cost     = "cheap"               # cheap | moderate | expensive

[[oracle.tier]]
id      = "t2-golden-stamp"
run     = "pnpm verify:golden"
on       = ["templates/**", "packages/forge-core/**"]
surfaces = ["pr"]
cost     = "moderate"
protected = true                 # part of the oracle-protected zone (Rule 4); see §7
```

| Key | Type | Req | Rule |
|-----|------|-----|------|
| `id` | string | **MUST** | Unique, kebab-case; stable (referenced by logs + nightly work orders). |
| `run` | string | **MUST** | A command. Its **exit code is the check**. No inference. |
| `on` | array<glob> | **MUST** | Path globs that arm the tier. Empty array = always armed. |
| `surfaces` | array<enum> | **MUST** | Non-empty subset of `inner \| pr \| nightly \| dispatch`. See §4.1. |
| `cost` | enum | **MUST** | `cheap \| moderate \| expensive`. Orders the PR ladder + routes nightly. |
| `protected` | bool | MAY | Defaults `false`. `true` marks the tier's runner as oracle-protected (§7). |
| `tolerance` | string | cond. | For non-deterministic tiers (GPU visual): a metric+threshold, e.g. `"ssim>=0.98"`. **MUST NOT** coexist with a hash/golden check on the same tier. |

### 4.1 Surfaces (the two-loop topology)

- **`inner`** — injected as `sandbox.exec()` between implement iterations and before review.
  Advisory; red output becomes the repair prompt. **MUST** be `cheap`.
- **`pr`** — runs in `gate.yml` on the PR ref. **Authoritative** — the check of record, enforced
  by branch protection (Rule 3). Path-filtered by `on`.
- **`nightly`** — scheduled; for tiers too `expensive` per-PR. Regressions open triaged issues
  with reproducer artifacts.
- **`dispatch`** — `workflow_dispatch` only, behind a `[privileged]` environment (§6).

A tier listing `inner` **MUST** also list `pr` (advisory feedback must have an authoritative
backstop). A tier whose `cost` is `expensive` **MUST NOT** list `inner`.

## 5. `[loop]`

Configures the commodity Loop. This is where org runtime policy
([toon-meta#202](https://github.com/toon-protocol/toon-meta/issues/202)) is expressed.

```toml
[loop]
template    = "parallel-planner-with-review"   # the org default orchestration template
inner_gates = ["t0-lint", "t1-typecheck"]      # tier ids injected into the inner loop
context_ceiling = 0.60                          # #202: stop-and-handoff before this fraction

[loop.models]                                   # per-role model tiering (#202) — REQUIRED
planner     = "claude-opus-4-8"
merger      = "claude-opus-4-8"
implementer = "claude-sonnet-5"
reviewer    = "claude-sonnet-5"
```

| Key | Type | Req | Rule |
|-----|------|-----|------|
| `template` | string | **MUST** | A sandcastle orchestration template. Org default: `parallel-planner-with-review`. |
| `inner_gates` | array<string> | **MUST** | Tier ids (each **MUST** exist in `[[oracle.tier]]` and list surface `inner`). May be empty. |
| `context_ceiling` | float | SHOULD | `0 < x <= 1`. Defaults `0.60` per #202. The stop-and-handoff fraction. |
| `[loop.models]` | table | **MUST** | Per-role model ids. **This block is required** — `@ai-hero/sandcastle` defaults all roles to Opus, so forge-core needs explicit values to apply #202. |

### 5.1 `[loop.models]` — required per-role tiering (#202)

Keys `planner`, `merger`, `implementer`, `reviewer` **MUST** all be present. Each value is a model
id string. The org policy of record (mirrored, not owned, here) is:

| Role | Model | Why |
|------|-------|-----|
| `planner` | `claude-opus-4-8` | Dependency-graph reasoning over the backlog; once per cycle. |
| `merger` | `claude-opus-4-8` | Conflict resolution across branches; once per cycle. |
| `implementer` | `claude-sonnet-5` | Mechanical, high-iteration — the bulk of factory spend. |
| `reviewer` | `claude-sonnet-5` | Single-pass review against a fixed standards file. |

Forge's `templates/**` ship these values as baked-in defaults, so a policy change is one template
edit fanned out by `forge upgrade`, not an N-repo hand sweep. `forge validate` **MAY** warn when a
manifest's models diverge from the current org policy, but the manifest value is authoritative for
that repo (divergence is visible, not forbidden).

## 6. `[privileged]`

Declares dispatch-gated operations — the privileged loop (Rule 4/5). Optional; omit for repos with
no golden fixtures or pinned thresholds.

```toml
[privileged]
environment = "oracle-owners"     # GitHub environment gating these dispatches
operations  = ["golden-regen", "pin-bump", "threshold-change"]
```

| Key | Type | Req | Rule |
|-----|------|-----|------|
| `environment` | string | **MUST** (if table present) | A GitHub environment with required reviewers. Golden/baseline regen **MUST** run only through it. |
| `operations` | array<enum> | **MUST** (if table present) | Subset of `golden-regen \| pin-bump \| threshold-change`. |

A repo declaring any `protected = true` tier (§4) **MUST** declare `[privileged]` with a
`golden-regen` operation — otherwise its protected fixtures could only be regenerated by an
ordinary PR, defeating the protection.

## 7. The oracle-protected zone (Rule 4) and manifests

Manifest fields interact with Rule 4 but do not enforce it — enforcement is the diff-path check in
`gate.yml` + CODEOWNERS. The manifest's role:

- `protected = true` tiers name the runners that are oracle code. No PR may touch a protected
  tier's runner **and** the system-under-test it judges in one diff.
- Forge is the special double-zone case: both its own `verify/` **and** the `templates/**` gate
  runners it ships are oracle code. Its `factory.toml` marks the template-emitting tiers
  `protected = true`, and its `[privileged]` environment is `oracle-owners`.

## 8. Validation summary (what `forge validate` enforces)

A manifest **fails** if any of the following hold:

1. An unknown table or key is present (§1).
2. `factory.name` has no matching `FACTORY.md` row — **unregistered → does not exist**.
3. A pin in the manifest disagrees with `FACTORY.md` (registry parity — **pin mismatch → fail**).
4. `archetype` is neither `"blank"` nor a minted archetype in the catalog (§2.1).
5. `[loop.models]` is missing any of the four roles (§5.1).
6. A tier lists `inner` but not `pr`, or lists `inner` while `cost = "expensive"` (§4.1).
7. A `protected` tier exists but `[privileged]` lacks `golden-regen` (§6).
8. `environment.node` is present for a non-node `kind`, or absent for a node `kind` (§3).
9. A tier sets both `tolerance` and a golden/hash check (§4).

Archetype **drift** (§2.1) and model **divergence** from org policy (§5.1) are **reported**, not
failed — visible, never silent.

## 9. Worked example — Forge's own manifest (self-host, #223)

Illustrative; the real file lands when `forge new` self-stamps Forge.

```toml
[factory]
name      = "forge"
repo      = "toon-protocol/Forge"
archetype = "blank"                 # Forge mints no archetype; node-pnpm + blank
description = "The factory manager."

[environment]
kind     = "node-pnpm"
node     = "22"
lockfile = "pnpm-lock.yaml"

[loop]
template        = "parallel-planner-with-review"
inner_gates     = ["t0-lint", "t1-typecheck"]
context_ceiling = 0.60
[loop.models]
planner = "claude-opus-4-8"
merger  = "claude-opus-4-8"
implementer = "claude-sonnet-5"
reviewer    = "claude-sonnet-5"

[[oracle.tier]]
id = "t0-lint"
run = "pnpm lint"
on = ["**/*.ts"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t1-typecheck"
run = "pnpm typecheck"
on = ["**/*.ts", "tsconfig*.json"]
surfaces = ["inner", "pr"]
cost = "cheap"

[[oracle.tier]]
id = "t2-golden-stamp"
run = "pnpm verify:golden"
on = ["templates/**", "packages/forge-core/**"]
surfaces = ["pr"]
cost = "moderate"
protected = true                    # double protected zone

[[oracle.tier]]
id = "t4-self-parity"
run = "pnpm verify:self-host"
on = []
surfaces = ["nightly", "dispatch"]  # too expensive to gate every PR
cost = "expensive"

[privileged]
environment = "oracle-owners"
operations  = ["golden-regen"]
```
