import { z } from 'zod';
import type { PersonRef } from '../change-request/dto.js';

export interface RepositoryDto {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  isAuthorized: boolean;
  authorizedBy: PersonRef | null;
  authorizedAt: string | null;
  /** The GitHub App no longer has access; can't be authorized. */
  removedAt: string | null;
  lastSyncedAt: string;
}

export const setRepositoryAuthorizationSchema = z.object({ authorized: z.boolean() }).strict();
export type SetRepositoryAuthorizationInput = z.infer<typeof setRepositoryAuthorizationSchema>;

export interface JobLogDto {
  seq: number;
  level: 'INFO' | 'WARN' | 'ERROR';
  source: string;
  message: string;
  createdAt: string;
}

export interface JobLogPageDto {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  lines: JobLogDto[];
  /** Pass as `after` to fetch only newer lines. */
  lastSeq: number;
}

export const jobLogQuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type JobLogQuery = z.infer<typeof jobLogQuerySchema>;
