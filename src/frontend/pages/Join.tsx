import {
  Button,
  Container,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  IconMicrophone,
  IconFileText,
  IconSearch,
  IconArrowRight,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import Surface from "../components/Surface";
import { heroBackground, uiTypography } from "../uiTokens";
import { useAuth } from "../contexts/AuthContext";
import { JOIN_PAGE_INVITE_URL } from "../utils/discordInvite";

const STEP_ICON_SIZE = 44;
const STEP_INNER_ICON_SIZE = 22;

const steps = [
  {
    icon: IconMicrophone,
    title: "Add the bot",
    description: "Invite Chronote to your Discord server with one click.",
    color: "cyan",
  },
  {
    icon: IconFileText,
    title: "Record a meeting",
    description:
      "Start a voice call and use /startmeeting (or turn on auto-record).",
    color: "violet",
  },
  {
    icon: IconSearch,
    title: "Get your notes",
    description:
      "Chronote posts a transcript and summary right back in Discord.",
    color: "brand",
  },
] as const;

export default function Join() {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const { state: authState, loginUrl, loading } = useAuth();

  return (
    <Container size="sm" py={{ base: "xl", md: 80 }}>
      <Stack gap="xl" align="center">
        {/* Hero */}
        <Stack
          align="center"
          gap="md"
          p={{ base: "lg", md: "xl" }}
          style={{
            backgroundImage: heroBackground(isDark),
            borderRadius: theme.radius.lg,
            textAlign: "center",
          }}
        >
          <Text
            size="xs"
            c={isDark ? theme.colors.cyan[3] : theme.colors.cyan[7]}
            style={uiTypography.heroKicker}
          >
            Discord voice logbook
          </Text>
          <Title order={1} fw={750}>
            Transcripts and summaries, automatically.
          </Title>
          <Text size="lg" c="dimmed" maw={480}>
            Add Chronote to your Discord server and turn every voice call into
            searchable notes.
          </Text>
          <Button
            size="lg"
            variant="gradient"
            gradient={{ from: "brand", to: "violet" }}
            component="a"
            href={JOIN_PAGE_INVITE_URL}
            data-testid="join-cta-discord"
            rightSection={<IconArrowRight size={18} />}
          >
            Add to Discord
          </Button>
        </Stack>

        {/* How it works */}
        <Stack gap="md" w="100%">
          <Text
            size="xs"
            c={isDark ? theme.colors.cyan[3] : theme.colors.cyan[7]}
            ta="center"
            style={uiTypography.sectionEyebrow}
          >
            How it works
          </Text>
          <Title order={2} ta="center">
            Three steps to meeting notes
          </Title>

          <Stack gap="sm" mt="sm">
            {steps.map((step) => (
              <Surface key={step.title} p="md">
                <Group gap="md" wrap="nowrap" align="flex-start">
                  <ThemeIcon
                    variant="light"
                    color={step.color}
                    size={STEP_ICON_SIZE}
                    radius="md"
                  >
                    <step.icon size={STEP_INNER_ICON_SIZE} />
                  </ThemeIcon>
                  <Stack gap={4}>
                    <Text fw={600}>{step.title}</Text>
                    <Text size="sm" c="dimmed">
                      {step.description}
                    </Text>
                  </Stack>
                </Group>
              </Surface>
            ))}
          </Stack>
        </Stack>

        {/* Portal link for existing users */}
        <Surface p="md" w="100%" tone="soft">
          <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Stack gap={2}>
              <Text fw={600} size="sm">
                Already using Chronote?
              </Text>
              <Text size="xs" c="dimmed">
                Open the web portal to browse your meeting history.
              </Text>
            </Stack>
            {authState === "authenticated" ? (
              <Button
                component={Link}
                to="/portal/select-server"
                variant="light"
                color="brand"
                size="sm"
              >
                Open portal
              </Button>
            ) : (
              <Button
                component="a"
                href={loginUrl}
                disabled={loading}
                variant="light"
                color="brand"
                size="sm"
              >
                Open portal
              </Button>
            )}
          </Group>
        </Surface>
      </Stack>
    </Container>
  );
}
