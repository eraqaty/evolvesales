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
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons-react';
import { calculateInvoice, type InvoiceDetailDto } from '@evolvesales/shared';
import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { usePermissions } from '../../auth/AuthProvider';
import { ApiError } from '../../lib/api';
import { useScreenContext } from '../../lib/screen-context';
import {
  type InvoiceBody,
  type ProductOption,
  useConfirmInvoice,
  useCreateInvoice,
  useCustomers,
  useInvoice,
  useProducts,
  useUpdateInvoice,
} from './api';
import { formatMoney, formatPercent, todayIso } from './format';

interface LineState {
  key: string;
  productId: string | null;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  lineDiscountPct: number | string;
}

interface FormState {
  customerId: string | null;
  issueDate: string | null;
  dueDate: string | null;
  headerDiscountPct: number | string;
  notes: string;
  lines: LineState[];
}

let keySeq = 0;
const newKey = () => `line-${++keySeq}`;

const emptyLine = (): LineState => ({
  key: newKey(),
  productId: null,
  description: '',
  quantity: 1,
  unitPrice: '',
  lineDiscountPct: 0,
});

function fromInvoice(inv: InvoiceDetailDto): FormState {
  return {
    customerId: inv.customer.id,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    headerDiscountPct: Number(inv.headerDiscountPct),
    notes: inv.notes ?? '',
    lines: inv.items.map((i) => ({
      key: newKey(),
      productId: i.product.id,
      description: i.description ?? '',
      quantity: Number(i.quantity),
      unitPrice: i.unitPrice,
      lineDiscountPct: Number(i.lineDiscountPct),
    })),
  };
}

