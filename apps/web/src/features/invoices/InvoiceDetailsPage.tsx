import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Grid,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconCheck, IconEdit, IconX } from '@tabler/icons-react';
import type { InvoiceDetailDto } from '@evolvesales/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { usePermissions } from '../../auth/AuthProvider';
import { ApiError } from '../../lib/api';
import { useScreenContext } from '../../lib/screen-context';
import { useCancelInvoice, useConfirmInvoice, useInvoice } from './api';
import { formatDate, formatMoney, formatPercent, StatusBadge } from './format';

export function InvoiceDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: inv, isPending, isError, error } = useInvoice(id);
  useScreenContext({
    screen: 'sales.invoices.details',
    ...(inv && { selectedId: inv.number, filters: { status: inv.status } }),
  });

  if (isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (isError) {
    return (
      <Alert color="red" title="Could not load invoice">
        {error instanceof ApiError && error.status === 404
          ? 'This invoice does not exist.'
          : error.message}
      </Alert>
    );
  }

  return (
    <Stack maw={1100}>
      <Group justify="space-between">
        <Group gap="xs">
          <ActionIcon
            variant="subtle"
            aria-label="Back to invoices"
            onClick={() => void navigate('/invoices')}
          >
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Title order={2}>{inv.number}</Title>
          <StatusBadge status={inv.status} />
        </Group>
        <InvoiceActions invoice={inv} />
      </Group>

      {inv.status === 'CANCELLED' && (
        <Alert color="red" variant="light" title="Cancelled">
          Cancelled by {inv.cancelledBy?.displayName ?? 'unknown'} on {formatDate(inv.cancelledAt)}
          {inv.cancelReason ? ` — ${inv.cancelReason}` : ''}
        </Alert>
      )}

      <Card withBorder>
        <Grid>
          <Field label="Customer" value={`${inv.customer.name} (${inv.customer.code})`} />
          <Field label="Issue date" value={formatDate(inv.issueDate)} />
          <Field label="Due date" value={formatDate(inv.dueDate)} />
          <Field label="Currency" value={inv.currency} />
          <Field label="Created by" value={inv.createdBy.displayName} />
          <Field
            label="Confirmed"
            value={
              inv.confirmedAt
                ? `${formatDate(inv.confirmedAt)} by ${inv.confirmedBy?.displayName ?? '—'}`
                : '—'
            }
          />
          {inv.notes && <Field label="Notes" value={inv.notes} span={12} />}
        </Grid>
      </Card>

      <Card withBorder padding={0}>
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Product</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Unit price</Table.Th>
                <Table.Th ta="right">Discount</Table.Th>
                <Table.Th ta="right">Tax</Table.Th>
                <Table.Th ta="right">Line total</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {inv.items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed" ta="center">
                      No items yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {inv.items.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.lineNo}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{item.product.name}</Text>
                    <Text size="xs" c="dimmed">
                      {item.product.sku}
                      {item.description ? ` · ${item.description}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    {Number(item.quantity).toLocaleString('en')} {item.product.unit}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatMoney(item.unitPrice)}
                  </Table.Td>
                  <Table.Td ta="right">
                    {Number(item.lineDiscountPct) > 0 ? `${Number(item.lineDiscountPct)}%` : '—'}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" ff="monospace">
                      {formatMoney(item.taxAmount)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatPercent(item.taxRate)}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={500}>
                    {formatMoney(item.lineTotal)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Group justify="flex-end">
        <Card withBorder w={340} maw="100%">
          <Stack gap={6}>
            <Row label="Subtotal" value={formatMoney(inv.subtotal)} />
            <Row
              label={`Discounts${Number(inv.headerDiscountPct) > 0 ? ` (incl. ${Number(inv.headerDiscountPct)}% invoice)` : ''}`}
              value={`-${formatMoney(inv.discountTotal)}`}
            />
            <Row label="Taxable amount" value={formatMoney(inv.taxableTotal)} />
            <Row label="Tax" value={formatMoney(inv.taxTotal)} />
            <Divider />
            <Row label="Total" value={formatMoney(inv.grandTotal)} strong />
          </Stack>
        </Card>
      </Group>
    </Stack>
  );
}

function InvoiceActions({ invoice }: { invoice: InvoiceDetailDto }) {
  const navigate = useNavigate();
  const { userId, isSales, isSalesManager } = usePermissions();
  const confirm = useConfirmInvoice();
  const cancel = useCancelInvoice();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const isDraft = invoice.status === 'DRAFT';
  const isOwner = invoice.createdBy.id === userId;
  const canEdit = isDraft && (isSalesManager || (isSales && isOwner));
  const canConfirm = isDraft && isSales;
  const canCancel =
    (isDraft && (isSalesManager || (isSales && isOwner))) ||
    (invoice.status === 'CONFIRMED' && isSalesManager);
  const reasonRequired = invoice.status === 'CONFIRMED';

  async function doConfirm() {
    try {
      await confirm.mutateAsync({ id: invoice.id, version: invoice.version });
      notifications.show({ color: 'teal', message: `${invoice.number} confirmed.` });
    } catch (err) {
      onError(err);
    }
  }

  async function doCancel() {
    if (reasonRequired && reason.trim().length < 3) {
      setCancelError('Please give a reason (at least 3 characters).');
      return;
    }
    try {
      await cancel.mutateAsync({
        id: invoice.id,
        version: invoice.version,
        reason: reason.trim() || undefined,
      });
      setCancelOpen(false);
      notifications.show({ color: 'teal', message: `${invoice.number} cancelled.` });
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'Cancel failed');
    }
  }

  return (
    <Group>
      {canEdit && (
        <Button
          variant="default"
          leftSection={<IconEdit size={16} />}
          onClick={() => void navigate(`/invoices/${invoice.id}/edit`)}
        >
          Edit
        </Button>
      )}
      {canConfirm && (
        <Button
          leftSection={<IconCheck size={16} />}
          onClick={() => void doConfirm()}
          loading={confirm.isPending}
          disabled={invoice.items.length === 0}
          title={invoice.items.length === 0 ? 'Add at least one item first' : undefined}
        >
          Confirm
        </Button>
      )}
      {canCancel && (
        <Button
          color="red"
          variant="light"
          leftSection={<IconX size={16} />}
          onClick={() => setCancelOpen(true)}
        >
          Cancel invoice
        </Button>
      )}

      <Modal
        opened={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel ${invoice.number}?`}
      >
        <Stack>
          <Text size="sm">
            {reasonRequired
              ? 'This invoice is confirmed. Cancelling it is permanent and requires a reason.'
              : 'This draft will be cancelled permanently.'}
          </Text>
          <Textarea
            label="Reason"
            required={reasonRequired}
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.currentTarget.value);
              setCancelError(null);
            }}
            error={cancelError}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCancelOpen(false)}>
              Keep invoice
            </Button>
            <Button color="red" onClick={() => void doCancel()} loading={cancel.isPending}>
              Cancel invoice
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Group>
  );
}

function onError(err: unknown): void {
  notifications.show({
    color: 'red',
    message: err instanceof ApiError ? err.message : 'Action failed',
  });
}

function Field({ label, value, span = 4 }: { label: string; value: string; span?: number }) {
  return (
    <Grid.Col span={{ base: 12, sm: 6, md: span }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </Grid.Col>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Group justify="space-between">
      <Text size="sm" fw={strong ? 700 : 400}>
        {label}
      </Text>
      <Text size="sm" ff="monospace" fw={strong ? 700 : 400}>
        {value}
      </Text>
    </Group>
  );
}
