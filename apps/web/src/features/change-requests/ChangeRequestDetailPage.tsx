import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  Timeline,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ChangeRequestDetailDto } from '@evolvesales/shared';
import { IconArrowLeft, IconMessageQuestion } from '@tabler/icons-react';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { usePermissions } from '../../auth/AuthProvider';
import { useScreenContext } from '../../lib/screen-context';
import { useAssistant } from '../assistant/AssistantContext';
import { useApprove, useChangeRequest, useClarify, useReject, useRetry } from './api';
import { CrStatusBadge, formatDateTime } from './CrStatusBadge';

type Dialog = 'approve' | 'reject' | 'clarify' | 'retry' | null;

export function ChangeRequestDetailPage() {
  const { id } = useParams();
  const { data: cr, isLoading, error } = useChangeRequest(id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const assistant = useAssistant();

  useScreenContext({ screen: 'change-requests', ...(id && { selectedId: id }) });

  if (isLoading) return <Loader aria-label="Loading change request" />;
  if (error || !cr) {
    return <Alert color="red">{error?.message ?? 'Change request not found'}</Alert>;
  }

  const can = (a: ChangeRequestDetailDto['allowedActions'][number]) =>
    cr.allowedActions.includes(a);

  return (
    <Stack>
      <Anchor component={RouterLink} to="/requests" size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> Change requests
        </Group>
      </Anchor>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Title order={2}>{cr.key}</Title>
            <CrStatusBadge status={cr.status} />
            <Badge variant="outline">{cr.priority}</Badge>
          </Group>
          <Text size="lg">{cr.title}</Text>
          <Text size="sm" c="dimmed">
            Requested by {cr.requester.displayName} on {formatDateTime(cr.createdAt)}
          </Text>
        </div>
        <Group>
          {can('approve') && <Button onClick={() => setDialog('approve')}>Approve</Button>}
          {can('clarify') && (
            <Button variant="light" onClick={() => setDialog('clarify')}>
              Request clarification
            </Button>
          )}
          {can('reject') && (
            <Button variant="light" color="red" onClick={() => setDialog('reject')}>
              Reject
            </Button>
          )}
          {(can('retry-reanalyze') || can('retry-recode')) && (
            <Button variant="light" color="orange" onClick={() => setDialog('retry')}>
              Retry
            </Button>
          )}
        </Group>
      </Group>

      {cr.status === 'CLARIFICATION_REQUIRED' && cr.pendingQuestions.length > 0 && (
        <Alert color="orange" icon={<IconMessageQuestion />} title="Questions from the approver">
          <List size="sm">
            {cr.pendingQuestions.map((q) => (
              <List.Item key={q}>{q}</List.Item>
            ))}
          </List>
          {can('answer') && (
            <Button mt="sm" size="xs" onClick={() => assistant.open({ changeRequestId: cr.id })}>
              Answer in the assistant
            </Button>
          )}
        </Alert>
      )}
      {cr.status === 'FAILED' && (
        <Alert color="red" title="This request failed">
          {cr.transitions.at(-1)?.reason ?? 'No reason recorded.'}
        </Alert>
      )}
      {cr.status === 'APPROVED' && (
        <Alert color="teal">
          Approved. Approval authorizes the coding phase only; the change still goes through tests,
          a pull request review and a separate release approval.
        </Alert>
      )}

      <Tabs defaultValue="request">
        <Tabs.List>
          <Tabs.Tab value="request">Request</Tabs.Tab>
          <Tabs.Tab value="plan">Plan ({cr.plans.length})</Tabs.Tab>
          <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="request" pt="md">
          <RequestPanel cr={cr} />
        </Tabs.Panel>
        <Tabs.Panel value="plan" pt="md">
          <PlanPanel cr={cr} />
        </Tabs.Panel>
        <Tabs.Panel value="timeline" pt="md">
          <TimelinePanel cr={cr} />
        </Tabs.Panel>
      </Tabs>

      <DecisionDialog cr={cr} dialog={dialog} onClose={() => setDialog(null)} />
    </Stack>
  );
}

function RequestPanel({ cr }: { cr: ChangeRequestDetailDto }) {
  const s = cr.structured;
  const section = (title: string, items: string[]) =>
    items.length > 0 && (
      <div>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <List size="sm">
          {items.map((i) => (
            <List.Item key={i}>{i}</List.Item>
          ))}
        </List>
      </div>
    );
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Text size="sm">
          <b>Category:</b> {s.category} · <b>Screen:</b> {s.screen}
        </Text>
        <Text size="sm">{s.description}</Text>
        <Text size="sm" fs="italic">
          {s.userStory}
        </Text>
        {section('Acceptance criteria', s.acceptanceCriteria)}
        {section('Out of scope', s.outOfScope)}
        {section('Assumptions', s.assumptions)}
        <div>
          <Text fw={600} size="sm">
            Original request (the requester&apos;s own words)
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {cr.originalRequest}
          </Text>
        </div>
      </Stack>
    </Paper>
  );
}

