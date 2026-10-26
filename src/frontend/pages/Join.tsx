import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Code,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { IconArrowRight, IconBrandDiscord } from "@tabler/icons-react";
import { useAuth } from "../contexts/AuthContext";
import SampleSummary from "../components/SampleSummary";
import ServerPicker from "../components/ServerPicker";
import { trpc } from "../services/trpc";
import { track } from "../services/analytics";
import { buildInstallUrl } from "../utils/discordInvite";
import type { FirstMeetingState } from "../../types/firstMeeting";

const STEPS = [
  "Join a voice channel.",
  <>
    Run <Code>/startmeeting</Code> in a text channel.
  </>,
  "End the recording to get your notes.",
];

function stateCopy(state: FirstMeetingState): string {
  switch (state.kind) {
    case "guide":
      return "Record your first meeting.";
    case "recording":
      return "Recording in progress";
    case "processing":
      return "Preparing your notes";
    case "ready":
      return "Your notes are ready";
    case "saved":
      return "Notes saved";
    case "delivery_attention":
      return state.delivery === "partial"
        ? "Notes saved. Some notes could not be posted to Discord."
        : "Notes saved. Discord delivery failed.";
    case "attention": {
      const messages = {
        interrupted: "Recording interrupted",
        no_notes: "No notes were generated",
        processing_failed: "Notes processing failed",
        status_unknown: "Meeting status unavailable",
      };
      return messages[state.reason];
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function MeetingResult({
  state,
  stale,
}: {
  state: FirstMeetingState;
  stale: boolean;
}) {
  if (state.kind === "guide") {
    return stale ? null : (
      <Text c="dimmed">No accessible recent meeting found yet.</Text>
    );
  }
  const live = state.kind === "recording" || state.kind === "processing";
  const saved =
    state.kind === "ready" ||
    state.kind === "saved" ||
    state.kind === "delivery_attention";
  return (
    <>
      <Title order={2} fz={24}>
        {stale && live ? "Last verified meeting" : stateCopy(state)}
      </Title>
      <Text>{state.meeting.title}</Text>
      {state.meeting.captureNotice ? (
        <Alert color="orange">{state.meeting.captureNotice}</Alert>
      ) : null}
      {state.meeting.recoveryNotice ? (
        <Alert color="orange">{state.meeting.recoveryNotice}</Alert>
      ) : null}
      {saved ? (
        <Button component="a" href={state.meeting.portalUrl}>
          Open meeting
        </Button>
      ) : !stale && state.meeting.discordUrl ? (
        <Button component="a" href={state.meeting.discordUrl}>
          View recording
        </Button>
      ) : null}
      {state.kind === "delivery_attention" ? (
        <Text size="sm" c="dimmed">
          Check Chronote's permissions in the notes channel.
        </Text>
      ) : null}
    </>
  );
}

function matchesTarget(
  state: FirstMeetingState | undefined,
  historyId?: string,
) {
  if (!state || state.kind === "guide" || !historyId) return state;
  return state.meeting.historyId === historyId ? state : undefined;
}

function accessDenied(code?: string) {
  return (
    code === "FORBIDDEN" || code === "UNAUTHORIZED" || code === "NOT_FOUND"
  );
}

function MeetingProgress({
  serverId,
  historyId,
}: {
  serverId: string;
  historyId?: string;
}) {
  const navigate = useNavigate({ from: "/join" });
  const [verified, setVerified] = useState<FirstMeetingState>();
  const progress = trpc.meetings.firstMeeting.useQuery(
    { serverId, historyId },
    {
      retry: false,
      placeholderData: undefined,
      refetchOnWindowFocus: "always",
      refetchIntervalInBackground: false,
      refetchInterval: (query) => {
        if (query.state.error || document.visibilityState !== "visible")
          return false;
        const kind = query.state.data?.kind;
        return kind === "recording" || kind === "processing" ? 10_000 : false;
      },
    },
  );
  const errorCode = progress.error?.data?.code;
  const denied = accessDenied(errorCode);
  const current = matchesTarget(
    progress.isSuccess && !progress.isPlaceholderData
      ? progress.data
      : undefined,
    historyId,
  );
  const displayed = denied
    ? undefined
    : (current ?? matchesTarget(verified, historyId));

  useEffect(() => {
    if (denied) {
      setVerified(undefined);
      return;
    }
    if (!current) return;
    setVerified(current);
    if (current.kind !== "guide" && !historyId) {
      void navigate({
        search: { serverId, historyId: current.meeting.historyId },
        replace: true,
      });
    }
  }, [current, denied, historyId, navigate, serverId]);

  return (
    <Paper withBorder radius="md" p="lg" data-testid="first-meeting-progress">
      <Stack gap="sm" align="flex-start">
        {progress.error ? (
          <Alert color={denied ? "orange" : "gray"} role="status">
            {denied
              ? "This meeting or server is unavailable. Check your access in Discord."
              : "Status unavailable. Check again to refresh it."}
          </Alert>
        ) : progress.isLoading ? (
          <Text c="dimmed">Checking meeting status...</Text>
        ) : null}
        {displayed ? (
          <MeetingResult state={displayed} stale={Boolean(progress.error)} />
        ) : null}
        <Button variant="subtle" onClick={() => void progress.refetch()}>
          Check again
        </Button>
      </Stack>
    </Paper>
  );
}

export default function Join() {
  const { state: authState, loginUrl, loading } = useAuth();
  const { serverId, historyId } = useSearch({ from: "/marketing/join" });
  const navigate = useNavigate({ from: "/join" });
  const [choosing, setChoosing] = useState(false);
  const servers = trpc.servers.listEligible.useQuery(undefined, {
    enabled: authState === "authenticated",
    retry: false,
  });
  const guilds = servers.data?.guilds ?? [];
  const verifiedServer =
    authState === "authenticated" && !servers.isLoading && !servers.error
      ? guilds.find((guild) => guild.id === serverId)
      : undefined;
  const discordUrl = verifiedServer
    ? `https://discord.com/channels/${verifiedServer.id}`
    : "https://discord.com/channels/@me";
  const portalUrl = verifiedServer
    ? `/portal/server/${verifiedServer.id}/library`
    : "/portal";

  return (
    <Container
      size={1040}
      pt={{ base: 24, md: 48 }}
      pb={{ base: 48, md: 80 }}
      px={0}
    >
      <Stack gap="xl">
        <Stack gap="md" align="flex-start" data-testid="join-hero">
          <Title
            order={1}
            fw={600}
            fz={{ base: 30, md: 42 }}
            lh={1.15}
            style={{ letterSpacing: "-0.025em", textWrap: "balance" }}
          >
            Record your first meeting.
          </Title>
          <Text size="lg" c="dimmed">
            A voice call in, notes out. Start in Discord.
          </Text>
          <Group>
            <Button
              component="a"
              href={discordUrl}
              size="md"
              leftSection={<IconBrandDiscord size={20} />}
              rightSection={<IconArrowRight size={18} />}
              data-testid="join-open-discord"
            >
              Open Discord
            </Button>
            <Button component="a" href={portalUrl} variant="light">
              Open portal
            </Button>
          </Group>
          {authState === "authenticated" ? (
            <Button variant="subtle" onClick={() => setChoosing(!choosing)}>
              Choose a server
            </Button>
          ) : (
            <Button
              component="a"
              href={loginUrl}
              loading={loading}
              variant="subtle"
            >
              Sign in to check progress
            </Button>
          )}
        </Stack>
        {choosing && authState === "authenticated" ? (
          <ServerPicker
            guilds={guilds.map((guild) => ({
              ...guild,
              canManage: guild.canManage ?? false,
            }))}
            loading={servers.isLoading}
            selectedGuildId={verifiedServer?.id}
            onSelect={(id) => {
              void navigate({
                search: { serverId: id, historyId: undefined },
                replace: true,
              });
              setChoosing(false);
            }}
            emptyTitle="No servers available"
            emptyDescription="Check your Discord server access and try signing in again."
          />
        ) : null}
        {verifiedServer ? (
          <MeetingProgress
            key={verifiedServer.id}
            serverId={verifiedServer.id}
            historyId={historyId}
          />
        ) : null}
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
          <Stack gap="lg">
            <Paper withBorder radius="md" p="lg">
              <Stack gap="xl">
                {STEPS.map((step, index) => (
                  <Group key={index} gap="md" wrap="nowrap" align="flex-start">
                    <Text fw={700} c="brand" size="lg">
                      {index + 1}
                    </Text>
                    <Text fw={600}>{step}</Text>
                  </Group>
                ))}
                <Text size="sm" c="dimmed">
                  Chronote replies privately with a link to your recording.
                  Follow it to find the controls and notes.
                </Text>
              </Stack>
            </Paper>
            <Box
              component="details"
              id="optional-setup"
              open={window.location.hash === "#optional-setup" || undefined}
            >
              <Text
                component="summary"
                size="sm"
                fw={600}
                style={{ cursor: "pointer" }}
              >
                Optional setup
              </Text>
              <Text size="sm" c="dimmed" mt="sm">
                Use <Code>/context</Code> to give Chronote background for your
                notes. Use <Code>/autorecord</Code> to choose voice channels to
                record automatically.
              </Text>
            </Box>
          </Stack>
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Example notes · Fictional meeting
            </Text>
            <SampleSummary />
          </Stack>
        </SimpleGrid>
        <Button
          variant="subtle"
          component="a"
          href={buildInstallUrl({ ctaLocation: "join" })}
          data-testid="join-cta-discord"
          onClick={() => track("add_to_discord_clicked", { location: "join" })}
        >
          Add to another server
        </Button>
      </Stack>
    </Container>
  );
}
