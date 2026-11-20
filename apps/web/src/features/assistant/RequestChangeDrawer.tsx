import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  List,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  ASSISTANT_LIMITS,
  type AssistantStreamEvent,
  type ChangeRequestProposal,
  type Clarification,
  type ConversationDto,
} from '@evolvesales/shared';
import { IconSend, IconSparkles } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { ApiError, streamPost } from '../../lib/api';
import { useCurrentScreenContext } from '../../lib/screen-context';
import {
  assistantKeys,
  useAssistantStatus,
  useConversation,
  useStartConversation,
  useSubmitConversation,
} from './api';

const TOOL_LABELS: Record<string, string> = {
  propose_change_request: 'Updating the request summary…',
  ask_clarification: 'Preparing questions…',
};

interface Live {
  userText: string;
  text: string;
  tool: string | null;
}

/** Screen B: chat with the assistant, review the structured request, submit it. */
export function RequestChangeDrawer({
  opened,
  onClose,
  changeRequestId,
  onNewConversation,
}: {
  opened: boolean;
  onClose: () => void;
  changeRequestId?: string;
  onNewConversation: () => void;
}) {
  const { state } = useAuth();
  const qc = useQueryClient();
  const getScreenContext = useCurrentScreenContext();
  const status = useAssistantStatus(opened && state.status === 'authenticated');
  const start = useStartConversation();
  const submit = useSubmitConversation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversation = useConversation(conversationId);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [liveProposal, setLiveProposal] = useState<ChangeRequestProposal | null>(null);
  const [liveQuestions, setLiveQuestions] = useState<Clarification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [contextLabel, setContextLabel] = useState('');
  const started = useRef(false);

  // Start (or re-open) the conversation the first time the drawer opens.
  useEffect(() => {
    if (!opened || started.current) return;
    started.current = true;
    const screenContext = getScreenContext();
    setContextLabel(describeContext(screenContext));
    start.mutate(
      { screenContext, ...(changeRequestId && { changeRequestId }) },
      {
        onSuccess: (c) => setConversationId(c.id),
        onError: (e) => setError(e.message),
      },
    );
  }, [opened, changeRequestId, getScreenContext, start]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [live, conversation.data?.messages.length]);

  const c: ConversationDto | undefined = conversation.data;
  const proposal = liveProposal ?? c?.proposal ?? null;
  const questions = liveQuestions ?? c?.pendingClarification ?? null;
  const notConfigured = status.data?.configured === false;
  const isOpen = c?.status === 'OPEN';
  const remaining = ASSISTANT_LIMITS.maxUserMessages - (c?.userMessageCount ?? 0);
  const busy = live !== null;

  async function send() {
    const content = draft.trim();
    if (!content || !c || busy) return;
    setError(null);
    setDraft('');
    setLive({ userText: content, text: '', tool: null });
    abort.current = new AbortController();
    try {
      await streamPost<AssistantStreamEvent>(
        `/assistant/conversations/${c.id}/messages`,
        { content },
        (event) => {
          switch (event.type) {
            case 'text':
              setLive((l) => l && { ...l, text: l.text + event.delta, tool: null });
              break;
            case 'tool':
              setLive((l) => l && { ...l, tool: event.name });
              break;
            case 'proposal':
              setLiveProposal(event.proposal);
              setLiveQuestions(null);
              break;
            case 'clarification':
              setLiveQuestions(event.clarification);
              break;
            case 'error':
              setError(event.message);
              break;
            case 'done':
              break;
          }
        },
        abort.current.signal,
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof ApiError ? e.message : 'The assistant could not be reached.');
        setDraft(content);
      }
    } finally {
      await qc.invalidateQueries({ queryKey: assistantKeys.conversation(c.id) });
      setLive(null);
      setLiveProposal(null);
      setLiveQuestions(null);
    }
  }

  function doSubmit() {
    if (!c) return;
    setError(null);
    submit.mutate(c.id, { onError: (e) => setError(e.message) });
  }

  const submitted =
    submit.data ??
    (c?.changeRequestKey && !isOpen
      ? { changeRequestId: c.changeRequestId ?? '', key: c.changeRequestKey, status: '' }
      : null);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="xs">
          <IconSparkles size={18} />
          <Text fw={600}>Request a change</Text>
        </Group>
      }
    >
      <Stack gap="sm">
        {contextLabel && (
          <Badge variant="light" color="gray" style={{ textTransform: 'none' }}>
            Context: {contextLabel}
          </Badge>
        )}
        {notConfigured && (
          <Alert color="yellow" title="The AI assistant is not configured">
            An administrator needs to set the AI provider key on the server. Nothing you type can be
            answered until then.
          </Alert>
        )}
        {error && (
          <Alert color="red" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <ScrollArea.Autosize mah="45vh">
          <Stack gap="xs">
            {!c && start.isPending && <Loader size="sm" aria-label="Starting conversation" />}
            {c?.messages.length === 0 && !live && (
              <Text size="sm" c="dimmed">
                Describe what you would like to change in this screen, or ask a question about your
                invoices. I collect the requirements; an approver decides whether it gets built.
              </Text>
            )}
            {c?.messages.map((m) => (
              <Bubble key={m.id} role={m.role} text={m.content} />
            ))}
            {live && (
              <>
                <Bubble role="user" text={live.userText} />
                {live.text ? (
                  <Bubble role="assistant" text={live.text} />
                ) : (
                  <Group gap="xs">
                    <Loader size="xs" />
                    <Text size="xs" c="dimmed">
                      {live.tool
                        ? (TOOL_LABELS[live.tool] ?? 'Looking up your data…')
                        : 'Thinking…'}
                    </Text>
                  </Group>
                )}
              </>
            )}
            <div ref={bottom} />
          </Stack>
        </ScrollArea.Autosize>

        {questions && isOpen && (
          <Card withBorder padding="sm">
            <Text size="sm" fw={600}>
              The assistant needs to know
            </Text>
            <List size="sm">
              {questions.questions.map((q) => (
                <List.Item key={q}>{q}</List.Item>
              ))}
            </List>
          </Card>
        )}

        {proposal && <ProposalCard proposal={proposal} />}

        {submitted ? (
          <Alert color="teal" title={`Submitted as ${submitted.key}`}>
            <Text size="sm">
              It will be analysed and then reviewed by an approver. You will be notified as it moves
              on.
            </Text>
            <Group mt="xs">
              <Anchor
                component={RouterLink}
                to={`/requests/${submitted.changeRequestId}`}
                onClick={onClose}
              >
                Track {submitted.key}
              </Anchor>
              <Button size="xs" variant="light" onClick={onNewConversation}>
                Start a new request
              </Button>
            </Group>
          </Alert>
        ) : (
          proposal &&
          isOpen && (
            <Button onClick={doSubmit} loading={submit.isPending} disabled={busy}>
              Submit request
            </Button>
          )
        )}

        {isOpen && (
          <Box>
            <Textarea
              placeholder={notConfigured ? 'The assistant is not configured' : 'Type your message…'}
              aria-label="Message to the assistant"
              autosize
              minRows={2}
              maxRows={6}
              maxLength={ASSISTANT_LIMITS.maxMessageChars}
              value={draft}
              disabled={notConfigured || busy || remaining <= 0}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
              }}
            />
            <Group justify="space-between" mt={4}>
              <Text size="xs" c="dimmed">
                {remaining} message{remaining === 1 ? '' : 's'} left · Ctrl+Enter to send
              </Text>
              <Button
                size="xs"
                rightSection={<IconSend size={14} />}
                onClick={() => void send()}
                disabled={!draft.trim() || notConfigured || busy || remaining <= 0}
              >
                Send
              </Button>
            </Group>
          </Box>
        )}
      </Stack>
    </Drawer>
  );
}

