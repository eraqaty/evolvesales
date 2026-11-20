import { z } from 'zod';
import { CrStatus } from './lifecycle.js';

export const ASSISTANT_LIMITS = {
  maxUserMessages: 20,
  maxMessageChars: 4000,
  maxClarificationQuestions: 3,
} as const;

/** Screens that can open the assistant (§6). */
export const SCREENS = [
  'sales.invoices.list',
  'sales.invoices.editor',
  'sales.invoices.details',
  'change-requests',
  'other',
] as const;
export type Screen = (typeof SCREENS)[number];

/** Client-captured screen context. Treated as untrusted data by the server and the LLM. */
export const screenContextSchema = z
  .object({
    screen: z.enum(SCREENS),
    route: z.string().max(300),
    filters: z.record(z.string().max(60), z.string().max(200)).optional(),
    visibleColumns: z.array(z.string().max(60)).max(30).optional(),
    selectedId: z.string().max(60).optional(),
    appVersion: z.string().max(60).optional(),
    locale: z.string().max(20).optional(),
  })
  .strict();
export type ScreenContext = z.infer<typeof screenContextSchema>;

export const CR_CATEGORIES = ['feature', 'enhancement', 'bug', 'report', 'other'] as const;
export const CR_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type CrPriority = (typeof CR_PRIORITIES)[number];

const line = (max: number) => z.string().trim().min(1).max(max);

/** The structured request the assistant proposes (`propose_change_request` tool, §6). */
export const changeRequestProposalSchema = z.object({
  title: line(120),
  category: z.enum(CR_CATEGORIES),
  description: line(2000),
  screen: z.enum(SCREENS),
  userStory: line(500),
  acceptanceCriteria: z.array(line(300)).min(1).max(12),
  outOfScope: z.array(line(300)).max(10).default([]),
  priority: z.enum(CR_PRIORITIES).default('MEDIUM'),
  assumptions: z.array(line(300)).max(10).default([]),
});
export type ChangeRequestProposal = z.infer<typeof changeRequestProposalSchema>;

/** `ask_clarification` tool input. */
export const clarificationSchema = z.object({
  questions: z.array(line(300)).min(1).max(ASSISTANT_LIMITS.maxClarificationQuestions),
});
export type Clarification = z.infer<typeof clarificationSchema>;

// ───────────── HTTP inputs ─────────────

export const createConversationSchema = z.object({
  screenContext: screenContextSchema,
  /** Continue the conversation of an existing request (clarification answers). */
  changeRequestId: z.uuid().optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxMessageChars),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const approveSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
  /** Required only when an Admin approves their own request (separation-of-duties override). */
  overrideReason: z.string().trim().max(1000).optional(),
});
export type ApproveInput = z.infer<typeof approveSchema>;

export const rejectSchema = z.object({ comment: line(2000) });
export type RejectInput = z.infer<typeof rejectSchema>;

export const clarifyRequestSchema = z.object({
  questions: z.array(line(500)).min(1).max(10),
});
export type ClarifyRequestInput = z.infer<typeof clarifyRequestSchema>;

export const retrySchema = z.object({
  mode: z.enum(['reanalyze', 'recode']),
  reason: line(1000),
});
export type RetryInput = z.infer<typeof retrySchema>;

export const listChangeRequestsQuerySchema = z.object({
  status: z.enum(CrStatus).optional(),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListChangeRequestsQuery = z.infer<typeof listChangeRequestsQuerySchema>;

export function formatCrKey(seq: number): string {
  return `CR-${String(seq).padStart(4, '0')}`;
}
