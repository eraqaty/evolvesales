import { z } from 'zod';

/** Phone numbers in E.164 form, e.g. +201001234567 (§19.3). */
export const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use the international format, e.g. +201001234567');

export const linkPhoneSchema = z.object({ phone: e164Schema }).strict();
export type LinkPhoneInput = z.infer<typeof linkPhoneSchema>;

export const setApprovalPinSchema = z
  .object({
    pin: z.string().regex(/^\d{6}$/, 'The PIN must be exactly 6 digits'),
    /** Setting or changing the PIN needs the account password. */
    currentPassword: z.string().min(1).max(200),
  })
  .strict();
export type SetApprovalPinInput = z.infer<typeof setApprovalPinSchema>;

/** WhatsApp notifications per event type; the web bell always receives everything. */
export const notificationPrefsSchema = z
  .object({
    statusChanged: z.boolean(),
    awaitingApproval: z.boolean(),
    clarificationNeeded: z.boolean(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  statusChanged: true,
  awaitingApproval: true,
  clarificationNeeded: true,
};

/** Which preference controls a notification type; types not listed are web-only. */
export const NOTIFICATION_PREF_KEY: Readonly<Record<string, keyof NotificationPrefs>> = {
  'cr.status_changed': 'statusChanged',
  'cr.awaiting_approval': 'awaitingApproval',
  'cr.clarification_needed': 'clarificationNeeded',
};

export function parseNotificationPrefs(value: unknown): NotificationPrefs {
  const parsed = notificationPrefsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_PREFS;
}

export const PHONE_LINK = {
  codeTtlMinutes: 10,
  maxAttempts: 5,
} as const;

export const APPROVAL_PIN = {
  maxFailures: 5,
  lockMinutes: 30,
  /** How long the bot waits for the PIN, reason or questions after a button tap. */
  stageMinutes: 5,
  cardTtlHours: 24,
} as const;

export interface WhatsAppProfileDto {
  /** WhatsApp is configured on the server (WHATSAPP_ENABLED and credentials). */
  enabled: boolean;
  /** The bot's number to message, when known (WHATSAPP_DISPLAY_NUMBER). */
  botNumber: string | null;
  phone: string | null;
  verifiedAt: string | null;
  pending: { phone: string; expiresAt: string } | null;
  hasApprovalPin: boolean;
  pinLockedUntil: string | null;
  canApprove: boolean;
  prefs: NotificationPrefs;
}

export interface LinkPhoneResult {
  code: string;
  phone: string;
  expiresAt: string;
  botNumber: string | null;
  /** https://wa.me/<bot>?text=LINK%20123456 when the bot number is known. */
  waLink: string | null;
}
