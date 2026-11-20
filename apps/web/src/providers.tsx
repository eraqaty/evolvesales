import { MantineProvider } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from './auth/AuthProvider';
import { ApiError } from './lib/api';
import { RealtimeProvider } from './lib/realtime';
import { ScreenContextProvider } from './lib/screen-context';
import { theme } from './theme';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Don't retry client errors (validation, 404, permission); retry transient failures twice.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function Providers({
  children,
  queryClient,
  testEnv = false,
}: {
  children: ReactNode;
  queryClient: QueryClient;
  /** Disables Mantine transitions and portals so tests can see dropdown content. */
  testEnv?: boolean;
}) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto" env={testEnv ? 'test' : 'default'}>
      <DatesProvider settings={{ firstDayOfWeek: 6 }}>
        <Notifications position="top-right" />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RealtimeProvider>
              <ScreenContextProvider>{children}</ScreenContextProvider>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </DatesProvider>
    </MantineProvider>
  );
}
