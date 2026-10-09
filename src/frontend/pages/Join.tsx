import {
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
import { Link } from "@tanstack/react-router";
import { IconArrowRight, IconBrandDiscord } from "@tabler/icons-react";
import { useAuth } from "../contexts/AuthContext";
import SampleSummary from "../components/SampleSummary";
import { track } from "../services/analytics";
import { buildInstallUrl } from "../utils/discordInvite";

const STEPS = [
  {
    title: "Join a voice channel",
    detail: "Use the server where you added Chronote.",
  },
  {
    title: "Start recording",
    detail: (
      <>
        Let everyone know you’re recording, then run <Code>/startmeeting</Code>{" "}
        in a text channel.
      </>
    ),
  },
  {
    title: "Talk, then end the meeting",
    detail: (
      <>
        Press <strong>End Meeting</strong> in Chronote’s recording message. Your
        notes will appear in the text channel.
      </>
    ),
  },
];

export default function Join() {
  const { state: authState, loginUrl, loading } = useAuth();
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
          <Button
            component="a"
            href="https://discord.com/channels/@me"
            size="md"
            leftSection={<IconBrandDiscord size={20} />}
            rightSection={<IconArrowRight size={18} />}
            data-testid="join-open-discord"
          >
            Open Discord
          </Button>
        </Stack>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
          <Stack gap="lg">
            <Paper withBorder radius="md" p="lg">
              <Stack gap="xl">
                {STEPS.map((step, index) => (
                  <Group
                    key={step.title}
                    gap="md"
                    wrap="nowrap"
                    align="flex-start"
                  >
                    <Text fw={700} c="brand" size="lg">
                      {index + 1}
                    </Text>
                    <Stack gap={6}>
                      <Text fw={600}>{step.title}</Text>
                      <Text size="sm" c="dimmed" lh={1.6}>
                        {step.detail}
                      </Text>
                    </Stack>
                  </Group>
                ))}
              </Stack>
            </Paper>
            <Box component="details">
              <Text
                component="summary"
                size="sm"
                fw={600}
                style={{ cursor: "pointer" }}
              >
                Want recordings to start automatically?
              </Text>
              <Text size="sm" c="dimmed" mt="sm">
                Run <Code>/autorecord</Code> to choose voice channels Chronote
                should record automatically. Tell participants before enabling
                it.
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
        <Stack gap="sm" align="flex-start">
          <Title order={2} fz={22}>
            Come back to what was decided.
          </Title>
          <Text size="sm" c="dimmed">
            Your meeting library keeps notes and transcripts together.
          </Text>
          <Group>
            {authState === "authenticated" ? (
              <Button component={Link} to="/portal" variant="light">
                Open meeting library
              </Button>
            ) : (
              <Button
                component="a"
                href={loginUrl}
                loading={loading}
                variant="light"
              >
                Open meeting library
              </Button>
            )}
            <Button
              variant="subtle"
              component="a"
              href={buildInstallUrl({ ctaLocation: "join" })}
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