function Bubble({ role, text }: { role: 'user' | 'assistant' | 'system'; text: string }) {
  if (role === 'system') {
    return (
      <Text size="xs" c="dimmed" ta="center" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </Text>
    );
  }
  if (!text) return null;
  const mine = role === 'user';
  return (
    <Paper
      p="xs"
      radius="md"
      bg={mine ? 'var(--mantine-color-indigo-light)' : 'var(--mantine-color-default-hover)'}
      ml={mine ? 'xl' : 0}
      mr={mine ? 0 : 'xl'}
      data-role={role}
    >
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </Text>
    </Paper>
  );
}

function ProposalCard({ proposal }: { proposal: ChangeRequestProposal }) {
  return (
    <Card withBorder padding="sm" aria-label="Request summary">
      <Group justify="space-between">
        <Text fw={600}>{proposal.title}</Text>
        <Badge variant="outline">{proposal.priority}</Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {proposal.category} · {proposal.screen}
      </Text>
      <Text size="sm" mt={4}>
        {proposal.description}
      </Text>
      <Text size="sm" fw={600} mt="xs">
        Acceptance criteria
      </Text>
      <List size="sm">
        {proposal.acceptanceCriteria.map((a) => (
          <List.Item key={a}>{a}</List.Item>
        ))}
      </List>
      {proposal.assumptions.length > 0 && (
        <>
          <Text size="sm" fw={600} mt="xs">
            Assumptions
          </Text>
          <List size="sm">
            {proposal.assumptions.map((a) => (
              <List.Item key={a}>{a}</List.Item>
            ))}
          </List>
        </>
      )}
    </Card>
  );
}

const SCREEN_LABELS: Record<string, string> = {
  'sales.invoices.list': 'Invoice list',
  'sales.invoices.editor': 'Invoice editor',
  'sales.invoices.details': 'Invoice details',
  'change-requests': 'Change requests',
  other: 'This page',
};

function describeContext(ctx: { screen: string; filters?: Record<string, string> }): string {
  const filters = Object.entries(ctx.filters ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${SCREEN_LABELS[ctx.screen] ?? ctx.screen}${filters ? ` (${filters})` : ''}`;
}
