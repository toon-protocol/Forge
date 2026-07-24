import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDoctorReport, forgeDoctor } from './doctor.js';

const tempDirs: string[] = [];

async function tempTargetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-doctor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

const WIDGET_TOML = `
[factory]
name      = "widget"
repo      = "toon-protocol/widget"
archetype = "blank"

[environment]
kind     = "node-pnpm"
node     = "22"
lockfile = "pnpm-lock.yaml"

[loop]
template        = "parallel-planner-with-review"
inner_gates     = ["t0-lint"]
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
id = "t3-build"
run = "pnpm build"
on = ["**/*.ts"]
surfaces = ["pr"]
cost = "expensive"

[[oracle.tier]]
id = "t1-typecheck"
run = "pnpm typecheck"
on = []
surfaces = ["pr"]
cost = "moderate"
`;

async function writeManifest(targetDir: string): Promise<string> {
  const path = join(targetDir, 'factory.toml');
  await writeFile(path, WIDGET_TOML, 'utf-8');
  return path;
}

function execResult(exitCode: number, stdout = '', stderr = '') {
  return Promise.resolve({ exitCode, stdout, stderr });
}

describe('forgeDoctor', () => {
  it('runs the pr-surfaced ladder cost-ordered, path-filtered against the listed files', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const exec = vi.fn().mockReturnValue(execResult(0, 'ok'));

    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['src/foo.ts'],
      exec,
    });

    expect(exec).toHaveBeenNthCalledWith(1, 'pnpm lint');
    expect(exec).toHaveBeenNthCalledWith(2, 'pnpm typecheck');
    expect(exec).toHaveBeenNthCalledWith(3, 'pnpm build');
    expect(report.manifest.factory.name).toBe('widget');
    expect(report.passed).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual([
      'passed',
      'passed',
      'passed',
    ]);
  });

  it('reports red when any armed tier exits non-zero, without short-circuiting the rest', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const exec = vi.fn().mockImplementation((command: string) => {
      if (command === 'pnpm lint')
        return execResult(1, '', 'src/foo.ts:1: unexpected token');
      return execResult(0, 'ok');
    });

    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['src/foo.ts'],
      exec,
    });

    expect(exec).toHaveBeenCalledTimes(3);
    expect(report.passed).toBe(false);
    const lint = report.results.find((r) => r.tierId === 't0-lint');
    expect(lint?.status).toBe('failed');
    const build = report.results.find((r) => r.tierId === 't3-build');
    expect(build?.status).toBe('passed');
  });

  it('skips a tier unarmed by the listed files, and it does not affect the verdict', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const exec = vi.fn().mockReturnValue(execResult(0, 'ok'));

    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['README.md'],
      exec,
    });

    expect(exec).toHaveBeenCalledTimes(1); // only t1-typecheck (on = [], always armed)
    expect(report.passed).toBe(true);
    expect(report.results.find((r) => r.tierId === 't0-lint')?.status).toBe(
      'skipped'
    );
    expect(report.results.find((r) => r.tierId === 't3-build')?.status).toBe(
      'skipped'
    );
  });
});

describe('formatDoctorReport', () => {
  it('renders a green summary and one line per tier when every armed tier passes', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['src/foo.ts'],
      exec: () => execResult(0, 'ok'),
    });

    const formatted = formatDoctorReport(report);

    expect(formatted).toContain('forge doctor: green');
    expect(formatted).toContain('t0-lint');
    expect(formatted).toContain('t1-typecheck');
    expect(formatted).toContain('t3-build');
  });

  it('renders a RED summary and includes the failing tier output', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['src/foo.ts'],
      exec: (command) =>
        command === 'pnpm lint'
          ? execResult(1, '', 'src/foo.ts:1: unexpected token')
          : execResult(0, 'ok'),
    });

    const formatted = formatDoctorReport(report);

    expect(formatted).toContain('forge doctor: RED');
    expect(formatted).toContain('src/foo.ts:1: unexpected token');
  });

  it('marks a skipped tier distinctly from a passed/failed one', async () => {
    const targetDir = await tempTargetDir();
    const manifestPath = await writeManifest(targetDir);
    const report = await forgeDoctor({
      manifestPath,
      listFiles: () => ['README.md'],
      exec: () => execResult(0, 'ok'),
    });

    const formatted = formatDoctorReport(report);

    expect(formatted).toContain('skip  t0-lint');
    expect(formatted).toContain('green t1-typecheck');
  });
});
