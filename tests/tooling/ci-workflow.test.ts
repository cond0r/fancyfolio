import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const checkStart = workflow.indexOf('\n  check:\n');
const e2eStart = workflow.indexOf('\n  e2e:\n');
const bunStart = workflow.indexOf('\n  bun:\n');
const checkJob = workflow.slice(checkStart, e2eStart);
const e2eJob = workflow.slice(e2eStart, bunStart);
const bunJob = workflow.slice(bunStart);
const steps = workflow.split(/\n {6}- /);

describe('the CI workflow', () => {
  it('runs on pull requests and pushes to main with a read-only token', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n\n/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(workflow.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it('never runs on pull_request_target or workflow_run', () => {
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/);
  });

  it('keeps the token out of every checkout', () => {
    const checkouts = steps.filter((step) => step.includes('uses: actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step).toMatch(/^ +persist-credentials: false$/m);
  });

  it('passes no expression into a run step', () => {
    const runSteps = steps.filter((step) => /(^|\n)\s*run:/.test(step));
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) expect(step).not.toMatch(/\$\{\{/);
  });

  it('pins every action to a full commit SHA', () => {
    const refs = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThanOrEqual(10);
    for (const ref of refs) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('runs install, Biome, types, tests and the audit in the blocking job', () => {
    expect(checkStart).toBeGreaterThan(0);
    expect(e2eStart).toBeGreaterThan(checkStart);
    expect(bunStart).toBeGreaterThan(e2eStart);
    for (const step of [
      'pnpm install --frozen-lockfile',
      'pnpm exec biome ci',
      'pnpm typecheck',
      'pnpm test',
      'pnpm audit --audit-level high',
    ]) {
      expect(checkJob).toContain(`- run: ${step}\n`);
    }
    expect(checkJob).not.toContain('continue-on-error');
  });

  it('creates the owner and the Supabase roles the database suites check against', () => {
    for (const role of [
      "create role fancyfolio_owner login nosuperuser createdb createrole bypassrls password 'ci-owner-password-not-secret'",
      'create role anon nologin noinherit',
      'create role authenticated nologin noinherit',
      'create role service_role nologin noinherit bypassrls',
    ]) {
      expect(checkJob).toContain(`-c "${role}"`);
    }
  });

  it('builds the web and runs the smoke spec on Chromium with dummy env and no secrets', () => {
    expect(e2eStart).toBeGreaterThan(checkStart);
    expect(e2eJob).toContain('    env:\n      NEXT_TELEMETRY_DISABLED: 1\n    steps:\n');
    for (const step of [
      'pnpm install --frozen-lockfile',
      'pnpm exec playwright install --with-deps --only-shell chromium',
      'pnpm build',
      'pnpm e2e',
    ]) {
      expect(e2eJob).toContain(`- run: ${step}\n`);
    }
    expect(e2eJob.indexOf('- run: pnpm build\n')).toBeLessThan(e2eJob.indexOf('- run: pnpm e2e\n'));
    expect(e2eJob).not.toContain('continue-on-error');
    expect(workflow).not.toContain('secrets.');
  });

  it('runs the same tests under Bun without blocking the pull request', () => {
    expect(bunJob).toContain('    continue-on-error: true\n');
    expect(bunJob).toContain("- run: bun --bun run test --project '!db'\n");
    expect(workflow.match(/continue-on-error/g)).toHaveLength(1);
  });
});
