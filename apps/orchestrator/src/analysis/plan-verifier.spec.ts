import { describe, expect, it } from 'vitest';
import type { ImplementationPlan } from '@evolvesales/shared';
import { type RepoSnapshot, verifyPlan } from './plan-verifier.js';

const FILE = [
  "import { Button } from '@mantine/core';",
  '',
  'export function InvoiceListPage() {',
  '  return (',
  '    <Button>New invoice</Button>',
  '  );',
  '}',
].join('\n');

const repo: RepoSnapshot = {
  sha: 'a'.repeat(40),
  hasFile: (p) => p === 'apps/web/List.tsx' || p === 'logo.png',
  readFile: (p) => Promise.resolve(p === 'apps/web/List.tsx' ? FILE : null),
};

function plan(components: ImplementationPlan['affectedComponents']): ImplementationPlan {
  return {
    originalRequest: 'r',
    technicalInterpretation: 't',
    proposedImplementation: [{ step: 1, description: 'd' }],
    affectedComponents: components,
    databaseChanges: { required: false, migrations: [], dataImpact: '' },
    newDependencies: [],
    testRequirements: [],
    risks: [],
    complexity: { level: 'S', rationale: 'r', estimatedFilesChanged: 1 },
    acceptanceCriteria: ['a'],
    assumptions: ['existing assumption'],
    blockingQuestions: [],
  };
}

const base = { layer: 'frontend', reason: 'r' } as const;

describe('PlanVerifier', () => {
  it('verifies an excerpt found near the cited lines, ignoring indentation', async () => {
    const r = await verifyPlan(
      plan([
        {
          ...base,
          path: 'apps/web/List.tsx',
          change: 'modify',
          verified: true,
          evidence: {
            path: 'apps/web/List.tsx',
            startLine: 3,
            endLine: 5,
            excerpt: 'export function InvoiceListPage() {\n return (\n<Button>New invoice</Button>',
          },
        },
      ]),
      repo,
      new Date('2026-11-22T10:00:00Z'),
    );
    expect(r.verifiedCount).toBe(1);
    expect(r.plan.affectedComponents[0]).toMatchObject({ verified: true });
    expect(r.plan.verification).toEqual({
      baselineSha: 'a'.repeat(40),
      checkedAt: '2026-11-22T10:00:00.000Z',
      verifiedCount: 1,
      downgraded: [],
    });
    expect(r.assumptionCount).toBe(1);
  });

  it('downgrades invented excerpts, missing files and claims without evidence', async () => {
    const r = await verifyPlan(
      plan([
        {
          ...base,
          path: 'apps/web/List.tsx',
          change: 'modify',
          verified: true,
          evidence: {
            path: 'apps/web/List.tsx',
            startLine: 1,
            endLine: 2,
            excerpt: 'export const exportToExcel = true;',
          },
        },
        {
          ...base,
          path: 'apps/web/Missing.tsx',
          change: 'modify',
          verified: true,
          evidence: { path: 'apps/web/Missing.tsx', startLine: 1, endLine: 1, excerpt: 'x' },
        },
        { ...base, path: 'apps/web/List.tsx', change: 'delete', verified: true },
        {
          ...base,
          path: 'logo.png',
          change: 'modify',
          verified: true,
          evidence: { path: 'logo.png', startLine: 1, endLine: 1, excerpt: 'PNG' },
        },
        {
          ...base,
          path: 'apps/web/List.tsx',
          change: 'modify',
          verified: true,
          evidence: { path: 'apps/web/List.tsx', startLine: 400, endLine: 401, excerpt: 'Button' },
        },
      ]),
      repo,
    );
    expect(r.verifiedCount).toBe(0);
    expect(r.plan.affectedComponents.every((c) => !c.verified && c.verificationNote)).toBe(true);
    const reasons = r.plan.verification.downgraded.map((d) => d.reason);
    expect(reasons).toEqual([
      expect.stringMatching(/excerpt was not found/),
      expect.stringMatching(/does not exist/),
      expect.stringMatching(/No evidence/),
      expect.stringMatching(/could not be read/),
      expect.stringMatching(/past the end/),
    ]);
    expect(r.plan.assumptions).toHaveLength(6);
    expect(r.plan.assumptions[1]).toMatch(/^Unverified finding for apps\/web\/List.tsx/);
  });

  it('treats new files as unverified without counting them as downgrades', async () => {
    const r = await verifyPlan(
      plan([
        { ...base, path: 'apps/web/Export.tsx', change: 'add', verified: false },
        { ...base, path: 'apps/web/List.tsx', change: 'add', verified: false },
      ]),
      repo,
    );
    expect(r.plan.affectedComponents.map((c) => c.verificationNote)).toEqual([
      'New file: there is nothing to cite yet',
      expect.stringMatching(/already exists/),
    ]);
    expect(r.plan.verification.downgraded).toHaveLength(0);
  });
});
