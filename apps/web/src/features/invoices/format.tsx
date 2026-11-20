import { Badge } from '@mantine/core';
import type { InvoiceStatus } from '@evolvesales/shared';

const moneyFormat = new Intl.NumberFormat('en-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats a decimal string from the API. Display only — never used for calculation. */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return moneyFormat.format(Number(value));
}

export function formatPercent(fraction: string): string {
  return `${(Number(fraction) * 100).toLocaleString('en', { maximumFractionDigits: 2 })}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: iso.length === 10 ? 'UTC' : undefined,
  });
}

const STATUS: Record<InvoiceStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'gray' },
  CONFIRMED: { label: 'Confirmed', color: 'teal' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const s = STATUS[status];
  return (
    <Badge color={s.color} variant="light">
      {s.label}
    </Badge>
  );
}

export function todayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}
