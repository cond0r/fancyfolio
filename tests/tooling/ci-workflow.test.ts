import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const checkStart = workflow.indexOf('\n  check:\n');
const bunStart = workflow.indexOf('\n  bun:\n');
const checkJob = workflow.slice(checkStart, bunStart);
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
    expect(refs.length).toBeGreaterThanOrEqual(7);
    for (const ref of refs) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('runs install, Biome, types, tests and the audit in the blocking job', () => {
    expect(checkStart).toBeGreaterThan(0);
    expect(bunStart).toBeGreaterThan(checkStart);
    for (const step of [
      'pnpm install --frozen-lockfile',
      'pnpm exec biome ci',
      'pnpm typecheck',
      'pnpm test',
      'pnpm audit --prod --audit-level high',
    ]) {
      expect(checkJob).toContain(`- run: ${step}\n`);
    }
    expect(checkJob).not.toContain('continue-on-error');
  });

  it('runs the same tests under Bun without blocking the pull request', () => {
    expect(bunJob).toContain('    continue-on-error: true\n');
    expect(bunJob).toContain('- run: bun --bun run test\n');
    expect(workflow.match(/continue-on-error/g)).toHaveLength(1);
  });
});
