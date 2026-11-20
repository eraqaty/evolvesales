import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { NOTIFICATION_PREF_KEY, parseNotificationPrefs } from '@evolvesales/shared';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canApprove } from '../profile/profile.service.js';
import { templateMessage, textMessages } from './renderer.js';
import { WhatsAppApprovalsService } from './whatsapp-approvals.service.js';
import {
  isWindowOpen,
  LINKED_USER_SELECT,
  type LinkedUser,
  recipientOf,
  toLinkedUser,
  WhatsAppMessenger,
} from './whatsapp-messenger.js';

export const STATUS_TEMPLATE = 'cr_status_changed';
export const CLARIFICATION_TEMPLATE = 'cr_clarification_needed';

/** Notifications older than this are web-only (no late WhatsApp pings after downtime). */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Delivers web notifications to WhatsApp as well (§19.5): approval cards to approvers, status
 * and clarification messages to requesters, honouring each user's preferences and Meta's
 * 24-hour rule (free-form inside the window, approved templates outside it).
 * Each notification is claimed with a guarded UPDATE, so several API instances never double-send.
 */
@Injectable()
export class WhatsAppNotifierService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppNotifierService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: WhatsAppApprovalsService,
    private readonly messenger: WhatsAppMessenger,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.env.WHATSAPP_DISPATCH_INTERVAL_MS;
    if (!this.config.whatsapp || every === 0) return;
    this.timer = setInterval(() => void this.dispatchPending(), every);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends what is due; returns how many notifications were claimed. */
  async dispatchPending(): Promise<number> {
    if (!this.config.whatsapp || this.running) return 0;
    this.running = true;
    try {
      const due = await this.prisma.notification.findMany({
        where: {
          whatsappHandledAt: null,
          createdAt: { gt: new Date(Date.now() - MAX_AGE_MS) },
          type: { in: Object.keys(NOTIFICATION_PREF_KEY) },
          user: { isActive: true, phoneVerifiedAt: { not: null } },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        include: { user: { select: { ...LINKED_USER_SELECT, notificationPrefs: true } } },
      });
      let claimed = 0;
      for (const n of due) {
        const { count } = await this.prisma.notification.updateMany({
          where: { id: n.id, whatsappHandledAt: null },
          data: { whatsappHandledAt: new Date() },
        });
        if (count === 0) continue;
        claimed++;
        const prefKey = NOTIFICATION_PREF_KEY[n.type];
        if (!prefKey || !parseNotificationPrefs(n.user.notificationPrefs)[prefKey]) continue;
        try {
          await this.deliver(n, toLinkedUser(n.user));
        } catch (err) {
          this.logger.warn(
            `WhatsApp delivery of notification ${n.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return claimed;
    } finally {
      this.running = false;
    }
  }

  private async deliver(
    n: { id: string; type: string; title: string; body: string; link: string | null },
    user: LinkedUser,
  ): Promise<void> {
    const crId = /^\/requests\/([0-9a-f-]{36})$/i.exec(n.link ?? '')?.[1];
    if (!crId) return;

    if (n.type === 'cr.awaiting_approval') {
      if (canApprove(user.roles)) await this.approvals.sendCard(user, crId, n.id);
      return;
    }

    const link = `${this.config.publicWebUrl}${n.link ?? ''}`;
    const lang = this.config.whatsapp?.templateLanguage ?? 'en_US';
    const to = recipientOf(user);

    if (n.type === 'cr.clarification_needed') {
      const onWhatsApp = await this.prisma.conversation.count({
        where: { changeRequestId: crId, userId: user.id, channel: 'WHATSAPP' },
      });
      const how = onWhatsApp > 0 ? 'Reply here to answer.' : `Answer in the web app: ${link}`;
      const messages = isWindowOpen(user.lastInboundAt)
        ? textMessages(`*${n.title}*\n${n.body}\n\n${how}`)
        : [templateMessage(CLARIFICATION_TEMPLATE, lang, [n.title, n.body])];
      await this.messenger.send(to, messages, n.type, n.id);
      return;
    }

    const messages = isWindowOpen(user.lastInboundAt)
      ? textMessages(`*${n.title}*\n${n.body}\n${link}`)
      : [templateMessage(STATUS_TEMPLATE, lang, [n.title, n.body])];
    await this.messenger.send(to, messages, n.type, n.id);
  }
}
