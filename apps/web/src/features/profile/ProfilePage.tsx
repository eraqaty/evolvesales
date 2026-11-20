import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBrandWhatsapp, IconLock } from '@tabler/icons-react';
import { useState } from 'react';
import {
  e164Schema,
  type LinkPhoneResult,
  type NotificationPrefs,
  type WhatsAppProfileDto,
} from '@evolvesales/shared';
import { useAuth } from '../../auth/AuthProvider';
import { useSetPin, useSetPrefs, useStartLink, useUnlink, useWhatsAppProfile } from './api';

/** The signed-in user's own settings: WhatsApp link, approval PIN, notifications (§19.3, §19.5). */
export function ProfilePage() {
  const { state } = useAuth();
  const profile = useWhatsAppProfile();

  return (
    <Stack maw={640}>
      <Title order={2}>Profile</Title>
      {state.user && (
        <Text c="dimmed">
          {state.user.displayName} · {state.user.email}
        </Text>
      )}
      {profile.isLoading && <Loader aria-label="Loading profile" />}
      {profile.error && <Alert color="red">{profile.error.message}</Alert>}
      {profile.data && (
        <>
          <WhatsAppCard profile={profile.data} />
          {profile.data.canApprove && <PinCard profile={profile.data} />}
          {profile.data.phone && <PrefsCard prefs={profile.data.prefs} />}
        </>
      )}
    </Stack>
  );
}

function WhatsAppCard({ profile }: { profile: WhatsAppProfileDto }) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<LinkPhoneResult | null>(null);
  const start = useStartLink();
  const unlink = useUnlink();

  const submit = () => {
    const parsed = e164Schema.safeParse(phone);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid number');
      return;
    }
    setError(null);
    start.mutate(parsed.data, { onSuccess: setIssued });
  };

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          <IconBrandWhatsapp size={20} />
          <Title order={4}>WhatsApp</Title>
        </Group>
        {profile.phone ? (
          <Badge color="green">Linked</Badge>
        ) : (
          <Badge color="gray">Not linked</Badge>
        )}
      </Group>

      {!profile.enabled && (
        <Alert color="yellow" mb="sm">
          WhatsApp is not enabled on this server yet.
        </Alert>
      )}

      {profile.phone ? (
        <Stack gap="xs">
          <Text>
            Linked number: <b>{profile.phone}</b>
          </Text>
          <Text size="sm" c="dimmed">
            Message the bot to ask about invoices or request a change. Send <Code>help</Code> for
            the commands.
          </Text>
          <Group>
            <Button
              variant="light"
              color="red"
              loading={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              Unlink
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text size="sm">
            Link your number to use the assistant and receive notifications on WhatsApp.
          </Text>
          <Group align="flex-end">
            <TextInput
              label="Your WhatsApp number"
              placeholder="+201001234567"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
              error={error}
              disabled={!profile.enabled}
            />
            <Button onClick={submit} loading={start.isPending} disabled={!profile.enabled}>
              Get link code
            </Button>
          </Group>
          {start.error && <Alert color="red">{start.error.message}</Alert>}
          {issued && (
            <Alert color="blue" title="Send this code from your phone">
              <Stack gap={4}>
                <Text>
                  Send <Code fz="md">LINK {issued.code}</Code> to{' '}
                  <b>{issued.botNumber ?? 'the EvolveSales WhatsApp number'}</b> from{' '}
                  <b>{issued.phone}</b> within 10 minutes.
                </Text>
                {issued.waLink && (
                  <Anchor href={issued.waLink} target="_blank" rel="noreferrer">
                    Open WhatsApp with the message ready
                  </Anchor>
                )}
                <Text size="xs" c="dimmed">
                  Refresh this page after sending it.
                </Text>
              </Stack>
            </Alert>
          )}
        </Stack>
      )}
    </Card>
  );
}

function PinCard({ profile }: { profile: WhatsAppProfileDto }) {
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const setPinMutation = useSetPin();
  const valid = /^\d{6}$/.test(pin) && password.length > 0;

  return (
    <Card withBorder>
      <Group gap="xs" mb="sm">
        <IconLock size={20} />
        <Title order={4}>Approval PIN</Title>
        {profile.hasApprovalPin ? (
          <Badge color="green">Set</Badge>
        ) : (
          <Badge color="gray">Not set</Badge>
        )}
      </Group>
      <Text size="sm" mb="sm">
        WhatsApp asks for this 6-digit PIN before an approval counts. Five wrong PINs lock WhatsApp
        approvals for 30 minutes. Note: a PIN you type in WhatsApp stays visible in that chat.
      </Text>
      {profile.pinLockedUntil && (
        <Alert color="orange" mb="sm">
          WhatsApp approvals are locked until{' '}
          {new Date(profile.pinLockedUntil).toLocaleTimeString()}.
        </Alert>
      )}
      <Group align="flex-end">
        <PasswordInput
          label={profile.hasApprovalPin ? 'New PIN' : 'PIN'}
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
          w={140}
        />
        <PasswordInput
          label="Your password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          autoComplete="current-password"
        />
        <Button
          disabled={!valid}
          loading={setPinMutation.isPending}
          onClick={() =>
            setPinMutation.mutate(
              { pin, currentPassword: password },
              {
                onSuccess: () => {
                  setDone(true);
                  setPin('');
                  setPassword('');
                },
              },
            )
          }
        >
          Save PIN
        </Button>
      </Group>
      {setPinMutation.error && (
        <Alert color="red" mt="sm">
          {setPinMutation.error.message}
        </Alert>
      )}
      {done && !setPinMutation.error && (
        <Alert color="green" mt="sm">
          Approval PIN saved.
        </Alert>
      )}
    </Card>
  );
}

const PREF_LABELS: Record<keyof NotificationPrefs, string> = {
  awaitingApproval: 'Requests waiting for my approval',
  clarificationNeeded: 'Questions about my requests',
  statusChanged: 'Status changes of my requests',
};

function PrefsCard({ prefs }: { prefs: NotificationPrefs }) {
  const save = useSetPrefs();
  return (
    <Card withBorder>
      <Title order={4} mb="xs">
        WhatsApp notifications
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        The bell in the web app always shows everything.
      </Text>
      <Stack gap="xs">
        {(Object.keys(PREF_LABELS) as Array<keyof NotificationPrefs>).map((k) => (
          <Switch
            key={k}
            label={PREF_LABELS[k]}
            checked={prefs[k]}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ ...prefs, [k]: e.currentTarget.checked })}
          />
        ))}
      </Stack>
      {save.error && (
        <Alert color="red" mt="sm">
          {save.error.message}
        </Alert>
      )}
    </Card>
  );
}
