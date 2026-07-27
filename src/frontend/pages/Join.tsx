import {
  Button,
  Code,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { track } from "../services/analytics";
import { JOIN_PAGE_INVITE_URL } from "../utils/discordInvite";

const STEPS = [
  "Join a voice channel in your server.",
  "Run /startmeeting.",
  "Talk. When the meeting ends, the notes post back to the channel.",
];

export default function Join() {
  const { state: authState, loginUrl, loading } = useAuth();

  return (
    <Container size={720} py={{ base: 48, md: 96 }}>
      <Stack gap={64}>
        <Stack gap="xl" data-testid="join-hero">
          <Title
            order={1}
            fw={600}
            fz={{ base: 30, md: 40 }}
            lh={1.15}
            style={{ letterSpacing: "-0.03em", textWrap: "balance" }}
          >
            Chronote is in your server.
          </Title>
          <Text size="lg" c="dimmed" maw={560}>
            Nothing records until you start a meeting. Here is how to get your
            first set of notes.
          </Text>
        </Stack>

        <Stack gap="md">
          {STEPS.map((step, index) => (
            <Group key={step} gap="md" wrap="nowrap" align="baseline">
              <Text size="sm" c="dimmed" ff="monospace">
                {index + 1}
              </Text>
              <Text>{step}</Text>
            </Group>
          ))}
          <Text size="sm" c="dimmed">
            Prefer it hands free? Run <Code>/autorecord</Code> to have Chronote
            join the channels you pick automatically.
          </Text>
        </Stack>

        <Stack gap="md">
          <Title order={2} fz={22} fw={600}>
            Your meeting library
          </Title>
          <Text c="dimmed">
            Every recorded meeting is kept on the web, where you can read the
            transcript, correct the notes, and ask questions about past
            meetings.
          </Text>
          <Group gap="sm" wrap="wrap">
            {authState === "authenticated" ? (
              <Button component={Link} to="/portal" size="md">
                Open portal
              </Button>
            ) : (
              <Button component="a" href={loginUrl} loading={loading} size="md">
                Open portal
              </Button>
            )}
            <Button
              size="md"
              variant="subtle"
              component="a"
              href={JOIN_PAGE_INVITE_URL}
              data-testid="join-cta-discord"
              onClick={() =>
                track("add_to_discord_clicked", { location: "join" })
              }
            >
              Add to another server
            </Button>
          </Group>
        </Stack>
      </Stack>
    </Container>
  );
}
