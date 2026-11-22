/** pg-boss queue names, shared by the API (publisher) and the Orchestrator (consumer). */
export const QUEUE = {
  Analyze: 'cr-analyze',
  /** Inbound WhatsApp messages, consumed by the API's channel worker (§19.2). */
  WhatsAppInbound: 'whatsapp-inbound',
  /** Refresh the GitHub App's repository list; published by the API, run by the Orchestrator. */
  RepoSync: 'github-repo-sync',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface AnalyzeJobData {
  changeRequestId: string;
  /** Why analysis was requested; for logs and the job record. */
  trigger: 'submitted' | 'resubmitted' | 'retry';
}

export interface WhatsAppInboundJobData {
  /** InboundChannelEvent id. */
  eventId: string;
}

export interface RepoSyncJobData {
  /** User who asked for the refresh (audit). */
  requestedById: string;
}

/** pg-boss stores its tables in this schema of the same database. */
export const QUEUE_SCHEMA = 'pgboss';
