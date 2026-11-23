import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth/AuthProvider';
import { getAccessToken, refreshSession } from './api';

export const SOCKET_PATH = '/api/v1/socket.io';

/**
 * Live updates: while signed in, keeps a Socket.IO connection and refreshes the affected
 * queries when the server reports a change. The server pushes only ids, never business data.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const userId = state.user?.id ?? null;

  useEffect(() => {
    if (!userId || import.meta.env.MODE === 'test') return;
    const socket = io({
      path: SOCKET_PATH,
      transports: ['websocket'],
      // Called on every (re)connect, so an expired token is replaced by a fresh one.
      auth: (cb) => {
        const token = getAccessToken();
        if (token) cb({ token });
        else void refreshSession().then((s) => cb({ token: s?.accessToken ?? '' }));
      },
    });
    socket.on('cr.updated', (event: { changeRequestId?: string }) => {
      void queryClient.invalidateQueries({ queryKey: ['change-requests', 'list'] });
      if (event.changeRequestId) {
        void queryClient.invalidateQueries({
          queryKey: ['change-requests', 'detail', event.changeRequestId],
        });
      }
    });
    socket.on('job.log', (event: { jobId?: string }) => {
      if (event.jobId) void queryClient.invalidateQueries({ queryKey: ['job-logs', event.jobId] });
    });
    socket.on('repos.updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'repositories'] });
    });
    socket.on('notification', () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
    socket.on('unauthorized', () => {
      void refreshSession();
    });
    return () => {
      socket.disconnect();
    };
  }, [userId, queryClient]);

  return children;
}
