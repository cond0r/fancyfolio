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

describe('the CI workflow', () => {
  it('runs on pull requests with a read-only token', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(workflow).toContain('\npermissions:\n  contents: read\n');
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
