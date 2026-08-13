/**
 * `forge factory-proof` (Forge#25, decomposed from Forge#8) — the
 * CI-verified live-run proof of the full `label → plan → implement →
 * inner-gates → review → PR` cycle, mechanized as a regression test instead
 * of a paragraph a human writes once after watching an Actions run.
 *
 * Seeds a disposable throwaway issue, applies `agent:implement` to it,
 * correlates + polls the run that labeling fires, and asserts the
 * acceptance criteria against the GitHub API: the run completed
 * successfully, it opened a PR referencing the seed issue, that PR was left
 * open (no auto-merge phase merged it), and the PR's `ci.yml` gate — the
 * check of record (ARCHITECTURE.md §4, Rule 3) — is green. Cleans up after
 * itself (closes the PR and the seed issue) so a proof run leaves no debris
 * in the tracker.
 *
 * Run correlation (`isDecoyRun`/`findRunForLabel`) is a straight port of
 * toon-meta's `scripts/factory/reap-evaluator.mjs` — the issue's own pointer
 * for "the one genuinely fiddly part". Ported rather than imported:
 * reap-evaluator.mjs lives in a different repo/npm boundary. Host `gh`
 * plumbing follows review.ts's shape (execFileSync-backed default client,
 * every seam injectable) so this is unit-testable with no real shell-out.
 */
import { execFileSync } from 'node:child_process';
import {
  type FactoryManifest,
  type Role,
  ROLES,
  branchForIssue,
} from '@toon-protocol/forge-core';

export interface WorkflowRunSummary {
  readonly id: number;
  readonly status: 'queued' | 'in_progress' | 'completed' | string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly url: string;
  readonly displayTitle: string;
}

/**
 * A DECOY: `agent-implement.yml` fires on every `issues.labeled` event and
 * its `guard` job is gated on `github.event.label.name == 'agent:implement'`,
 * so any OTHER label mints a run in which nothing ran at all and the run as
 * a whole concludes `skipped`. A run-level `skipped` conclusion is therefore
 * never evidence about an `agent:implement` labeling.
 */
export const isDecoyRun = (
  run: Pick<WorkflowRunSummary, 'status' | 'conclusion'>
): boolean => run.status === 'completed' && run.conclusion === 'skipped';

export interface FindRunForLabelInput {
  readonly runs: readonly WorkflowRunSummary[];
  readonly issueNumber: number;
  readonly labeledAt: string;
  /** Time-window fallback width in minutes. Default: 10. */
  readonly windowMinutes?: number;
  /** Clock-skew allowance before `labeledAt`, in seconds. Default: 30. */
  readonly toleranceSeconds?: number;
}

/**
 * Correlates a labeling to the workflow run it fired. Two-tier match:
 *
 *  1. EXACT — a run whose `displayTitle` names this issue number (requires
 *     `run-name: "agent:implement — issue #<n>"` in agent-implement.yml,
 *     added alongside this module for exactly this purpose).
 *  2. TIME-WINDOW fallback — the run created nearest-after `labeledAt`,
 *     within `windowMinutes`. Kept as defence in depth even though this
 *     repo's workflow now carries `run-name` — see reap-evaluator.mjs's own
 *     header for why the fallback exists at all (repos without run-name).
 *
 * Never returns a decoy run: when a tier's only candidates are decoys the
 * result is `null` ("no run correlates yet"), not a run that did no work.
 */
