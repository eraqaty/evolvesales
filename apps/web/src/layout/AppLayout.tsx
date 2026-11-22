import {
  AppShell,
  Avatar,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  NavLink,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChecklist,
  IconFileInvoice,
  IconGitPullRequest,
  IconLogout,
  IconRobot,
  IconSparkles,
  IconUserCircle,
} from '@tabler/icons-react';
import { Navigate, Outlet, Link as RouterLink, useLocation } from 'react-router';
import { useAuth, usePermissions } from '../auth/AuthProvider';
import { AssistantProvider, useAssistant } from '../features/assistant/AssistantContext';
import { NotificationBell } from './NotificationBell';

const ROLE_LABELS: Record<string, string> = {
  SALES_USER: 'Sales',
  SALES_MANAGER: 'Sales manager',
  CHANGE_APPROVER: 'Change approver',
  RELEASE_MANAGER: 'Release manager',
  ADMIN: 'Admin',
};

/** Authenticated shell: redirects to /login when there is no session. */
export function AppLayout() {
  const { state } = useAuth();
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

  return (
    <AssistantProvider>
      <Shell />
    </AssistantProvider>
  );
}

function RequestChangeButton() {
  const assistant = useAssistant();
  return (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconSparkles size={16} />}
      onClick={() => assistant.open()}
    >
      Request a change
    </Button>
  );
}

function Shell() {
  const { state, logout } = useAuth();
  const { isApprover, isAdmin } = usePermissions();
  const location = useLocation();
  if (!state.user) return null;
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
          <Group gap="sm">
            <RequestChangeButton />
            <NotificationBell />
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
                <Menu.Item
                  component={RouterLink}
                  to="/profile"
                  leftSection={<IconUserCircle size={16} />}
                >
                  Profile and WhatsApp
                </Menu.Item>
                <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void logout()}>
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
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
        <NavLink
          component={RouterLink}
          to="/requests"
          label="Change requests"
          leftSection={<IconGitPullRequest size={18} />}
          active={location.pathname.startsWith('/requests')}
        />
        {isApprover && (
          <NavLink
            component={RouterLink}
            to="/approvals"
            label="Approvals"
            leftSection={<IconChecklist size={18} />}
            active={location.pathname.startsWith('/approvals')}
          />
        )}
        {isAdmin && (
          <NavLink
            component={RouterLink}
            to="/admin/agents"
            label="Agents"
            leftSection={<IconRobot size={18} />}
            active={location.pathname.startsWith('/admin')}
          />
        )}
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
