import {
  Alert,
  Anchor,
  Group,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CR_STATUS_LABELS, CR_STATUSES, type CrStatus, isCrStatus } from '@evolvesales/shared';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { usePermissions } from '../../auth/AuthProvider';
import { useScreenContext } from '../../lib/screen-context';
import { useChangeRequests } from './api';
import { CrStatusBadge, formatDateTime } from './CrStatusBadge';

const STATUS_OPTIONS = CR_STATUSES.map((s) => ({ value: s, label: CR_STATUS_LABELS[s] }));

/**
 * Screen D list ("Change requests") and Screen C list ("Approvals": defaults to requests
 * awaiting approval). The API decides which requests the user may see.
 */
export function ChangeRequestListPage({ mode }: { mode: 'requests' | 'approvals' }) {
  const { seesAllRequests } = usePermissions();
  const [status, setStatus] = useState<CrStatus | null>(
    mode === 'approvals' ? 'AWAITING_APPROVAL' : null,
  );
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useScreenContext({
    screen: 'change-requests',
    filters: { ...(status && { status }), ...(debounced && { search: debounced }) },
  });

  const { data, isLoading, error } = useChangeRequests({
    status: status ?? undefined,
    search: debounced || undefined,
    page,
    pageSize,
  });

  const title =
    mode === 'approvals' ? 'Approvals' : seesAllRequests ? 'Change requests' : 'My change requests';

  return (
    <Stack>
      <Title order={2}>{title}</Title>
      <Group>
        <TextInput
          placeholder="Search key or title"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          aria-label="Search change requests"
        />
        <Select
          placeholder="Any status"
          data={STATUS_OPTIONS}
          value={status}
          onChange={(v) => {
            setStatus(isCrStatus(v) ? v : null);
            setPage(1);
          }}
          clearable
          aria-label="Status filter"
        />
      </Group>
      {error && <Alert color="red">{error.message}</Alert>}
      <Paper withBorder>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Key</Table.Th>
              <Table.Th>Title</Table.Th>
              <Table.Th>Requester</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Priority</Table.Th>
              <Table.Th>Updated</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data?.items.map((cr) => (
              <Table.Tr key={cr.id}>
                <Table.Td>
                  <Anchor component={RouterLink} to={`/requests/${cr.id}`}>
                    {cr.key}
                  </Anchor>
                </Table.Td>
                <Table.Td>{cr.title}</Table.Td>
                <Table.Td>{cr.requester.displayName}</Table.Td>
                <Table.Td>
                  <CrStatusBadge status={cr.status} />
                </Table.Td>
                <Table.Td>{cr.priority}</Table.Td>
                <Table.Td>{formatDateTime(cr.updatedAt)}</Table.Td>
              </Table.Tr>
            ))}
            {!isLoading && data?.items.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text c="dimmed" ta="center" py="md">
                    {mode === 'approvals'
                      ? 'Nothing is waiting for approval.'
                      : 'No change requests yet. Use "Request a change" to describe one.'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Paper>
      {data && data.total > pageSize && (
        <Pagination total={Math.ceil(data.total / pageSize)} value={page} onChange={setPage} />
      )}
    </Stack>
  );
}