const num = (v: number | string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Route wrapper: loads the invoice for /invoices/:id/edit, or starts empty for /invoices/new. */
export function InvoiceEditorPage() {
  const { id } = useParams();
  const { canCreateInvoice } = usePermissions();
  const invoice = useInvoice(id);
  useScreenContext({
    screen: 'sales.invoices.editor',
    ...(invoice.data && { selectedId: invoice.data.number }),
  });

  if (!canCreateInvoice) return <Navigate to="/invoices" replace />;
  if (id && invoice.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (id && invoice.isError) {
    return <Alert color="red">Could not load invoice: {invoice.error.message}</Alert>;
  }
  if (invoice.data && invoice.data.status !== 'DRAFT') {
    return <Navigate to={`/invoices/${invoice.data.id}`} replace />;
  }
  return <InvoiceForm key={invoice.data?.id ?? 'new'} existing={invoice.data} />;
}

function InvoiceForm({ existing }: { existing?: InvoiceDetailDto }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() =>
    existing
      ? fromInvoice(existing)
      : {
          customerId: null,
          issueDate: todayIso(),
          dueDate: null,
          headerDiscountPct: 0,
          notes: '',
          lines: [emptyLine()],
        },
  );
  const [errors, setErrors] = useState<string[]>([]);

  const customers = useCustomers('');
  const products = useProducts('');
  const create = useCreateInvoice();
  const update = useUpdateInvoice();
  const confirm = useConfirmInvoice();
  const busy = create.isPending || update.isPending || confirm.isPending;

  const productById = useMemo(() => {
    const map = new Map<string, ProductOption>();
    for (const p of products.data ?? []) map.set(p.id, p);
    return map;
  }, [products.data]);

  const preview = useMemo(
    () =>
      calculateInvoice({
        headerDiscountPct: Math.min(100, Math.max(0, num(form.headerDiscountPct))),
        lines: form.lines.map((l) => ({
          quantity: Math.max(0, num(l.quantity)),
          unitPrice: Math.max(0, num(l.unitPrice)),
          lineDiscountPct: Math.min(100, Math.max(0, num(l.lineDiscountPct))),
          taxRate: (l.productId && productById.get(l.productId)?.taxRate) || 0,
        })),
      }),
    [form, productById],
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key: string, patch: Partial<LineState>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  function validate(): string[] {
    const problems: string[] = [];
    if (!form.customerId) problems.push('Select a customer.');
    if (!form.issueDate) problems.push('Choose an issue date.');
    if (form.dueDate && form.issueDate && form.dueDate < form.issueDate) {
      problems.push('Due date must be on or after the issue date.');
    }
    form.lines.forEach((l, i) => {
      if (!l.productId) problems.push(`Line ${i + 1}: select a product.`);
      if (!(num(l.quantity) > 0)) problems.push(`Line ${i + 1}: quantity must be greater than 0.`);
      if (l.unitPrice === '' || num(l.unitPrice) < 0)
        problems.push(`Line ${i + 1}: enter a unit price.`);
    });
    return problems;
  }

  function toBody(): InvoiceBody {
    return {
      customerId: form.customerId!,
      issueDate: form.issueDate!,
      dueDate: form.dueDate ?? undefined,
      headerDiscountPct: num(form.headerDiscountPct),
      notes: form.notes.trim() || undefined,
      items: form.lines.map((l) => ({
        productId: l.productId!,
        description: l.description.trim() || undefined,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice).toFixed(2),
        lineDiscountPct: num(l.lineDiscountPct),
      })),
    };
  }

  async function save(andConfirm: boolean) {
    const problems = validate();
    if (andConfirm && form.lines.length === 0)
      problems.push('Add at least one line before confirming.');
    setErrors(problems);
    if (problems.length > 0) return;

    try {
      const saved = existing
        ? await update.mutateAsync({
            id: existing.id,
            body: { ...toBody(), version: existing.version },
          })
        : await create.mutateAsync(toBody());
      const final = andConfirm
        ? await confirm.mutateAsync({ id: saved.id, version: saved.version })
        : saved;
      notifications.show({
        color: 'teal',
        message: `${final.number} ${andConfirm ? 'confirmed' : 'saved as draft'}.`,
      });
      void navigate(`/invoices/${final.id}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong.';
      setErrors([message]);
      if (err instanceof ApiError && err.status === 409) {
        notifications.show({ color: 'orange', title: 'Conflict', message });
      }
    }
  }

  return (
    <Stack maw={1200}>
      <Group justify="space-between">
        <Group gap="xs">
          <ActionIcon
            variant="subtle"
            aria-label="Back"
            onClick={() => void navigate(existing ? `/invoices/${existing.id}` : '/invoices')}
          >
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Title order={2}>{existing ? `Edit ${existing.number}` : 'New sales invoice'}</Title>
        </Group>
        <Group>
          <Button
            variant="default"
            onClick={() => void save(false)}
            loading={busy && !confirm.isPending}
          >
            Save draft
          </Button>
          <Button onClick={() => void save(true)} loading={confirm.isPending} disabled={busy}>
            Save &amp; confirm
          </Button>
        </Group>
      </Group>

      {errors.length > 0 && (
        <Alert color="red" title="Please fix the following" role="alert">
          <Stack gap={2}>
            {errors.map((e) => (
              <Text key={e} size="sm">
                {e}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Card withBorder>
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Select
              label="Customer"
              placeholder="Search customers"
              required
              searchable
              nothingFoundMessage="No active customers"
              data={(customers.data ?? []).map((c) => ({
                value: c.id,
                label: `${c.name} (${c.code})`,
              }))}
              value={form.customerId}
              onChange={(v) => set('customerId', v)}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 3 }}>
            <DateInput
              label="Issue date"
              required
              valueFormat="DD MMM YYYY"
              value={form.issueDate}
              onChange={(v) => set('issueDate', v)}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 3 }}>
            <DateInput
              label="Due date"
              clearable
              valueFormat="DD MMM YYYY"
              minDate={form.issueDate ?? undefined}
              value={form.dueDate}
              onChange={(v) => set('dueDate', v)}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Textarea
              label="Notes"
              autosize
              minRows={1}
              maxLength={2000}
              value={form.notes}
              onChange={(e) => set('notes', e.currentTarget.value)}
            />
          </Grid.Col>
        </Grid>
      </Card>

      <Card withBorder padding={0}>
        <Table.ScrollContainer minWidth={900}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>#</Table.Th>
                <Table.Th miw={240}>Product</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th w={110}>Qty</Table.Th>
                <Table.Th w={140}>Unit price</Table.Th>
                <Table.Th w={100}>Disc. %</Table.Th>
                <Table.Th w={80}>Tax</Table.Th>
                <Table.Th w={140} ta="right">
                  Line total
                </Table.Th>
                <Table.Th w={50} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {form.lines.map((line, index) => {
                const product = line.productId ? productById.get(line.productId) : undefined;
                return (
                  <Table.Tr key={line.key}>
                    <Table.Td>{index + 1}</Table.Td>
                    <Table.Td>
                      <Select
                        aria-label={`Line ${index + 1} product`}
                        placeholder="Select product"
                        searchable
                        data={(products.data ?? []).map((p) => ({
                          value: p.id,
                          label: `${p.name} (${p.sku})`,
                        }))}
                        value={line.productId}
                        onChange={(v) => {
                          const p = v ? productById.get(v) : undefined;
                          setLine(line.key, {
                            productId: v,
                            unitPrice: p ? p.unitPrice : line.unitPrice,
                          });
                        }}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Line ${index + 1} description`}
                        maxLength={500}
                        value={line.description}
                        onChange={(e) => setLine(line.key, { description: e.currentTarget.value })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <NumberInput
                        aria-label={`Line ${index + 1} quantity`}
                        min={0}
                        decimalScale={3}
                        value={line.quantity}
                        onChange={(v) => setLine(line.key, { quantity: v })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <NumberInput
                        aria-label={`Line ${index + 1} unit price`}
                        min={0}
                        decimalScale={2}
                        thousandSeparator=","
                        value={line.unitPrice}
                        onChange={(v) => setLine(line.key, { unitPrice: v })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <NumberInput
                        aria-label={`Line ${index + 1} discount percent`}
                        min={0}
                        max={100}
                        decimalScale={3}
                        value={line.lineDiscountPct}
                        onChange={(v) => setLine(line.key, { lineDiscountPct: v })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{product ? formatPercent(product.taxRate) : '—'}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatMoney(preview.lines[index]?.lineTotal)}
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Remove line">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Remove line ${index + 1}`}
                          onClick={() =>
                            set(
                              'lines',
                              form.lines.filter((l) => l.key !== line.key),
                            )
                          }
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group p="sm">
          <Button
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={() => set('lines', [...form.lines, emptyLine()])}
          >
            Add line
          </Button>
        </Group>
      </Card>

      <Group justify="flex-end" align="flex-start">
        <Card withBorder w={360} maw="100%">
          <Stack gap={6}>
            <NumberInput
              label="Invoice discount %"
              description="Applied after line discounts, before tax"
              min={0}
              max={100}
              decimalScale={3}
              value={form.headerDiscountPct}
              onChange={(v) => set('headerDiscountPct', v)}
            />
            <Divider my={4} />
            <TotalRow label="Subtotal" value={preview.subtotal} />
            <TotalRow label="Discounts" value={`-${preview.discountTotal}`} />
            <TotalRow label="Taxable amount" value={preview.taxableTotal} />
            <TotalRow label="Tax" value={preview.taxTotal} />
            <Divider my={4} />
            <TotalRow label="Total (EGP)" value={preview.grandTotal} strong />
            <Text size="xs" c="dimmed">
              Preview — the server recalculates and stores the final amounts.
            </Text>
          </Stack>
        </Card>
      </Group>
    </Stack>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Group justify="space-between">
      <Text size="sm" fw={strong ? 700 : 400}>
        {label}
      </Text>
      <Text size="sm" ff="monospace" fw={strong ? 700 : 400} data-testid={`total-${label}`}>
        {formatMoney(value)}
      </Text>
    </Group>
  );
}