export function findRunForLabel({
  runs,
  issueNumber,
  labeledAt,
  windowMinutes = 10,
  toleranceSeconds = 30,
}: FindRunForLabelInput): WorkflowRunSummary | null {
  const labeledMs = new Date(labeledAt).getTime();
  const windowStart = labeledMs - toleranceSeconds * 1000;

  const newest = (list: readonly WorkflowRunSummary[]) =>
    list.reduce((a, r) =>
      new Date(r.createdAt) > new Date(a.createdAt) ? r : a
    );
  const earliest = (list: readonly WorkflowRunSummary[]) =>
    list.reduce((a, r) =>
      new Date(r.createdAt) < new Date(a.createdAt) ? r : a
    );

  const pick = (
    candidates: readonly WorkflowRunSummary[],
    order: (list: readonly WorkflowRunSummary[]) => WorkflowRunSummary
  ): WorkflowRunSummary | null => {
    // FAIL CLOSED: any unfinished candidate wins outright, whatever else
    // correlates — never treat a live run as absent.
    const live = candidates.filter((r) => r.status !== 'completed');
    if (live.length > 0) return order(live);
    // DECOYS ARE NOT EVIDENCE — drop them rather than fall back to them.
    const real = candidates.filter((r) => !isDecoyRun(r));
    return real.length > 0 ? order(real) : null;
  };

  const titleRe = new RegExp(`\\bissue\\s*#${issueNumber}\\b`, 'i');
  const exact = runs.filter(
    (r) =>
      titleRe.test(r.displayTitle ?? '') &&
      new Date(r.createdAt).getTime() >= windowStart
  );
  // Authoritative once it matches ANYTHING, decoys included — falling
  // through to the coarser time-window tier here would let a different
  // ticket's run, labeled in the same minute, decide this one's fate.
  if (exact.length > 0) return pick(exact, newest);

  const windowEnd = labeledMs + windowMinutes * 60000;
  const windowed = runs.filter((r) => {
    const t = new Date(r.createdAt).getTime();
    return t >= windowStart && t <= windowEnd;
  });
  if (windowed.length > 0) return pick(windowed, earliest);

  return null;
}

export interface ProofPrInfo {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName: string;
  readonly body: string;
}

export interface ProofCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** Job/check-run names on the PR ref that count as `ci.yml`, the check of record (ARCHITECTURE.md §4). Default: `["gate"]` — ci.yml's one job. */
export const DEFAULT_CI_CHECK_NAMES: readonly string[] = ['gate'];

export interface RoleModelEvidence {
  readonly role: Role;
  readonly model: string;
  readonly seenInLog: boolean;
}

/**
 * Best-effort, advisory evidence for per-role model tiering (toon-meta#202):
 * does each manifest-resolved model string appear anywhere in the run's raw
 * log text? Substring presence is real but weak evidence — it is not proof
 * that a given phase (as opposed to some other line in the log) used that
 * model, so this feeds `notes`, never a hard pass/fail `criterion`.
 */
export function checkModelTieringEvidence(
  logText: string,
  models: Readonly<Record<Role, string>>
): readonly RoleModelEvidence[] {
  return ROLES.map((role) => ({
    role,
    model: models[role],
    seenInLog: logText.includes(models[role]),
  }));
}

