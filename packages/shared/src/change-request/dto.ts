import type { Role } from '../roles.js';
import type { CrStatus } from './lifecycle.js';
import type { ChangeRequestProposal, Clarification, CrPriority, ScreenContext } from './schemas.js';

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface ChangeRequestSummaryDto {
  id: string;
  key: string;
  title: string;
  status: CrStatus;
  priority: CrPriority;
  screen: string;
  requester: PersonRef;
  createdAt: string;
  updatedAt: string;
}

export interface StatusTransitionDto {
  id: string;
  from: CrStatus | null;
  to: CrStatus;
  actorType: 'USER' | 'SYSTEM';
  actor: PersonRef | null;
  reason: string | null;
  createdAt: string;
}

export interface ApprovalDecisionDto {
  id: string;
  decision: 'APPROVED' | 'REJECTED' | 'CLARIFICATION';
  actor: PersonRef;
  comment: string | null;
  planVersion: number | null;
  overrideReason: string | null;
  createdAt: string;
}

export interface AgentJobDto {
  id: string;
  type: 'ANALYZE' | 'CODE';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  agentKind: string | null;
  model: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ImplementationPlanDto {
  id: string;
  version: number;
  baselineSha: string | null;
  plan: unknown;
  verifiedCount: number;
  assumptionCount: number;
  agent: string | null;
  model: string | null;
  createdAt: string;
}

export interface ConversationMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface ChangeRequestDetailDto extends ChangeRequestSummaryDto {
  originalRequest: string;
  structured: ChangeRequestProposal;
  screenContext: ScreenContext | null;
  conversationId: string | null;
  pendingQuestions: string[];
  transitions: StatusTransitionDto[];
  decisions: ApprovalDecisionDto[];
  plans: ImplementationPlanDto[];
  jobs: AgentJobDto[];
  /** What the current user may do now (computed server-side; the server re-checks on every action). */
  allowedActions: ChangeRequestAction[];
}

export type ChangeRequestAction =
  'approve' | 'reject' | 'clarify' | 'answer' | 'retry-reanalyze' | 'retry-recode';

export interface ConversationDto {
  id: string;
  screen: string;
  status: 'OPEN' | 'SUBMITTED' | 'CLOSED';
  changeRequestId: string | null;
  changeRequestKey: string | null;
  proposal: ChangeRequestProposal | null;
  pendingClarification: Clarification | null;
  messages: ConversationMessageDto[];
  userMessageCount: number;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Events streamed by POST /assistant/conversations/:id/messages (Server-Sent Events). */
export type AssistantStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: ChangeRequestProposal }
  | { type: 'clarification'; clarification: Clarification }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

/** Realtime events published over Postgres NOTIFY and relayed to browsers via Socket.IO. */
export interface RealtimeEvent {
  type: 'cr.updated' | 'notification';
  changeRequestId?: string;
  status?: CrStatus;
  /** Users to notify directly. */
  userIds: string[];
  /** Roles whose members should refresh their lists. */
  roles: Role[];
}

export const REALTIME_CHANNEL = 'evolvesales_events';
