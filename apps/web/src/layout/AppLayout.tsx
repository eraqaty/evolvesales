import {
  AppShell,
  Avatar,
  Badge,
  Center,
  Group,
  Loader,
  Menu,
  NavLink,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconFileInvoice, IconLogout } from '@tabler/icons-react';
import { Navigate, Outlet, Link as RouterLink, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';

const ROLE_LABELS: Record<string, string> = {
  SALES_USER: 'Sales',
  SALES_MANAGER: 'Sales manager',
  CHANGE_APPROVER: 'Change approver',
  RELEASE_MANAGER: 'Release manager',
  ADMIN: 'Admin',
};

/** Authenticated shell: redirects to /login when there is no session. */
export function AppLayout() {
  const { state, logout } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <Center mih="100vh">
        <Loader aria-label="Loading session" />
      </Center>
    );
  }
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  const user = state.user;
  const initials = user.displayName
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: true } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={3}>EvolveSales</Title>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <UnstyledButton aria-label="Account menu">
                <Group gap="xs">
                  <Avatar radius="xl" size="sm" color="indigo">
                    {initials}
                  </Avatar>
                  <div>
                    <Text size="sm" fw={500} lh={1.1}>
                      {user.displayName}
                    </Text>
                    <Text size="xs" c="dimmed" lh={1.1}>
                      {user.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void logout()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <NavLink
          component={RouterLink}
          to="/invoices"
          label="Sales invoices"
          leftSection={<IconFileInvoice size={18} />}
          active={location.pathname.startsWith('/invoices')}
        />
        <Badge variant="light" color="gray" mt="auto" size="xs">
          {import.meta.env.MODE}
        </Badge>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