export interface ProofCriterion {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface FactoryProofReport {
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly runUrl: string;
  readonly runConclusion: string | null;
  readonly pr: ProofPrInfo | null;
  readonly criteria: readonly ProofCriterion[];
  readonly passed: boolean;
  readonly notes: readonly string[];
}

export interface BuildProofReportInput {
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly run: WorkflowRunSummary;
  readonly pr: ProofPrInfo | null;
  readonly checkRuns: readonly ProofCheckRun[];
  readonly ciCheckNames?: readonly string[];
  readonly modelTieringEvidence?: readonly RoleModelEvidence[];
}

/**
 * Asserts Forge#25/#8's acceptance criteria against already-fetched GitHub
 * API data. Pure — every fact comes in as a parameter so this is testable
 * with fixtures, no live API calls.
 */
export function buildProofReport(
  input: BuildProofReportInput
): FactoryProofReport {
  const criteria: ProofCriterion[] = [];

  const runOk =
    input.run.status === 'completed' &&
    input.run.conclusion === 'success' &&
    !isDecoyRun(input.run);
  criteria.push({
    id: 'run-succeeded',
    description:
      "The seeded issue's agent:implement run drove label→plan→implement→inner-gates→review→PR to completion.",
    passed: runOk,
    detail: `${input.run.url}: status=${input.run.status} conclusion=${input.run.conclusion ?? 'null'}`,
  });

  const prReferencesIssue =
    input.pr !== null &&
    new RegExp(`#${input.issueNumber}\\b`).test(input.pr.body);
  criteria.push({
    id: 'pr-opened',
    description: 'The cycle opened a PR referencing the seeded issue.',
    passed: prReferencesIssue,
    detail: input.pr
      ? `PR #${input.pr.number} — ${input.pr.url} (head ${input.pr.headRefName})`
      : 'no PR found for the run branch',
  });

  criteria.push({
    id: 'no-auto-merge',
    description:
      'The run opened the PR and stopped — no merge phase, PR mode by construction.',
    passed: input.pr !== null && input.pr.state === 'OPEN',
    detail: input.pr ? `PR state=${input.pr.state}` : 'no PR to check',
  });

  const ciNames = (input.ciCheckNames ?? DEFAULT_CI_CHECK_NAMES).map((n) =>
    n.toLowerCase()
  );
  const ciRuns = input.checkRuns.filter((c) =>
    ciNames.includes(c.name.toLowerCase())
  );
  const ciGreen =
    ciRuns.length > 0 &&
    ciRuns.every((c) => c.status === 'completed' && c.conclusion === 'success');
  criteria.push({
    id: 'ci-green',
    description:
      "The PR's ci.yml gate (Actions on the PR ref, the check of record) passes green.",
    passed: ciGreen,
    detail:
      ciRuns.length > 0
        ? ciRuns
            .map(
              (c) =>
                `${c.name}: status=${c.status} conclusion=${c.conclusion ?? 'null'}`
            )
            .join('; ')
        : `no matching check run found (looked for: ${(input.ciCheckNames ?? DEFAULT_CI_CHECK_NAMES).join(', ')})`,
  });

  const notes: string[] = [];
  for (const e of input.modelTieringEvidence ?? []) {
    notes.push(
      `advisory: per-role model "${e.model}" (${e.role}) ${e.seenInLog ? 'appears' : 'was NOT found'} in the run log — substring evidence only, not proof of attribution to that phase.`
    );
  }
  notes.push(
    "inner gates ran advisory-only by construction: forge-core's runCycle carries no merge phase and the ci-green criterion above is the authoritative backstop (Rule 3) — this is a structural guarantee of the code that ran, not independently re-derived from this run's API data."
  );

  return {
    issueNumber: input.issueNumber,
    issueUrl: input.issueUrl,
    runUrl: input.run.url,
    runConclusion: input.run.conclusion,
    pr: input.pr,
    criteria,
    passed: criteria.every((c) => c.passed),
    notes,
  };
}

/** Formats a proof report as one verdict line per criterion, plus advisory notes and a summary line. Mirrors `formatDoctorReport`. */
export function formatProofReport(report: FactoryProofReport): string {
  const lines = report.criteria.map((c) => {
    const verdict = (c.passed ? 'green' : 'RED').padEnd(5);
    return `  ${verdict} ${c.id}  — ${c.detail}`;
  });
  const noteLines = report.notes.map((n) => `  note   ${n}`);
  const summary = report.passed
    ? `forge factory-proof: green — issue #${report.issueNumber} drove a CI-verified full label→PR cycle (${report.runUrl}).`
    : `forge factory-proof: RED — issue #${report.issueNumber}'s run (${report.runUrl}) did not satisfy every criterion.`;
  return [...lines, ...noteLines, summary].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// GitHub plumbing — an injectable client so `runFactoryProof` is testable
// with no shell-out, plus a real `gh`-CLI-backed default.
// ─────────────────────────────────────────────────────────────────────────

export interface FactoryProofGhClient {
  readonly createIssue: (args: {
    readonly title: string;
    readonly body: string;
  }) => Promise<{ readonly number: number; readonly url: string }>;
  readonly addLabel: (args: {
    readonly number: number;
    readonly label: string;
  }) => Promise<void>;
  readonly closeIssue: (args: {
    readonly number: number;
    readonly comment?: string;
  }) => Promise<void>;
  readonly listWorkflowRuns: (args: {
    readonly workflow: string;
  }) => Promise<readonly WorkflowRunSummary[]>;
  readonly getRun: (args: {
    readonly id: number;
  }) => Promise<WorkflowRunSummary>;
  readonly findPrForBranch: (args: {
    readonly branch: string;
  }) => Promise<ProofPrInfo | null>;
  readonly listCheckRuns: (args: {
    readonly ref: string;
  }) => Promise<readonly ProofCheckRun[]>;
  readonly getRunLogText: (args: { readonly id: number }) => Promise<string>;
  readonly closePr: (args: {
    readonly number: number;
    readonly deleteBranch: boolean;
    readonly comment?: string;
  }) => Promise<void>;
}

interface HostRunRow {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly url: string;
  readonly displayTitle: string;
}

function toRunSummary(row: HostRunRow): WorkflowRunSummary {
  return {
    id: row.databaseId,
    status: row.status,
    conclusion: row.conclusion,
    createdAt: row.createdAt,
    url: row.url,
    displayTitle: row.displayTitle,
  };
}

const RUN_JSON_FIELDS =
  'databaseId,status,conclusion,createdAt,url,displayTitle';

export const defaultFactoryProofGhClient: FactoryProofGhClient = {
  async createIssue({ title, body }) {
    const url = execFileSync(
      'gh',
      ['issue', 'create', '--title', title, '--body', body],
      { encoding: 'utf-8' }
    ).trim();
    const match = /\/issues\/(\d+)\s*$/.exec(url);
    if (!match) {
      throw new Error(
        `forge factory-proof: could not parse an issue number from 'gh issue create' output: ${url}`
      );
    }
    return { number: Number(match[1]), url };
  },
  async addLabel({ number, label }) {
    execFileSync(
      'gh',
      ['issue', 'edit', String(number), '--add-label', label],
      {
        stdio: 'inherit',
      }
    );
  },
  async closeIssue({ number, comment }) {
    if (comment) {
      execFileSync(
        'gh',
        ['issue', 'comment', String(number), '--body', comment],
        {
          stdio: 'inherit',
        }
      );
    }
    execFileSync('gh', ['issue', 'close', String(number)], {
      stdio: 'inherit',
    });
  },
  async listWorkflowRuns({ workflow }) {
    const json = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        workflow,
        '--limit',
        '30',
        '--json',
        RUN_JSON_FIELDS,
      ],
      { encoding: 'utf-8' }
    );
    return (JSON.parse(json) as HostRunRow[]).map(toRunSummary);
  },
  async getRun({ id }) {
    const json = execFileSync(
      'gh',
      ['run', 'view', String(id), '--json', RUN_JSON_FIELDS],
      { encoding: 'utf-8' }
    );
    return toRunSummary(JSON.parse(json) as HostRunRow);
  },
  async findPrForBranch({ branch }) {
    const json = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,url,state,headRefName,body',
      ],
      { encoding: 'utf-8' }
    );
    const [pr] = JSON.parse(json) as {
      number: number;
      url: string;
      state: string;
      headRefName: string;
      body: string | null;
    }[];
    return pr
      ? {
          number: pr.number,
          url: pr.url,
          state: pr.state as ProofPrInfo['state'],
          headRefName: pr.headRefName,
          body: pr.body ?? '',
        }
      : null;
  },
  async listCheckRuns({ ref }) {
    const nwo = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { encoding: 'utf-8' }
    ).trim();
    const json = execFileSync(
      'gh',
      ['api', `repos/${nwo}/commits/${ref}/check-runs`, '--jq', '.check_runs'],
      { encoding: 'utf-8' }
    );
    return (
      JSON.parse(json) as {
        name: string;
        status: string;
        conclusion: string | null;
      }[]
    ).map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
    }));
  },
  async getRunLogText({ id }) {
    return execFileSync('gh', ['run', 'view', String(id), '--log'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 64,
    });
  },
  async closePr({ number, deleteBranch, comment }) {
    if (comment) {
      execFileSync('gh', ['pr', 'comment', String(number), '--body', comment], {
        stdio: 'inherit',
      });
    }
    const args = ['pr', 'close', String(number)];
    if (deleteBranch) args.push('--delete-branch');
    execFileSync('gh', args, { stdio: 'inherit' });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_PROOF_LABEL = 'agent:implement';
export const DEFAULT_PROOF_WORKFLOW_FILE = 'agent-implement.yml';

/** Hidden marker on every seed issue's body — a human (or another automation) can recognize a proof-run issue at a glance as never a real feature request. */
export const PROOF_ISSUE_MARKER = '<!-- factory-proof:disposable -->';

export function proofIssueTitle(stampIso: string): string {
  return `[factory-proof] disposable throwaway — CI-verified live-run proof (${stampIso})`;
}

export function proofIssueBody(stampIso: string): string {
  return [
    PROOF_ISSUE_MARKER,
    '',
    'Seeded by `forge factory-proof` (Forge#25) to drive one real `agent:implement`',
    'cycle end to end and assert the result against the GitHub API. Disposable —',
    'this issue and the PR it produces are closed automatically once the proof',
    'completes, pass or fail.',
    '',
    `Seeded at ${stampIso}.`,
  ].join('\n');
}

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface FactoryProofOptions {
  readonly manifest: FactoryManifest;
  readonly gh?: FactoryProofGhClient;
  readonly sleep?: Sleep;
  readonly now?: () => Date;
  readonly label?: string;
  readonly workflowFile?: string;
  /** Poll budget while waiting for the run to be correlated. Default: 10 attempts, 30s apart (5 minutes). */
  readonly correlatePoll?: {
    readonly attempts?: number;
    readonly intervalMs?: number;
  };
  /**
   * Poll budget while waiting for the correlated run to finish. Default: 60
   * attempts, 60s apart (1 hour) — a soft budget inside agent-implement.yml's
   * own 180-minute job cap, not a hard one; raise it for a slower manifest.
   */
  readonly completionPoll?: {
    readonly attempts?: number;
    readonly intervalMs?: number;
  };
  /** Best-effort model-tiering log scan (checkModelTieringEvidence). Default: true. */
  readonly scanModelTieringEvidence?: boolean;
  /** Close the throwaway issue + PR once the proof completes. Default: true — "leaves debris in the tracker" per the issue. */
  readonly cleanup?: boolean;
}

/**
 * Seeds a disposable issue, labels it `agent:implement`, waits for the real
 * cycle to run, asserts the acceptance criteria, and cleans up. Throws if no
 * run ever correlates or the run never completes within its poll budget —
 * those are infrastructure failures, distinct from a completed run that
 * fails a criterion (which is reported, not thrown).
 */
export async function runFactoryProof(
  options: FactoryProofOptions
): Promise<FactoryProofReport> {
  const gh = options.gh ?? defaultFactoryProofGhClient;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const label = options.label ?? DEFAULT_PROOF_LABEL;
  const workflowFile = options.workflowFile ?? DEFAULT_PROOF_WORKFLOW_FILE;

  const stampIso = now().toISOString();
  const issue = await gh.createIssue({
    title: proofIssueTitle(stampIso),
    body: proofIssueBody(stampIso),
  });

  await gh.addLabel({ number: issue.number, label });
  const labeledAt = now().toISOString();

  const correlateAttempts = options.correlatePoll?.attempts ?? 10;
  const correlateIntervalMs = options.correlatePoll?.intervalMs ?? 30_000;
  let run: WorkflowRunSummary | null = null;
  for (let attempt = 0; attempt < correlateAttempts; attempt++) {
    const runs = await gh.listWorkflowRuns({ workflow: workflowFile });
    run = findRunForLabel({ runs, issueNumber: issue.number, labeledAt });
    if (run) break;
    await sleep(correlateIntervalMs);
  }
  if (!run) {
    throw new Error(
      `forge factory-proof: no run correlated to issue #${issue.number}'s '${label}' labeling within the poll budget (${correlateAttempts} attempts).`
    );
  }

  const completionAttempts = options.completionPoll?.attempts ?? 60;
  const completionIntervalMs = options.completionPoll?.intervalMs ?? 60_000;
  for (
    let attempt = 0;
    attempt < completionAttempts && run.status !== 'completed';
    attempt++
  ) {
    await sleep(completionIntervalMs);
    run = await gh.getRun({ id: run.id });
  }
  if (run.status !== 'completed') {
    throw new Error(
      `forge factory-proof: run ${run.url} did not complete within the poll budget (${completionAttempts} attempts).`
    );
  }

  const branch = branchForIssue(String(issue.number));
  const pr = await gh.findPrForBranch({ branch });
  const checkRuns = pr ? await gh.listCheckRuns({ ref: pr.headRefName }) : [];

  let modelTieringEvidence: readonly RoleModelEvidence[] | undefined;
  if (options.scanModelTieringEvidence ?? true) {
    try {
      const logText = await gh.getRunLogText({ id: run.id });
      modelTieringEvidence = checkModelTieringEvidence(
        logText,
        options.manifest.loop.models
      );
    } catch {
      // Best-effort — a log-fetch failure must not fail the whole proof.
    }
  }

  const report = buildProofReport({
    issueNumber: issue.number,
    issueUrl: issue.url,
    run,
    pr,
    checkRuns,
    modelTieringEvidence,
  });

  if (options.cleanup ?? true) {
    if (pr) {
      await gh.closePr({
        number: pr.number,
        deleteBranch: true,
        comment: `Closing — this PR was opened by a \`forge factory-proof\` run (Forge#25) and is disposable. Proof passed: ${report.passed}.`,
      });
    }
    await gh.closeIssue({
      number: issue.number,
      comment: `\`forge factory-proof\` completed — passed: ${report.passed}. Full report: ${JSON.stringify(report)}`,
    });
  }

  return report;
}
