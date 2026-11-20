import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module.js';
import { ChangeRequestsModule } from '../change-requests/change-requests.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { WhatsAppClient } from './whatsapp.client.js';
import { WhatsAppApprovalsService } from './whatsapp-approvals.service.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';
import { WhatsAppMessenger } from './whatsapp-messenger.js';
import { WhatsAppNotifierService } from './whatsapp-notifier.service.js';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';

/** WhatsApp channel (§19). Inert unless WHATSAPP_ENABLED=true. */
@Module({
  imports: [AssistantModule, ChangeRequestsModule, ProfileModule],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppClient,
    WhatsAppMessenger,
    WhatsAppApprovalsService,
    WhatsAppInboundService,
    WhatsAppNotifierService,
  ],
})
export class WhatsAppModule {}
