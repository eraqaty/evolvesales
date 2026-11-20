import { Badge, type MantineColor } from '@mantine/core';
import { CR_STATUS_LABELS, type CrStatus } from '@evolvesales/shared';

const COLORS: Record<CrStatus, MantineColor> = {
  SUBMITTED: 'blue',
  ANALYZING: 'cyan',
  AWAITING_APPROVAL: 'yellow',
  CLARIFICATION_REQUIRED: 'orange',
  APPROVED: 'teal',
  REJECTED: 'gray',
  CODING: 'violet',
  TESTING: 'violet',
  PULL_REQUEST_CREATED: 'indigo',
  REVIEW: 'indigo',
  STAGING: 'grape',
  PRODUCTION_APPROVAL: 'grape',
  RELEASED: 'green',
  FAILED: 'red',
};

export function CrStatusBadge({ status }: { status: CrStatus }) {
  return (
    <Badge color={COLORS[status]} variant="light">
      {CR_STATUS_LABELS[status]}
    </Badge>
  );
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
