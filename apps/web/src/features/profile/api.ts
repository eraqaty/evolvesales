import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LinkPhoneResult,
  NotificationPrefs,
  SetApprovalPinInput,
  WhatsAppProfileDto,
} from '@evolvesales/shared';
import { http } from '../../lib/api';

const key = ['profile', 'whatsapp'] as const;

export function useWhatsAppProfile() {
  return useQuery({
    queryKey: key,
    queryFn: () => http.get<WhatsAppProfileDto>('/profile/whatsapp'),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: key });
}

export function useStartLink() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (phone: string) => http.post<LinkPhoneResult>('/profile/whatsapp/link', { phone }),
    onSuccess: invalidate,
  });
}

export function useUnlink() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => http.delete<void>('/profile/whatsapp'),
    onSuccess: invalidate,
  });
}

export function useSetPin() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SetApprovalPinInput) => http.put<void>('/profile/approval-pin', input),
    onSuccess: invalidate,
  });
}

export function useSetPrefs() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (prefs: NotificationPrefs) =>
      http.put<NotificationPrefs>('/profile/notification-prefs', prefs),
    onSuccess: invalidate,
  });
}
