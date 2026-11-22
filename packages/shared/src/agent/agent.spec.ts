import { describe, expect, it } from 'vitest';
import {
  implementationPlanJsonSchema,
  implementationPlanSchema,
  isSafeRepoPath,
  type ImplementationPlan,
} from './plan.js';
import { parseRunnerEvent, redactSecrets } from './runner-protocol.js';
import { budgetDayStart, checkAgentBudget, updateAgentSettingsSchema } from './settings.js';

export const samplePlan = (): ImplementationPlan => ({
  originalRequest: 'Add an export button',
  technicalInterpretation: 'Add a CSV export to the invoice list',
  proposedImplementation: [{ step: 1, description: 'Add a button' }],
  affectedComponents: [
    {
      layer: 'frontend',
      path: 'apps/web/src/features/invoices/InvoiceListPage.tsx',
      change: 'modify',
      reason: 'The button goes here',
      evidence: {
        path: 'apps/web/src/features/invoices/InvoiceListPage.tsx',
        startLine: 1,
        endLine: 2,
        excerpt: 'import',
      },
      verified: true,
    },
  ],
  databaseChanges: { required: false, migrations: [], dataImpact: '' },
  newDependencies: [],
  testRequirements: [
    { type: 'unit', description: 'Button renders', path: 'apps/web/src/x.test.tsx' },
  ],
  risks: [],
  complexity: { level: 'S', rationale: 'One component', estimatedFilesChanged: 2 },
  acceptanceCriteria: ['The button downloads a file'],
  assumptions: [],
  blockingQuestions: [],
});

describe('implementation plan schema', () => {
  it('accepts a well-formed plan', () => {
    expect(implementationPlanSchema.safeParse(samplePlan()).success).toBe(true);
  });

  it('rejects paths that escape the repository', () => {
    for (const bad of ['/etc/passwd', '../secret', 'a/../../b', 'a\\b', 'a//b', './a']) {
      expect([bad, isSafeRepoPath(bad)]).toEqual([bad, false]);
    }
    expect(isSafeRepoPath('apps/api/src/main.ts')).toBe(true);
    const plan = samplePlan();
    plan.affectedComponents[0]!.path = '../outside.ts';
    expect(implementationPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects evidence whose line range is reversed', () => {
    const plan = samplePlan();
    plan.affectedComponents[0]!.evidence = { path: 'a.ts', startLine: 5, endLine: 2, excerpt: 'x' };
    expect(implementationPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('produces a JSON schema for the agent without length constraints', () => {
    const schema = JSON.stringify(implementationPlanJsonSchema());
    expect(schema).toContain('blockingQuestions');
    expect(schema).toContain('"enum"');
    expect(schema).not.toContain('maxLength');
    expect(schema).not.toContain('$schema');
  });
});

describe('runner protocol', () => {
  it('parses protocol events and ignores other output', () => {
    expect(
      parseRunnerEvent('{"type":"log","level":"info","source":"runner","message":"hi"}'),
    ).toEqual({ type: 'log', level: 'info', source: 'runner', message: 'hi' });
    expect(parseRunnerEvent('plain text')).toBeNull();
    expect(parseRunnerEvent('{"type":"result","ok":true}')).toBeNull();
    expect(parseRunnerEvent('{not json')).toBeNull();
  });

  it('redacts credentials', () => {
    const line =
      'ghs_abcdefghijklmnopqrstuvwxyz0123 sk-ant-api03-abcdefghijkl https://x-access-token:abc@github.com Authorization: Bearer xyz';
    const out = redactSecrets(line);
    expect(out).not.toMatch(/ghs_abc|sk-ant-api03|:abc@|Bearer xyz/);
  });
});

describe('agent budget', () => {
  it('refuses to start until both caps are set (no defaults)', () => {
    const check = checkAgentBudget({ perJobCapUsd: null, dailyCapUsd: '20', spentTodayUsd: 0 });
    expect(check).toMatchObject({ ok: false, reason: 'caps_not_set' });
  });

  it('reserves the per-job cap against the daily cap', () => {
    expect(checkAgentBudget({ perJobCapUsd: '5', dailyCapUsd: '20', spentTodayUsd: '15' })).toEqual(
      {
        ok: true,
        perJobUsd: '5.00',
      },
    );
    expect(
      checkAgentBudget({ perJobCapUsd: '5', dailyCapUsd: '20', spentTodayUsd: '15.01' }),
    ).toMatchObject({ ok: false, reason: 'daily_cap_reached' });
  });

  it('validates the settings body', () => {
    expect(
      updateAgentSettingsSchema.parse({ analyzeMaxBudgetUsd: 5, dailyBudgetUsd: '20' }),
    ).toEqual({ analyzeMaxBudgetUsd: '5.00', dailyBudgetUsd: '20.00' });
    expect(
      updateAgentSettingsSchema.safeParse({ analyzeMaxBudgetUsd: 0, dailyBudgetUsd: 5 }).success,
    ).toBe(false);
    expect(
      updateAgentSettingsSchema.safeParse({ analyzeMaxBudgetUsd: 10, dailyBudgetUsd: 5 }).success,
    ).toBe(false);
    expect(
      updateAgentSettingsSchema.safeParse({ analyzeMaxBudgetUsd: 500, dailyBudgetUsd: 900 })
        .success,
    ).toBe(false);
    expect(
      updateAgentSettingsSchema.safeParse({ analyzeMaxBudgetUsd: '1e3', dailyBudgetUsd: 900 })
        .success,
    ).toBe(false);
  });

  it('reports empty or malformed amounts as validation errors, never throws', () => {
    for (const body of [
      { analyzeMaxBudgetUsd: '', dailyBudgetUsd: '' },
      { analyzeMaxBudgetUsd: '5', dailyBudgetUsd: '' },
      { analyzeMaxBudgetUsd: 'abc', dailyBudgetUsd: '20' },
      { analyzeMaxBudgetUsd: null, dailyBudgetUsd: undefined },
    ]) {
      expect(updateAgentSettingsSchema.safeParse(body).success).toBe(false);
    }
  });

  it('uses UTC days', () => {
    expect(budgetDayStart(new Date('2026-11-22T23:30:00+02:00')).toISOString()).toBe(
      '2026-11-22T00:00:00.000Z',
    );
  });
});
