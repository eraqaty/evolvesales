/** pg-boss queue names, shared by the API (publisher) and the Orchestrator (consumer). */
export const QUEUE = {
  Analyze: 'cr-analyze',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface AnalyzeJobData {
  changeRequestId: string;
  /** Why analysis was requested; for logs and the job record. */
  trigger: 'submitted' | 'resubmitted' | 'retry';
}

/** pg-boss stores its tables in this schema of the same database. */
export const QUEUE_SCHEMA = 'pgboss';
