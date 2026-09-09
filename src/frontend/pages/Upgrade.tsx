import {
  Box,
  Button,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconClock,
  IconRocket,
  IconSparkles,
  IconStar,
  IconTicket,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../services/apiClient";
import { uiTypography } from "../uiTokens";

const BENEFITS = [
  {
    icon: IconClock,
    title: "Longer, deeper sessions",
    description:
      "Record more each week, with up to two hours per meeting on Basic and Pro.",
  },
  {
    icon: IconBolt,
    title: "Live voice mode",
    description:
      "Keep meetings flowing with real time capture and searchable notes.",
  },
  {
    icon: IconStar,
    title: "Priority features",
    description: "Get the newest capabilities and early access to upgrades.",
  },
];

export default function Upgrade() {
  const { state: authState, loading: authLoading } = useAuth();
  const search = useSearch({ strict: false }) as {
    promo?: string;
    serverId?: string;
    plan?: "basic" | "pro";
    interval?: "month" | "year";
    canceled?: boolean;
  };
  const promoCode = search.promo?.trim() ?? "";
  const preselectedServerId = search.serverId?.trim() ?? "";
  const wasCanceled = String(search.canceled) === "true";
  const navigate = useNavigate();

  const params = new URLSearchParams();
  if (promoCode) params.set("promo", promoCode);
  if (preselectedServerId) params.set("serverId", preselectedServerId);
  if (search.plan) params.set("plan", search.plan);
  if (search.interval) params.set("interval", search.interval);
  if (wasCanceled) params.set("canceled", "true");
  const promoQuery = params.toString();
  const redirectTarget = `${window.location.origin}/upgrade/select-server${
    promoQuery ? `?${promoQuery}` : ""
  }`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    redirectTarget,
  )}`;

  const handleCta = () => {
    navigate({
      to: "/upgrade/select-server",
      search: {
        promo: promoCode || undefined,
        serverId: preselectedServerId || undefined,
        plan: search.plan,
        interval: search.interval,
        canceled: wasCanceled || undefined,
      },
    });
  };

  return (
    <Stack gap="xl">
      <Surface p={{ base: "lg", md: "xl" }} tone="raised">
        <Stack gap="md">
          <Text size="xs" c="dimmed" style={uiTypography.heroKicker}>
            Upgrade today
          </Text>
          <Title order={2}>Make every meeting unforgettable.</Title>
          <Text c="dimmed" size="sm">
            Get more recording time and ask questions across more meetings.
          </Text>
          {promoCode || wasCanceled ? (
            <Stack gap="xs">
              {promoCode ? (
                <Group gap="xs">
                  <ThemeIcon color="brand" variant="light" size="sm">
                    <IconTicket size={14} />
                  </ThemeIcon>
                  <Text size="sm" fw={600}>
                    Promo unlocked
                  </Text>
                  <Text size="sm" c="dimmed">
                    {promoCode}
                  </Text>
                </Group>
              ) : null}
              {wasCanceled ? (
                <Group gap="xs">
                  <ThemeIcon color="yellow" variant="light" size="sm">
                    <IconAlertTriangle size={14} />
                  </ThemeIcon>
                  <Text size="sm" c="dimmed">
                    Checkout canceled. Pick a server when you are ready.
                  </Text>
                </Group>
              ) : null}
            </Stack>
          ) : null}
          <Group gap="sm" wrap="wrap">
            {authState === "authenticated" ? (
              <Button
                rightSection={<IconArrowRight size={16} />}
                onClick={handleCta}
              >
                Pick a server to upgrade
              </Button>
            ) : (
              <Button
                component="a"
                href={loginUrl}
                rightSection={<IconArrowRight size={16} />}
                loading={authLoading}
              >
                Connect Discord to continue
              </Button>
            )}
            <Button
              variant="light"
              component="a"
              href="/"
              rightSection={<IconSparkles size={16} />}
            >
              See what is included
            </Button>
          </Group>
        </Stack>
      </Surface>

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
        {BENEFITS.map((benefit) => (
          <Surface key={benefit.title} p="lg">
            <Stack gap="sm">
              <ThemeIcon color="brand" variant="light">
                <benefit.icon size={18} />
              </ThemeIcon>
              <Text fw={600}>{benefit.title}</Text>
              <Text size="sm" c="dimmed">
                {benefit.description}
              </Text>
            </Stack>
          </Surface>
        ))}
      </SimpleGrid>

      <Surface p="lg">
        <Group gap="sm" align="center" wrap="wrap">
          <ThemeIcon color="brand" variant="light">
            <IconRocket size={18} />
          </ThemeIcon>
          <Box>
            <Text fw={600}>Ready to upgrade</Text>
            <Text size="sm" c="dimmed">
              Choose your server and compare plans before continuing to billing.
            </Text>
          </Box>
        </Group>
      </Surface>
    </Stack>
  );
}
