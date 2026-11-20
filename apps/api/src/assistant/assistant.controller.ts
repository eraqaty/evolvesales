import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  type ConversationDto,
  type CreateConversationInput,
  createConversationSchema,
  type SendMessageInput,
  sendMessageSchema,
} from '@evolvesales/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ReqCtx, type RequestContext } from '../common/request-context.js';
import { AssistantService, type SubmitResult } from './assistant.service.js';
import type { LlmStatus } from './llm.provider.js';

const idParam = { schema: z.uuid() };

/** AI Request Assistant (Screen B). Every signed-in user may use it for their own conversations. */
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('status')
  status(): LlmStatus {
    return this.assistant.status();
  }

  @Post('conversations')
  create(
    @Body({ schema: createConversationSchema }) body: CreateConversationInput,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationDto> {
    return this.assistant.createConversation(body, user);
  }

  @Get('conversations/:id')
  get(@Param('id', idParam) id: string, @CurrentUser() user: AuthUser): Promise<ConversationDto> {
    return this.assistant.getConversation(id, user);
  }

  /** Streams the reply as Server-Sent Events (`data: AssistantStreamEvent`). */
  @Post('conversations/:id/messages')
  async message(
    @Param('id', idParam) id: string,
    @Body({ schema: sendMessageSchema }) body: SendMessageInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    // Validation, ownership, limits and "not configured" fail here as normal JSON errors.
    const stream = await this.assistant.prepareMessage(id, body.content, user, ctx);

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    for await (const event of stream(abort.signal)) {
      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }

  @Post('conversations/:id/submit')
  @HttpCode(201)
  submit(
    @Param('id', idParam) id: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<SubmitResult> {
    return this.assistant.submit(id, user, ctx);
  }
}
