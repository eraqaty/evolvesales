import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Indicator,
  Popover,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMarkNotificationRead, useNotifications } from '../features/change-requests/api';
import { formatDateTime } from '../features/change-requests/CrStatusBadge';

export function NotificationBell() {
  const [opened, setOpened] = useState(false);
  const { data } = useNotifications(true);
  const markRead = useMarkNotificationRead();
  const navigate = useNavigate();
  const unread = data?.unreadCount ?? 0;

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={340} withinPortal>
      <Popover.Target>
        <Indicator label={unread} size={16} disabled={unread === 0} offset={4}>
          <ActionIcon
            variant="subtle"
            size="lg"
            aria-label={`Notifications (${unread} unread)`}
            onClick={() => setOpened((o) => !o)}
          >
            <IconBell size={20} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Group justify="space-between" mb={4}>
          <Text fw={600} size="sm">
            Notifications
          </Text>
          {unread > 0 && (
            <Button size="compact-xs" variant="subtle" onClick={() => markRead.mutate('all')}>
              Mark all read
            </Button>
          )}
        </Group>
        <Divider mb={4} />
        <Stack gap={4} mah={360} style={{ overflowY: 'auto' }}>
          {data?.items.length === 0 && (
            <Text size="sm" c="dimmed">
              Nothing yet.
            </Text>
          )}
          {data?.items.map((n) => (
            <UnstyledButton
              key={n.id}
              p={6}
              style={{ borderRadius: 4, opacity: n.readAt ? 0.6 : 1 }}
              onClick={() => {
                if (!n.readAt) markRead.mutate({ id: n.id });
                setOpened(false);
                if (n.link) void navigate(n.link);
              }}
            >
              <Text size="sm" fw={n.readAt ? 400 : 600}>
                {n.title}
              </Text>
              <Text size="xs" c="dimmed" lineClamp={2}>
                {n.body}
              </Text>
              <Text size="xs" c="dimmed">
                {formatDateTime(n.createdAt)}
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
