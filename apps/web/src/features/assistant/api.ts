import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDto, ScreenContext } from '@evolvesales/shared';
import { http } from '../../lib/api';

export interface AssistantStatus {
  configured: boolean;
  provider: string;
  model: string;
}

export interface SubmitResult {
  changeRequestId: string;
  key: string;
  status: string;
}

export const assistantKeys = {
  status: ['assistant', 'status'] as const,
  conversation: (id: string) => ['assistant', 'conversation', id] as const,
};

export function useAssistantStatus(enabled: boolean) {
  return useQuery({
    queryKey: assistantKeys.status,
    queryFn: () => http.get<AssistantStatus>('/assistant/status'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useStartConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { screenContext: ScreenContext; changeRequestId?: string }) =>
      http.post<ConversationDto>('/assistant/conversations', body),
    onSuccess: (c) => qc.setQueryData(assistantKeys.conversation(c.id), c),
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: assistantKeys.conversation(id ?? ''),
    queryFn: () => http.get<ConversationDto>(`/assistant/conversations/${id}`),
    enabled: !!id,
  });
}

export function useSubmitConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.post<SubmitResult>(`/assistant/conversations/${id}/submit`),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: assistantKeys.conversation(id) });
      void qc.invalidateQueries({ queryKey: ['change-requests'] });
    },
  });
}
