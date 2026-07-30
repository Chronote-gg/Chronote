import {
  Button,
  Code,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "../contexts/AuthContext";
import { track } from "../services/analytics";
import { JOIN_PAGE_INVITE_URL } from "../utils/discordInvite";

const STEPS: ReactNode[] = [
  "Join a voice channel in your server.",
  <>
    Run the <Code>/startmeeting</Code> command.
  </>,
  "Talk. The notes post back to the channel when the meeting ends.",
];

export default function Join() {
  const { state: authState, loginUrl, loading } = useAuth();

  return (
    <Container size={720} pt={{ base: 28, md: 48 }} pb={{ base: 48, md: 96 }}>
      <Stack gap={64}>
        <Stack gap="md" data-testid="join-hero" align="flex-start">
          <Title
            order={1}
            fw={600}
            fz={{ base: 30, md: 40 }}
            lh={1.15}
            style={{ letterSpacing: "-0.02em", textWrap: "balance" }}
          >
            Chronote is in your server.
          </Title>
          <Text size="lg" c="dimmed" maw={560}>
            Nothing records until you start a meeting. Here is how to get your
            first set of notes.
          </Text>
        </Stack>

        <Paper withBorder radius="md" p={{ base: "md", sm: "xl" }}>
          <Stack gap="lg">
            {STEPS.map((step, index) => (
              <Group key={index} gap="md" wrap="nowrap" align="baseline">
                <Text ff="monospace" fz={18} fw={600} c="brand.4" w={20}>
                  {index + 1}
                </Text>
                <Text fz="md">{step}</Text>
              </Group>
            ))}
          </Stack>
        </Paper>

        <Stack gap="md">
          <Title order={2} fz={22} fw={600}>
            Hands free
          </Title>
          <Text c="dimmed">
            Run <Code>/autorecord</Code> and Chronote joins the voice channels
            you pick on its own, so nobody has to remember the command.
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
              <Button component={Link} to="/portal" size="md" radius="md">
                Open portal
              </Button>
            ) : (
              <Button
                component="a"
                href={loginUrl}
                loading={loading}
                size="md"
                radius="md"
              >
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
