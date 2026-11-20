import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@evolvesales/db';
import {
  ASSISTANT_LIMITS,
  type AssistantStreamEvent,
  type ChangeRequestProposal,
  changeRequestProposalSchema,
  type Clarification,
  clarificationSchema,
  type ConversationDto,
  type CreateConversationInput,
  type ScreenContext,
  screenContextSchema,
} from '@evolvesales/shared';
import { type ModelMessage, stepCountIs, streamText, tool, type ToolSet } from 'ai';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DataToolsService, dataToolSchemas, type DataToolName } from './data-tools.service.js';
import { LlmProvider } from './llm.provider.js';
import { buildSystemPrompt } from './prompts.js';

type ConversationRow = Prisma.ConversationGetPayload<{
  include: {
    messages: true;
    changeRequest: { select: { id: true; key: true; status: true; pendingQuestions: true } };
  };
}>;

export interface SubmitResult {
  changeRequestId: string;
  key: string;
  status: string;
}

const DATA_TOOL_DESCRIPTIONS: Record<DataToolName, string> = {
  findInvoices: 'Search invoices (max 10 rows). Read-only.',
  getInvoice: 'Get one invoice with up to 10 lines by its number. Read-only.',
  salesSummary:
    'Sales totals from confirmed invoices in a date range, grouped by customer, product or day (max 10 groups).',
  topCustomers: 'Top customers by confirmed sales in a date range.',
  customerSummary: 'Invoice counts and totals for one customer by customer code.',
  myChangeRequests: "The current user's own change requests and their status.",
  changeRequestStatus: 'Status of a change request by key (only if the user may see it).',
};

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  /** Per-user sliding window of message timestamps (rate limit, §6). */
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmProvider,
    private readonly dataTools: DataToolsService,
    private readonly changeRequests: ChangeRequestsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  status() {
    return this.llm.status();
  }

  async createConversation(
    input: CreateConversationInput,
    user: AuthUser,
  ): Promise<ConversationDto> {
    if (input.changeRequestId) {
      // Re-open the thread of the user's own request (e.g. to answer clarification questions).
      const cr = await this.prisma.changeRequest.findUnique({
        where: { id: input.changeRequestId },
        select: { id: true, requesterId: true },
      });
      if (!cr || cr.requesterId !== user.id) {
        throw new NotFoundException('Change request not found');
      }
      const existing = await this.prisma.conversation.findFirst({
        where: { changeRequestId: cr.id, userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) return this.getConversation(existing.id, user);
    }
    const created = await this.prisma.conversation.create({
      data: {
        userId: user.id,
        screen: input.screenContext.screen,
        screenContext: input.screenContext,
        changeRequestId: input.changeRequestId ?? null,
      },
    });
    return this.getConversation(created.id, user);
  }

  async getConversation(id: string, user: AuthUser): Promise<ConversationDto> {
    return toConversationDto(await this.loadOwn(id, user));
  }

  /**
   * Validates everything that can fail with a normal HTTP error *before* the response switches
   * to Server-Sent Events, then returns the event stream.
   */
  async prepareMessage(
    conversationId: string,
    content: string,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<(signal: AbortSignal) => AsyncGenerator<AssistantStreamEvent>> {
    const conversation = await this.loadOwn(conversationId, user);
    assertWritable(conversation);
    const userMessages = conversation.messages.filter((m) => m.role === 'user').length;
    if (userMessages >= ASSISTANT_LIMITS.maxUserMessages) {
      throw new UnprocessableEntityException(
        `This conversation reached ${ASSISTANT_LIMITS.maxUserMessages} messages; start a new one`,
      );
    }
    this.checkRateLimit(user.id);
    const model = this.llm.model(); // 503 if not configured

    await this.prisma.conversationMessage.create({
      data: { conversationId, role: 'user', content },
    });

    return (signal) => this.stream(conversation, content, model, user, ctx, signal);
  }

  private async *stream(
    conversation: ConversationRow,
    content: string,
    model: ReturnType<LlmProvider['model']>,
    user: AuthUser,
    ctx: RequestContext,
    signal: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    const proposalUpdates: ChangeRequestProposal[] = [];
    const clarificationUpdates: Clarification[] = [];
    const toolCalls: string[] = [];
    let text = '';

    const history: ModelMessage[] = conversation.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
    history.push({ role: 'user', content });

    const tools = this.buildTools(conversation, user, ctx, proposalUpdates, clarificationUpdates);
    const screenContext = parseScreenContext(conversation.screenContext);
    const proposal = parseProposal(conversation.proposal);

    try {
      const result = streamText({
        model,
        system: buildSystemPrompt({
          userName: user.displayName,
          roles: user.roles,
          screenContext,
          proposal,
          pendingQuestions:
            conversation.changeRequest?.status === 'CLARIFICATION_REQUIRED'
              ? conversation.changeRequest.pendingQuestions
              : [],
          today: new Date().toISOString().slice(0, 10),
        }),
        messages: history,
        tools,
        stopWhen: stepCountIs(this.config.env.ASSISTANT_MAX_STEPS),
        abortSignal: signal,
        maxRetries: 1,
      });

      let emittedProposals = 0;
      let emittedClarifications = 0;
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text += part.text;
          yield { type: 'text', delta: part.text };
        } else if (part.type === 'tool-call') {
          toolCalls.push(part.toolName);
          yield { type: 'tool', name: part.toolName };
        } else if (part.type === 'tool-result' || part.type === 'tool-error') {
          for (; emittedProposals < proposalUpdates.length; emittedProposals++) {
            const p = proposalUpdates[emittedProposals];
            if (p) yield { type: 'proposal', proposal: p };
          }
          for (; emittedClarifications < clarificationUpdates.length; emittedClarifications++) {
            const c = clarificationUpdates[emittedClarifications];
            if (c) yield { type: 'clarification', clarification: c };
          }
        } else if (part.type === 'error') {
          throw part.error;
        }
      }

      const usage = await result.totalUsage;
      const saved = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: text,
          metadata: {
            toolCalls,
            model: this.llm.status().model,
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
          },
        },
      });
      yield { type: 'done', messageId: saved.id };
    } catch (err) {
      if (signal.aborted) return;
      this.logger.error(
        `assistant stream failed for conversation ${conversation.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (text) {
        await this.prisma.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'assistant',
            content: text,
            metadata: { toolCalls, incomplete: true },
          },
        });
      }
      yield {
        type: 'error',
        message: 'The assistant could not answer right now. Please try again.',
      };
    }
  }

  private buildTools(
    conversation: ConversationRow,
    user: AuthUser,
    ctx: RequestContext,
    proposals: ChangeRequestProposal[],
    clarifications: Clarification[],
  ): ToolSet {
    const tools: ToolSet = {
      propose_change_request: tool({
        description:
          'Record the structured change request for the user to review. Call again to update it.',
        inputSchema: changeRequestProposalSchema,
        execute: async (input: ChangeRequestProposal) => {
          await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: { proposal: input, pendingClarification: Prisma.DbNull },
          });
          proposals.push(input);
          return {
            status: 'shown to the user as a summary card',
            next: 'Ask the user to review it and press "Submit request". It is NOT submitted yet.',
          };
        },
      }),
      ask_clarification: tool({
        description: `Ask the user up to ${ASSISTANT_LIMITS.maxClarificationQuestions} questions whose answers change what would be built.`,
        inputSchema: clarificationSchema,
        execute: async (input: Clarification) => {
          await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: { pendingClarification: input },
          });
          clarifications.push(input);
          return { status: 'questions shown to the user' };
        },
      }),
    };

    for (const name of Object.keys(dataToolSchemas) as DataToolName[]) {
      tools[name] = tool({
        description: DATA_TOOL_DESCRIPTIONS[name],
        inputSchema: dataToolSchemas[name],
        execute: async (args: unknown) => {
          const parsed = dataToolSchemas[name].parse(args);
          return this.dataTools.run(name, parsed, user, ctx);
        },
      });
    }
    return tools;
  }

  /** The explicit human action that turns the proposal into a change request (§6 step 5). */
  async submit(conversationId: string, user: AuthUser, ctx: RequestContext): Promise<SubmitResult> {
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          changeRequest: { select: { id: true, key: true, status: true, pendingQuestions: true } },
        },
      });
      if (!conversation || conversation.userId !== user.id) {
        throw new NotFoundException('Conversation not found');
      }
      const proposal = parseProposal(conversation.proposal);
      if (!proposal) {
        throw new UnprocessableEntityException(
          'There is no request to submit yet; describe the change to the assistant first',
        );
      }
      const originalRequest = conversation.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n\n');
      const input = {
        proposal,
        originalRequest,
        screenContext: parseScreenContext(conversation.screenContext),
      };

      let result: SubmitResult;
      const existing = conversation.changeRequest;
      if (existing) {
        if (existing.status !== 'CLARIFICATION_REQUIRED') {
          throw new ConflictException(`This conversation was already submitted as ${existing.key}`);
        }
        await this.changeRequests.resubmit(tx, existing.id, input, user, ctx);
        result = { changeRequestId: existing.id, key: existing.key, status: 'SUBMITTED' };
      } else {
        const cr = await this.changeRequests.create(tx, input, user, ctx);
        result = { changeRequestId: cr.id, key: cr.key, status: cr.status };
      }

      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: 'SUBMITTED',
          changeRequestId: result.changeRequestId,
          pendingClarification: Prisma.DbNull,
        },
      });
      await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'system',
          content: `Submitted as ${result.key}. You will be notified when it moves on.`,
          metadata: { kind: 'submitted', changeRequestId: result.changeRequestId },
        },
      });
      await this.audit.record(
        {
          action: existing ? 'assistant.resubmitted' : 'assistant.submitted',
          entityType: 'ChangeRequest',
          entityId: result.changeRequestId,
          after: { key: result.key, conversationId: conversation.id },
        },
        ctx,
        tx,
      );
      return result;
    });
  }

  private async loadOwn(id: string, user: AuthUser): Promise<ConversationRow> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        changeRequest: { select: { id: true, key: true, status: true, pendingQuestions: true } },
      },
    });
    if (!conversation || conversation.userId !== user.id) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  private checkRateLimit(userId: string): void {
    const now = Date.now();
    const windowStart = now - 60_000;
    const stamps = (this.recent.get(userId) ?? []).filter((t) => t > windowStart);
    if (stamps.length >= this.config.env.ASSISTANT_RATE_LIMIT_PER_MINUTE) {
      throw new HttpException(
        'Too many assistant messages; wait a minute and try again',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    stamps.push(now);
    this.recent.set(userId, stamps);
  }
}

function assertWritable(c: ConversationRow): void {
  if (c.status === 'OPEN') return;
  if (c.changeRequest?.status === 'CLARIFICATION_REQUIRED') return;
  throw new ConflictException(
    c.changeRequest
      ? `This conversation was submitted as ${c.changeRequest.key}; start a new one for another change`
      : 'This conversation is closed',
  );
}

function parseProposal(value: unknown): ChangeRequestProposal | null {
  const parsed = changeRequestProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseClarification(value: unknown): Clarification | null {
  const parsed = clarificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseScreenContext(value: unknown): ScreenContext | null {
  const parsed = screenContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toConversationDto(c: ConversationRow): ConversationDto {
  return {
    id: c.id,
    screen: c.screen,
    status: c.status,
    changeRequestId: c.changeRequest?.id ?? null,
    changeRequestKey: c.changeRequest?.key ?? null,
    proposal: parseProposal(c.proposal),
    pendingClarification: parseClarification(c.pendingClarification),
    messages: c.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
    userMessageCount: c.messages.filter((m) => m.role === 'user').length,
  };
}
