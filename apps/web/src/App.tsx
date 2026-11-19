import { AppShell, Badge, Container, Group, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

type ApiState = 'checking' | 'online' | 'offline';

export function App() {
  const [apiState, setApiState] = useState<ApiState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/health', { signal: controller.signal })
      .then((res) => setApiState(res.ok ? 'online' : 'offline'))
      .catch(() => {
        if (!controller.signal.aborted) setApiState('offline');
      });
    return () => controller.abort();
  }, []);

  const badgeColor = apiState === 'online' ? 'teal' : apiState === 'offline' ? 'red' : 'gray';

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={3}>EvolveSales</Title>
          <Badge color={badgeColor} variant="light" aria-label="API status">
            API {apiState}
          </Badge>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Container size="lg">
          <Stack gap="xs">
            <Title order={2}>Sales Invoices</Title>
            <Text c="dimmed">The invoice management screen is built in Phase 1.</Text>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
