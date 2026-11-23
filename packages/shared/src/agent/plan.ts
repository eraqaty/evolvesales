import { z } from 'zod';

/**
 * Implementation plan written by the repository analysis agent (§7).
 * The agent's JSON is validated against this schema before anything else looks at it, and the
 * Orchestrator's PlanVerifier then checks every cited excerpt against the repository.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

/** A repository-relative POSIX path: no leading slash, no `..` segment, no backslash or NUL. */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => isSafeRepoPath(p), 'must be a relative path inside the repository');

export function isSafeRepoPath(p: string): boolean {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((segment) => segment !== '..' && segment !== '' && segment !== '.');
}

export const planEvidenceSchema = z
  .object({
    path: repoPathSchema,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    /** Text copied verbatim from the file at those lines. */
    excerpt: text(2000),
  })
  .refine((e) => e.endLine >= e.startLine, { message: 'endLine must be >= startLine' });

export const PLAN_LAYERS = ['frontend', 'backend', 'database', 'tests', 'config'] as const;
export const PLAN_CHANGES = ['add', 'modify', 'delete'] as const;

export const affectedComponentSchema = z.object({
  layer: z.enum(PLAN_LAYERS),
  path: repoPathSchema,
  change: z.enum(PLAN_CHANGES),
  reason: text(1000),
  evidence: planEvidenceSchema.optional(),
  /** The agent's claim; the PlanVerifier overrides it after checking the evidence. */
  verified: z.boolean(),
  /** Set by the PlanVerifier when it downgrades a finding. */
  verificationNote: z.string().max(500).optional(),
});

export const implementationPlanSchema = z.object({
  originalRequest: text(4000),
  technicalInterpretation: text(4000),
  proposedImplementation: z
    .array(z.object({ step: z.number().int().min(1), description: text(2000) }))
    .min(1)
    .max(30),
  affectedComponents: z.array(affectedComponentSchema).max(60),
  databaseChanges: z.object({
    required: z.boolean(),
    migrations: z
      .array(z.object({ name: text(200), description: text(1000), additive: z.boolean() }))
      .max(10),
    dataImpact: z.string().trim().max(1000),
  }),
  newDependencies: z
    .array(z.object({ name: text(214), version: text(50), justification: text(500) }))
    .max(20),
  testRequirements: z
    .array(
      z.object({
        type: z.enum(['unit', 'integration', 'e2e']),
        description: text(1000),
        path: repoPathSchema,
      }),
    )
    .max(40),
  risks: z
    .array(
      z.object({
        category: z.enum(['security', 'compatibility', 'performance', 'data']),
        description: text(1000),
        severity: z.enum(['low', 'medium', 'high']),
        mitigation: text(1000),
      }),
    )
    .max(20),
  complexity: z.object({
    level: z.enum(['S', 'M', 'L', 'XL']),
    rationale: text(1000),
    estimatedFilesChanged: z.number().int().min(0).max(500),
  }),
  acceptanceCriteria: z.array(text(500)).min(1).max(30),
  assumptions: z.array(text(500)).max(40),
  /** Questions only the requester can answer; a non-empty list sends the CR to clarification. */
  blockingQuestions: z.array(text(500)).max(10),
});

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type AffectedComponent = z.infer<typeof affectedComponentSchema>;
export type PlanEvidence = z.infer<typeof planEvidenceSchema>;

/** What the PlanVerifier adds before the plan is stored. */
export const planVerificationSchema = z.object({
  baselineSha: z.string(),
  checkedAt: z.string(),
  verifiedCount: z.number().int().min(0),
  downgraded: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type PlanVerification = z.infer<typeof planVerificationSchema>;

export type StoredImplementationPlan = ImplementationPlan & { verification: PlanVerification };

/**
 * JSON Schema handed to the agent as its required output format. It carries the structure,
 * enums and required fields; lengths and path rules are enforced afterwards by
 * `implementationPlanSchema`, so a model that ignores a limit is rejected rather than trusted.
 */
export function implementationPlanJsonSchema(): Record<string, unknown> {
  return stripConstraints(z.toJSONSchema(implementationPlanSchema, { target: 'draft-7' }));
}

const DROPPED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
]);

function stripConstraints(node: unknown): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (!DROPPED_KEYWORDS.has(key)) out[key] = walk(child);
    }
    return out;
  };
  const result = walk(node);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
