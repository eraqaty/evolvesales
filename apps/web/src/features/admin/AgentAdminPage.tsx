import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBrandGithub, IconCoin, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import {
  AGENT_BUDGET_LIMITS,
  type AgentSettingsDto,
  updateAgentSettingsSchema,
} from '@evolvesales/shared';
import { usePermissions } from '../../auth/AuthProvider';
import {
  useAgentSettings,
  useRepositories,
  useSetAuthorization,
  useSyncRepositories,
  useUpdateAgentSettings,
} from './api';

/** Admin: which repository the agents may use (§11) and the agent spend caps (§0). */
export function AgentAdminPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Alert color="red">Only administrators can change agent settings.</Alert>;
  return (
    <Stack maw={900}>
      <Title order={2}>Agents</Title>
      <BudgetCard />
      <RepositoriesCard />
    </Stack>
  );
}

function BudgetCard() {
  const settings = useAgentSettings();
  return (
    <Card withBorder>
      <Group gap="xs" mb="xs">
        <IconCoin size={20} />
        <Title order={4}>Spend caps</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        There are no defaults: analysis jobs refuse to start until both caps are set. A job may
        spend up to the per-job cap, and it starts only if today&apos;s spend (UTC) plus that cap
        stays within the daily cap. Amounts are AI cost estimates in USD.
      </Text>
      {settings.isLoading && <Loader size="sm" aria-label="Loading settings" />}
      {settings.error && <Alert color="red">{settings.error.message}</Alert>}
      {settings.data && <BudgetForm settings={settings.data} />}
    </Card>
  );
}

function BudgetForm({ settings }: { settings: AgentSettingsDto }) {
  const [perJob, setPerJob] = useState(settings.analyzeMaxBudgetUsd ?? '');
  const [daily, setDaily] = useState(settings.dailyBudgetUsd ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useUpdateAgentSettings();
  const unset = settings.analyzeMaxBudgetUsd === null || settings.dailyBudgetUsd === null;

  const submit = () => {
    setSaved(false);
    const parsed = updateAgentSettingsSchema.safeParse({
      analyzeMaxBudgetUsd: perJob,
      dailyBudgetUsd: daily,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid amounts');
      return;
    }
    setError(null);
    update.mutate(parsed.data, {
      onSuccess: () => setSaved(true),
      onError: (e) => setError(e.message),
    });
  };

  return (
    <Stack gap="sm">
      {unset && (
        <Alert color="yellow" title="Caps not set">
          Analysis is blocked until an administrator sets both caps.
        </Alert>
      )}
      <Group align="end">
        <TextInput
          label="Per analysis job (USD)"
          description={`At most ${AGENT_BUDGET_LIMITS.perJobMaxUsd}`}
          value={perJob}
          onChange={(e) => setPerJob(e.currentTarget.value)}
          w={200}
        />
        <TextInput
          label="Per day, all jobs (USD)"
          description={`At most ${AGENT_BUDGET_LIMITS.dailyMaxUsd}`}
          value={daily}
          onChange={(e) => setDaily(e.currentTarget.value)}
          w={200}
        />
        <Button onClick={submit} loading={update.isPending}>
          Save caps
        </Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {saved && <Alert color="green">Caps saved.</Alert>}
      <Text size="sm">
        Spent today: <b>{settings.spentTodayUsd} USD</b>
        {settings.updatedBy && settings.updatedAt && (
          <Text span c="dimmed">
            {' '}
            · last changed by {settings.updatedBy.displayName} on{' '}
            {new Date(settings.updatedAt).toLocaleString()}
          </Text>
        )}
      </Text>
    </Stack>
  );
}

function RepositoriesCard() {
  const repos = useRepositories();
  const sync = useSyncRepositories();
  const setAuth = useSetAuthorization();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconBrandGithub size={20} />
          <Title order={4}>Repositories</Title>
        </Group>
        <Button
          variant="light"
          leftSection={<IconRefresh size={16} />}
          loading={sync.isPending}
          onClick={() => sync.mutate()}
        >
          Refresh from GitHub
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        Repositories the EvolveSales GitHub App is installed on. The agents work only on the one you
        authorize. The list is refreshed by the Orchestrator, which holds the App&apos;s key.
      </Text>
      {sync.isSuccess && (
        <Alert color="blue" mb="sm">
          Refresh requested. The list updates when the Orchestrator has synced (needs the GitHub App
          to be configured).
        </Alert>
      )}
      {error && (
        <Alert color="red" mb="sm" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {repos.isLoading && <Loader size="sm" aria-label="Loading repositories" />}
      {repos.error && <Alert color="red">{repos.error.message}</Alert>}
      {repos.data?.length === 0 && (
        <Text size="sm">
          No repositories yet. Create and install the GitHub App (docs/GITHUB_APP_SETUP.md),
          configure the Orchestrator, then press Refresh.
        </Text>
      )}
      {repos.data && repos.data.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Repository</Table.Th>
              <Table.Th>Branch</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {repos.data.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>
                  {r.fullName}{' '}
                  {r.isPrivate && (
                    <Badge size="xs" variant="light">
                      private
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>{r.defaultBranch}</Table.Td>
                <Table.Td>
                  {r.removedAt ? (
                    <Badge color="gray">App removed</Badge>
                  ) : r.isAuthorized ? (
                    <Badge color="green">
                      Authorized{r.authorizedBy ? ` by ${r.authorizedBy.displayName}` : ''}
                    </Badge>
                  ) : (
                    <Badge color="yellow" variant="light">
                      Not authorized
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {!r.removedAt && (
                    <Button
                      size="xs"
                      variant={r.isAuthorized ? 'default' : 'filled'}
                      color={r.isAuthorized ? 'red' : undefined}
                      loading={setAuth.isPending && setAuth.variables?.id === r.id}
                      onClick={() =>
                        setAuth.mutate(
                          { id: r.id, authorized: !r.isAuthorized },
                          { onError: (e) => setError(e.message) },
                        )
                      }
                    >
                      {r.isAuthorized ? 'Revoke' : 'Authorize'}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}
