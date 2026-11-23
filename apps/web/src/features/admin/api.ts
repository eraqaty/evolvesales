import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentSettingsDto,
  JobLogPageDto,
  RepositoryDto,
  UpdateAgentSettingsInput,
} from '@evolvesales/shared';
import { http } from '../../lib/api';

export const repositoriesKey = ['admin', 'repositories'] as const;
const settingsKey = ['admin', 'agent-settings'] as const;

export function useRepositories() {
  return useQuery({
    queryKey: repositoriesKey,
    queryFn: () => http.get<RepositoryDto[]>('/admin/repositories'),
  });
}

export function useSetAuthorization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; authorized: boolean }) =>
      http.put<RepositoryDto>(`/admin/repositories/${input.id}/authorization`, {
        authorized: input.authorized,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: repositoriesKey }),
  });
}

export function useSyncRepositories() {
  return useMutation({
    mutationFn: () => http.post<{ queued: true }>('/admin/repositories/sync', {}),
  });
}

export function useAgentSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => http.get<AgentSettingsDto>('/admin/agent-settings'),
  });
}

export function useUpdateAgentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentSettingsInput) =>
      http.put<AgentSettingsDto>('/admin/agent-settings', input),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}

export const jobLogsKey = (jobId: string) => ['job-logs', jobId] as const;

export function fetchJobLogs(crId: string, jobId: string, after: number) {
  return http.get<JobLogPageDto>(`/change-requests/${crId}/jobs/${jobId}/logs?after=${after}`);
}