function PlanPanel({ cr }: { cr: ChangeRequestDetailDto }) {
  const [version, setVersion] = useState<string | null>(null);
  if (cr.plans.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No implementation plan yet. Plans are written by the repository analysis agent; until it
        runs successfully this request cannot reach approval.
      </Text>
    );
  }
  const selected = cr.plans.find((p) => String(p.version) === version) ?? cr.plans[0];
  if (!selected) return null;
  return (
    <Stack>
      {cr.plans.length > 1 && (
        <SegmentedControl
          value={String(selected.version)}
          onChange={setVersion}
          data={cr.plans.map((p) => ({ value: String(p.version), label: `v${p.version}` }))}
        />
      )}
      <Text size="sm">
        Version {selected.version} · baseline {selected.baselineSha?.slice(0, 7) ?? 'unknown'} ·{' '}
        {selected.verifiedCount} verified / {selected.assumptionCount} assumptions · by{' '}
        {selected.agent ?? 'unknown agent'}
      </Text>
      <Code block>{JSON.stringify(selected.plan, null, 2)}</Code>
    </Stack>
  );
}

function TimelinePanel({ cr }: { cr: ChangeRequestDetailDto }) {
  return (
    <Stack>
      <Timeline bulletSize={18} lineWidth={2}>
        {cr.transitions.map((t) => (
          <Timeline.Item
            key={t.id}
            title={
              <Group gap="xs">
                <CrStatusBadge status={t.to} />
                <Text size="xs" c="dimmed">
                  {formatDateTime(t.createdAt)} · {t.actor?.displayName ?? 'System'}
                </Text>
              </Group>
            }
            color={t.to === 'FAILED' ? 'red' : undefined}
          >
            {t.reason && (
              <Text
                size="sm"
                c={t.to === 'FAILED' ? 'red' : undefined}
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {t.reason}
              </Text>
            )}
          </Timeline.Item>
        ))}
      </Timeline>
      {cr.jobs.length > 0 && (
        <>
          <Title order={5}>Agent jobs</Title>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Agent</Table.Th>
                <Table.Th>Started</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {cr.jobs.map((j) => (
                <Table.Tr key={j.id}>
                  <Table.Td>{j.type}</Table.Td>
                  <Table.Td>
                    <Badge color={j.status === 'FAILED' ? 'red' : 'gray'} variant="light">
                      {j.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{j.agentKind ?? '—'}</Table.Td>
                  <Table.Td>{j.startedAt ? formatDateTime(j.startedAt) : '—'}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="red">
                      {j.error}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
      {cr.decisions.length > 0 && (
        <>
          <Title order={5}>Approval decisions</Title>
          {cr.decisions.map((d) => (
            <Text key={d.id} size="sm">
              <b>{d.decision}</b> by {d.actor.displayName} on {formatDateTime(d.createdAt)}
              {d.planVersion !== null && ` (plan v${d.planVersion})`}
              {d.comment && `: ${d.comment}`}
              {d.overrideReason && ` · self-approval override: ${d.overrideReason}`}
            </Text>
          ))}
        </>
      )}
    </Stack>
  );
}

function DecisionDialog({
  cr,
  dialog,
  onClose,
}: {
  cr: ChangeRequestDetailDto;
  dialog: Dialog;
  onClose: () => void;
}) {
  const { userId } = usePermissions();
  const [text, setText] = useState('');
  const [override, setOverride] = useState('');
  const [retryMode, setRetryMode] = useState<'reanalyze' | 'recode'>('reanalyze');
  const approve = useApprove();
  const reject = useReject();
  const clarify = useClarify();
  const retry = useRetry();
  const isSelf = cr.requester.id === userId;

  const close = () => {
    setText('');
    setOverride('');
    onClose();
  };
  const done = (message: string) => () => {
    notifications.show({ color: 'teal', message });
    close();
  };
  const failed = (err: Error) => notifications.show({ color: 'red', message: err.message });

  const titles: Record<Exclude<Dialog, null>, string> = {
    approve: `Approve ${cr.key}`,
    reject: `Reject ${cr.key}`,
    clarify: `Ask ${cr.requester.displayName} for clarification`,
    retry: `Retry ${cr.key}`,
  };
  const pending = approve.isPending || reject.isPending || clarify.isPending || retry.isPending;

  return (
    <Modal opened={dialog !== null} onClose={close} title={dialog ? titles[dialog] : ''}>
      <Stack>
        {dialog === 'approve' && (
          <>
            <Text size="sm">
              Approving authorizes the coding phase only. It does not deploy anything.
            </Text>
            <Textarea
              label="Comment (optional)"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            {isSelf && (
              <Textarea
                label="Self-approval override reason"
                description="You requested this change. Admins may approve their own requests only with a reason; it is audited."
                required
                value={override}
                onChange={(e) => setOverride(e.currentTarget.value)}
              />
            )}
            <Button
              loading={pending}
              disabled={isSelf && !override.trim()}
              onClick={() =>
                approve.mutate(
                  {
                    id: cr.id,
                    comment: text.trim() || undefined,
                    overrideReason: override.trim() || undefined,
                  },
                  { onSuccess: done(`${cr.key} approved`), onError: failed },
                )
              }
            >
              Approve
            </Button>
          </>
        )}
        {dialog === 'reject' && (
          <>
            <Textarea
              label="Reason"
              required
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <Button
              color="red"
              loading={pending}
              disabled={!text.trim()}
              onClick={() =>
                reject.mutate(
                  { id: cr.id, comment: text.trim() },
                  { onSuccess: done(`${cr.key} rejected`), onError: failed },
                )
              }
            >
              Reject
            </Button>
          </>
        )}
        {dialog === 'clarify' && (
          <>
            <Textarea
              label="Questions (one per line)"
              required
              autosize
              minRows={3}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <Button
              loading={pending}
              disabled={!text.trim()}
              onClick={() =>
                clarify.mutate(
                  {
                    id: cr.id,
                    questions: text
                      .split('\n')
                      .map((q) => q.trim())
                      .filter(Boolean),
                  },
                  { onSuccess: done('Questions sent to the requester'), onError: failed },
                )
              }
            >
              Send questions
            </Button>
          </>
        )}
        {dialog === 'retry' && (
          <>
            <SegmentedControl
              value={retryMode}
              onChange={(v) => setRetryMode(v === 'recode' ? 'recode' : 'reanalyze')}
              data={[
                { value: 'reanalyze', label: 'Re-analyse from scratch' },
                {
                  value: 'recode',
                  label: 'Retry coding with the same plan',
                  disabled: !cr.allowedActions.includes('retry-recode'),
                },
              ]}
            />
            <Textarea
              label="Reason"
              required
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <Button
              loading={pending}
              disabled={!text.trim()}
              onClick={() =>
                retry.mutate(
                  { id: cr.id, mode: retryMode, reason: text.trim() },
                  { onSuccess: done(`${cr.key} queued again`), onError: failed },
                )
              }
            >
              Retry
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}
