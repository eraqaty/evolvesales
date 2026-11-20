import {
  Alert,
  Button,
  Card,
  Group,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { INVOICE_STATUSES, type InvoiceStatus } from '@evolvesales/shared';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { usePermissions } from '../../auth/AuthProvider';
import { useCustomers, useInvoices } from './api';
import { formatDate, formatMoney, StatusBadge } from './format';

const PAGE_SIZE = 15;

export function InvoiceListPage() {
  const navigate = useNavigate();
  const { canCreateInvoice } = usePermissions();
  const [params, setParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');
  const [search] = useDebouncedValue(searchInput.trim(), 300);
  const statusParam = params.get('status');
  const status = INVOICE_STATUSES.find((s): s is InvoiceStatus => s === statusParam);
  const customerId = params.get('customerId') ?? undefined;
  const dateFrom = params.get('dateFrom') ?? undefined;
  const dateTo = params.get('dateTo') ?? undefined;
  const page = Number(params.get('page') ?? '1') || 1;

  const filters = useMemo(
    () => ({
      search: search || undefined,
      status,
      customerId,
      dateFrom,
      dateTo,
      page,
      pageSize: PAGE_SIZE,
    }),
    [search, status, customerId, dateFrom, dateTo, page],
  );
  const { data, isPending, isError, error, isFetching } = useInvoices(filters);
  const customers = useCustomers('');

  const setParam = (key: string, value: string | null | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Sales invoices</Title>
          <Text c="dimmed" size="sm">
            {data ? `${data.total} invoice${data.total === 1 ? '' : 's'}` : 'Loading…'}
          </Text>
        </div>
        <Group>
          {canCreateInvoice && (
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => void navigate('/invoices/new')}
            >
              New invoice
            </Button>
          )}
        </Group>
      </Group>

      <Card withBorder padding="sm">
        <Group grow align="flex-end" wrap="wrap">
          <TextInput
            label="Search"
            placeholder="Invoice number or customer"
            leftSection={<IconSearch size={16} />}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.currentTarget.value);
              setParam('search', e.currentTarget.value.trim() || null);
            }}
          />
          <Select
            label="Status"
            placeholder="All statuses"
            clearable
            data={INVOICE_STATUSES.map((s) => ({
              value: s,
              label: s[0] + s.slice(1).toLowerCase(),
            }))}
            value={status ?? null}
            onChange={(v) => setParam('status', v)}
          />
          <Select
            label="Customer"
            placeholder="All customers"
            clearable
            searchable
            data={(customers.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.name} (${c.code})`,
            }))}
            value={customerId ?? null}
            onChange={(v) => setParam('customerId', v)}
          />
          <DateInput
            label="From"
            placeholder="Any date"
            clearable
            valueFormat="DD MMM YYYY"
            value={dateFrom ?? null}
            onChange={(v) => setParam('dateFrom', v)}
          />
          <DateInput
            label="To"
            placeholder="Any date"
            clearable
            valueFormat="DD MMM YYYY"
            value={dateTo ?? null}
            onChange={(v) => setParam('dateTo', v)}
          />
        </Group>
      </Card>

      {isError && (
        <Alert color="red" title="Could not load invoices">
          {error.message}
        </Alert>
      )}

      <Card withBorder padding={0}>
        <Table.ScrollContainer minWidth={720}>
          <Table highlightOnHover verticalSpacing="sm" aria-busy={isFetching}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Number</Table.Th>
                <Table.Th>Issue date</Table.Th>
                <Table.Th>Customer</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {isPending &&
                Array.from({ length: 5 }, (_, i) => (
                  <Table.Tr key={i}>
                    <Table.Td colSpan={5}>
                      <Skeleton h={20} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              {data?.items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed" ta="center" py="lg">
                      No invoices match these filters.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {data?.items.map((inv) => (
                <Table.Tr
                  key={inv.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => void navigate(`/invoices/${inv.id}`)}
                >
                  <Table.Td fw={500}>{inv.number}</Table.Td>
                  <Table.Td>{formatDate(inv.issueDate)}</Table.Td>
                  <Table.Td>
                    {inv.customer.name}{' '}
                    <Text span c="dimmed" size="xs">
                      {inv.customer.code}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={inv.status} />
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatMoney(inv.grandTotal)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination
            total={totalPages}
            value={page}
            onChange={(p) => setParam('page', String(p))}
          />
        </Group>
      )}
    </Stack>
  );
}
