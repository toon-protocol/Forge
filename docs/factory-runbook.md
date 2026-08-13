# Factory runbook

Operational notes for Forge's own `.sandcastle`/`forge-core` factory loop —
the `agent:implement` / `agent:review` label→runner workflows, and the
CI-verified live-run proof that closes Forge#8's acceptance (Forge#25).

## The auto-merge toggle (first-run safety)

`.github/workflows/agent-implement.yml` and `.sandcastle/agent-implement-issue.ts`
both default to **PR mode**: the agent implements, reviews, pushes a branch,
and opens a PR — nothing is merged and the issue is not closed. A human
reviews and merges.

To re-enable auto-merge once a pilot is trusted, set
`SANDCASTLE_AUTO_MERGE: "true"` in the implement step's `env:`
(`.sandcastle/agent-implement-issue.ts` reads it). The merge path's
push-to-main semantics are inherited from the underlying engine and are
themselves verify-on-first-run — confirm on a throwaway issue before trusting
it, same as any other first live run documented here.

Merely committing either workflow file triggers nothing: `issues`/
`pull_request` `labeled` events only fire from the default branch, and only
when someone actually applies the label. The first live run of any of these
paths is a deliberate human (or `forge factory-proof`, see below) action.

## `agent-implement.yml`'s guard: known residual gap

The guard job refuses PRD-shaped parents (issues with sub-issues) via a
GraphQL `subIssues` query. If that field is unavailable on the repo's current
GitHub plan, the query errors, guard **logs a warning and does NOT block** —
it falls back to the `epic`/`tracking` label check alone. This is a stated
residual gap, not a bug: verify whether sub-issues are queryable on this
org's plan before relying on the guard to catch an undecomposed parent by
structure alone; the label check is the backstop either way.

## `forge factory-proof` — the CI-verified live-run proof (Forge#25)

Closes Forge#8's acceptance: "a full label→plan→implement→inner-gates→
review→PR run in Actions, CI-verified." Originally scoped as a human watching
one Actions run and writing up what they saw; rescoped 2026-08-12 because
every step of that is mechanizable — dispatching a workflow, watching run/job/
check-run state via the Actions API, and writing findings to a file are all
ordinary automation, not judgment calls. `forge factory-proof`
(`packages/forge-cli/src/factory-proof.ts`) is that automation: a committed,
reviewed workflow instead of a one-off observation, so it is a **regression
test for the factory itself** — rerunnable whenever confidence in the pipeline
needs re-establishing, not a paragraph written once.

### What it does

1. Seeds a disposable throwaway issue (title prefixed `[factory-proof]`, body
   carries the hidden `<!-- factory-proof:disposable -->` marker) — never a
   real feature request.
2. Applies `agent:implement`, which fires `agent-implement.yml` exactly as it
   would for a real issue.
3. Correlates the run that labeling fired. Two-tier match ported from
   toon-meta's `scripts/factory/reap-evaluator.mjs` `findRunForLabel` (that
   repo's own solution to "the one genuinely fiddly part" of this problem):
   EXACT on `run-name` (agent-implement.yml now carries
   `agent:implement — issue #<n>`, added alongside this feature), falling
   back to a time window for defence in depth. A run that concluded `skipped`
   is always a DECOY (some other label fired it) and is never treated as
   evidence about this labeling.
4. Polls until the run completes, then asserts:
   - `run-succeeded` — the run completed with conclusion `success` (and
     wasn't a decoy).
   - `pr-opened` — the cycle opened a PR whose body references the seed
     issue.
   - `no-auto-merge` — that PR is still `OPEN` (the run has no merge phase by
     construction — PR mode).
   - `ci-green` — the PR's `ci.yml` gate (Actions on the PR ref, the check of
     record — ARCHITECTURE.md §4, Rule 3) is green.
   Each is a hard pass/fail criterion; the report also carries advisory notes
   (per-role model-tiering evidence — a best-effort substring scan of the
   run's raw log for `factory.toml`'s `[loop.models]` strings; real but weak
   evidence, never gates the overall verdict).
5. Writes the report to `.sandcastle/logs/factory-proof-report.json`
   (`FACTORY_PROOF_REPORT_PATH` overrides the path) — "a file the run writes,
   not a note somebody takes."
6. Cleans up: closes the opened PR (deleting its branch) and the seed issue,
   pass or fail, so a proof run leaves no debris in the tracker.
7. Exits non-zero if any hard criterion failed.

### Running it

`.github/workflows/factory-live-proof.yml` — `workflow_dispatch` only, never
scheduled (dispatching it spends one real `agent:implement` cycle, the same
cost as any other labeling). Run it from the Actions tab, or:

```
gh workflow run factory-proof
```

### First-run gotcha (flagged, not yet proven live)

`agent-implement.yml`'s Guard 1 requires the labeling actor to hold
`write`/`maintain`/`admin` permission via
`repos/{repo}/collaborators/{actor}/permission`. `factory-live-proof.yml`
labels as the same GitHub App `agent-implement.yml` already uses to open PRs
(`APP_ID`/`APP_PRIVATE_KEY`), on the theory that an App with push access
resolves the same way through that endpoint — this has not been confirmed
against a live dispatch yet. If Guard 1 refuses the App's bot identity on the
first real run, the fix is a maintainer PAT secret for this workflow, not a
change to the guard (Guard 1 exists specifically to refuse drive-by labeling
by identities without write access).

Record the outcome of the first live dispatch — run link, whether Guard 1
passed, the resulting `factory-proof-report.json` — as Forge#8's closing
proof.
