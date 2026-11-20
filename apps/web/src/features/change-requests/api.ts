import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangeRequestDetailDto,
  ChangeRequestSummaryDto,
  CrStatus,
  NotificationDto,
  Page,
} from '@evolvesales/shared';
import { http, toQuery } from '../../lib/api';

export interface ChangeRequestFilters {
  status?: CrStatus;
  search?: string;
  mine?: boolean;
  page: number;
  pageSize: number;
}

export const crKeys = {
  list: (f: ChangeRequestFilters) => ['change-requests', 'list', f] as const,
  detail: (id: string) => ['change-requests', 'detail', id] as const,
};

export function useChangeRequests(filters: ChangeRequestFilters) {
  return useQuery({
    queryKey: crKeys.list(filters),
    queryFn: () =>
      http.get<Page<ChangeRequestSummaryDto>>(
        `/change-requests${toQuery({ ...filters, mine: filters.mine ? 'true' : undefined })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useChangeRequest(id: string | undefined) {
  return useQuery({
    queryKey: crKeys.detail(id ?? ''),
    queryFn: () => http.get<ChangeRequestDetailDto>(`/change-requests/${id}`),
    enabled: !!id,
  });
}

function useCrAction<TVars>(path: string, toBody: (vars: TVars) => object) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars & { id: string }) =>
      http.post<ChangeRequestDetailDto>(`/change-requests/${vars.id}/${path}`, toBody(vars)),
    onSuccess: (cr) => {
      qc.setQueryData(crKeys.detail(cr.id), cr);
      void qc.invalidateQueries({ queryKey: ['change-requests', 'list'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export const useApprove = () =>
  useCrAction('approve', (v: { comment?: string; overrideReason?: string }) => ({
    comment: v.comment,
    overrideReason: v.overrideReason,
  }));
export const useReject = () =>
  useCrAction('reject', (v: { comment: string }) => ({ comment: v.comment }));
export const useClarify = () =>
  useCrAction('clarify', (v: { questions: string[] }) => ({ questions: v.questions }));
export const useRetry = () =>
  useCrAction('retry', (v: { mode: 'reanalyze' | 'recode'; reason: string }) => ({
    mode: v.mode,
    reason: v.reason,
  }));

export interface NotificationList {
  items: NotificationDto[];
  unreadCount: number;
}

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => http.get<NotificationList>('/notifications'),
    enabled,
    // Socket.IO pushes refreshes; poll slowly as a fallback.
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { id: string } | 'all') =>
      target === 'all'
        ? http.post<void>('/notifications/read-all')
        : http.post<void>(`/notifications/${target.id}/read`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
