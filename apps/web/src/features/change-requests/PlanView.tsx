import { Alert, Badge, Code, Group, List, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { implementationPlanSchema, planVerificationSchema } from '@evolvesales/shared';

const SEVERITY_COLOR = { low: 'gray', medium: 'yellow', high: 'red' } as const;

/** Readable implementation plan (§7, §8) for approvers; raw JSON if it doesn't parse. */
export function PlanView({ plan }: { plan: unknown }) {
  const parsed = implementationPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return (
      <Stack>
        <Alert color="yellow">
          This plan does not match the current plan format; showing it as stored.
        </Alert>
        <Code block>{JSON.stringify(plan, null, 2)}</Code>
      </Stack>
    );
  }
  const p = parsed.data;
  const verification =
    typeof plan === 'object' && plan !== null && 'verification' in plan
      ? planVerificationSchema.safeParse(plan.verification).data
      : undefined;

  return (
    <Stack gap="md">
      {p.blockingQuestions.length > 0 && (
        <Alert color="orange" title="The agent needs answers from the requester">
          <List size="sm">
            {p.blockingQuestions.map((q) => (
              <List.Item key={q}>{q}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Section title="Interpretation">
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {p.technicalInterpretation}
        </Text>
      </Section>
      <Section title="Proposed implementation">
        <List type="ordered" size="sm">
          {p.proposedImplementation.map((s) => (
            <List.Item key={s.step}>{s.description}</List.Item>
          ))}
        </List>
      </Section>
      <Section title={`Affected components (${p.affectedComponents.length})`}>
        {verification && verification.downgraded.length > 0 && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mb="xs">
            {verification.downgraded.length} finding(s) could not be verified against the repository
            and were downgraded to assumptions.
          </Alert>
        )}
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Path</Table.Th>
              <Table.Th>Layer</Table.Th>
              <Table.Th>Change</Table.Th>
              <Table.Th>Evidence</Table.Th>
              <Table.Th>Reason</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {p.affectedComponents.map((c) => (
              <Table.Tr key={`${c.path}-${c.change}`}>
                <Table.Td>
                  <Code>{c.path}</Code>
                </Table.Td>
                <Table.Td>{c.layer}</Table.Td>
                <Table.Td>{c.change}</Table.Td>
                <Table.Td>
                  {c.verified && c.evidence ? (
                    <Tooltip
                      multiline
                      w={420}
                      label={
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                          {c.evidence.excerpt}
                        </pre>
                      }
                    >
                      <Badge
                        color="green"
                        leftSection={<IconCircleCheck size={12} />}
                        variant="light"
                      >
                        L{c.evidence.startLine}-{c.evidence.endLine}
                      </Badge>
                    </Tooltip>
                  ) : (
                    <Tooltip multiline w={320} label={c.verificationNote ?? 'Not verified'}>
                      <Badge color="gray" variant="light">
                        unverified
                      </Badge>
                    </Tooltip>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{c.reason}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Section>
      <Section title="Database">
        {p.databaseChanges.required ? (
          <List size="sm">
            {p.databaseChanges.migrations.map((m) => (
              <List.Item key={m.name}>
                <b>{m.name}</b>{' '}
                {m.additive ? (
                  <Badge size="xs">additive</Badge>
                ) : (
                  <Badge size="xs" color="red">
                    not additive
                  </Badge>
                )}{' '}
                {m.description}
              </List.Item>
            ))}
          </List>
        ) : (
          <Text size="sm">No database changes.</Text>
        )}
        {p.databaseChanges.dataImpact && (
          <Text size="sm">Data impact: {p.databaseChanges.dataImpact}</Text>
        )}
      </Section>
      <Section title="New dependencies">
        {p.newDependencies.length === 0 ? (
          <Text size="sm">None.</Text>
        ) : (
          <List size="sm">
            {p.newDependencies.map((d) => (
              <List.Item key={d.name}>
                <Code>
                  {d.name}@{d.version}
                </Code>{' '}
                {d.justification}
              </List.Item>
            ))}
          </List>
        )}
      </Section>
      <Section title="Tests">
        <List size="sm">
          {p.testRequirements.map((t) => (
            <List.Item key={`${t.type}-${t.path}-${t.description}`}>
              <Badge size="xs" variant="light">
                {t.type}
              </Badge>{' '}
              {t.description} <Code>{t.path}</Code>
            </List.Item>
          ))}
        </List>
      </Section>
      <Section title="Risks">
        {p.risks.length === 0 ? (
          <Text size="sm">None identified.</Text>
        ) : (
          <List size="sm">
            {p.risks.map((r) => (
              <List.Item key={r.description}>
                <Badge size="xs" color={SEVERITY_COLOR[r.severity]}>
                  {r.severity} · {r.category}
                </Badge>{' '}
                {r.description}{' '}
                <Text span c="dimmed">
                  Mitigation: {r.mitigation}
                </Text>
              </List.Item>
            ))}
          </List>
        )}
      </Section>
      <Section title="Complexity">
        <Text size="sm">
          <b>{p.complexity.level}</b> · about {p.complexity.estimatedFilesChanged} files ·{' '}
          {p.complexity.rationale}
        </Text>
      </Section>
      <Section title="Acceptance criteria">
        <List size="sm">
          {p.acceptanceCriteria.map((a) => (
            <List.Item key={a}>{a}</List.Item>
          ))}
        </List>
      </Section>
      {p.assumptions.length > 0 && (
        <Section title="Assumptions">
          <List size="sm">
            {p.assumptions.map((a) => (
              <List.Item key={a}>{a}</List.Item>
            ))}
          </List>
        </Section>
      )}
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Group mb={4}>
        <Title order={5}>{title}</Title>
      </Group>
      {children}
    </div>
  );
}
