import { z } from 'zod';
import { dec, type DecimalInput, money } from '../money.js';
import type { PersonRef } from '../change-request/dto.js';

/** Upper bounds for what an admin may configure, as a guard against typos (e.g. 5000 for 50). */
export const AGENT_BUDGET_LIMITS = { perJobMaxUsd: 100, dailyMaxUsd: 1000 } as const;

const usd = (max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .trim()
        .regex(/^\d+(\.\d{1,2})?$/, 'use a plain amount like 5.00'),
    ])
    .transform((v) => money(v))
    .refine((v) => dec(v).gt(0), 'must be more than 0')
    .refine((v) => dec(v).lte(max), `must be at most ${max}`);

export const updateAgentSettingsSchema = z
  .object({
    analyzeMaxBudgetUsd: usd(AGENT_BUDGET_LIMITS.perJobMaxUsd),
    dailyBudgetUsd: usd(AGENT_BUDGET_LIMITS.dailyMaxUsd),
  })
  .strict()
  // zod still runs this when a field failed, so only compare amounts that parsed.
  .refine(
    (v) =>
      !isMoney(v.dailyBudgetUsd) ||
      !isMoney(v.analyzeMaxBudgetUsd) ||
      dec(v.dailyBudgetUsd).gte(v.analyzeMaxBudgetUsd),
    { message: 'The daily cap must be at least the per-job cap', path: ['dailyBudgetUsd'] },
  );

function isMoney(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d{2}$/.test(value);
}
export type UpdateAgentSettingsInput = z.infer<typeof updateAgentSettingsSchema>;

export interface AgentSettingsDto {
  /** null = not set; agent jobs refuse to start until both caps are set. */
  analyzeMaxBudgetUsd: string | null;
  dailyBudgetUsd: string | null;
  /** Estimated agent spend since 00:00 UTC today. */
  spentTodayUsd: string;
  updatedAt: string | null;
  updatedBy: PersonRef | null;
}

/** Start of the current budget day (UTC). */
export function budgetDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type BudgetCheck =
  | { ok: true; perJobUsd: string }
  | { ok: false; reason: 'caps_not_set' | 'daily_cap_reached'; message: string };

/**
 * Decides whether an agent job may start (§0: no built-in defaults). A job reserves its whole
 * per-job cap, so a job starts only if spent + cap stays within the daily cap.
 */
export function checkAgentBudget(input: {
  perJobCapUsd: DecimalInput | null;
  dailyCapUsd: DecimalInput | null;
  spentTodayUsd: DecimalInput;
}): BudgetCheck {
  if (input.perJobCapUsd === null || input.dailyCapUsd === null) {
    return {
      ok: false,
      reason: 'caps_not_set',
      message:
        'Agent spend caps are not set. An admin must set the per-job and daily caps in Agent settings before analysis can run.',
    };
  }
  const projected = dec(input.spentTodayUsd).plus(input.perJobCapUsd);
  if (projected.gt(input.dailyCapUsd)) {
    return {
      ok: false,
      reason: 'daily_cap_reached',
      message: `Daily agent budget reached: ${money(input.spentTodayUsd)} of ${money(input.dailyCapUsd)} USD spent today, and a job may use up to ${money(input.perJobCapUsd)} USD. Retry tomorrow or raise the daily cap.`,
    };
  }
  return { ok: true, perJobUsd: money(input.perJobCapUsd) };
}
