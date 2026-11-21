import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Public } from '../auth/decorators.js';
import { AppConfig } from '../config/app-config.js';
import { verifyMetaSignature } from './signature.js';
import { parseWebhook } from './webhook-payload.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';

/**
 * Meta's webhook (§19.2). Public, because Meta can't send our JWT; instead every POST must carry
 * a valid X-Hub-Signature-256 over the raw body. Returns 200 quickly: work happens in the queue.
 * The tunnel exposes only this path. 404 when WhatsApp is disabled.
 */
@Public()
@Throttle({ default: { limit: 300, ttl: 60_000 } })
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfig,
    private readonly inbound: WhatsAppInboundService,
  ) {}

  /** Meta's one-time subscription check: echo hub.challenge if hub.verify_token matches. */
  @Get()
  verify(@Query() query: Record<string, unknown>): string {
    const wa = this.config.whatsapp;
    if (!wa) throw new NotFoundException();
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(challenge) ||
      !safeEqual(token, wa.verifyToken)
    ) {
      throw new ForbiddenException('Verification failed');
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ status: 'ok' }> {
    const wa = this.config.whatsapp;
    if (!wa) throw new NotFoundException();
    if (!verifyMetaSignature(req.rawBody, signature, wa.appSecret)) {
      this.logger.warn('Rejected a WhatsApp webhook call with a missing or invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }
    await this.inbound.ingest(parseWebhook(req.body as unknown, wa.phoneNumberId));
    return { status: 'ok' };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
