import { Alert, Box, Loader, ScrollArea, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { fetchJobLogs, jobLogsKey } from '../admin/api';

const LEVEL_COLOR = { INFO: undefined, WARN: 'yellow.7', ERROR: 'red.7' } as const;

/**
 * Live log of one agent job (§13). Socket.IO `job.log` events invalidate the query; while the
 * job is running it also polls every 5 s in case the socket is down.
 */
export function JobLogViewer({
  crId,
  jobId,
  running,
}: {
  crId: string;
  jobId: string;
  running: boolean;
}) {
  const logs = useQuery({
    queryKey: jobLogsKey(jobId),
    queryFn: () => fetchJobLogs(crId, jobId, -1),
    refetchInterval: running ? 5_000 : false,
  });

  if (logs.isLoading) return <Loader size="xs" aria-label="Loading log" />;
  if (logs.error) return <Alert color="red">{logs.error.message}</Alert>;
  const lines = logs.data?.lines ?? [];
  if (lines.length === 0)
    return (
      <Text size="xs" c="dimmed">
        No log lines yet.
      </Text>
    );

  return (
    <ScrollArea.Autosize mah={360} type="auto">
      <Box
        component="pre"
        fz="xs"
        m={0}
        style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}
        aria-label="Job log"
      >
        {lines.map((l) => (
          <Text key={l.seq} component="div" fz="xs" ff="monospace" c={LEVEL_COLOR[l.level]}>
            {new Date(l.createdAt).toLocaleTimeString()} [{l.source}] {l.message}
          </Text>
        ))}
      </Box>
    </ScrollArea.Autosize>
  );
}
