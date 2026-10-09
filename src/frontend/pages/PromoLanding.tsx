import {
  Button,
  Code,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconArrowRight, IconGift } from "@tabler/icons-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import PageHeader from "../components/PageHeader";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../services/apiClient";

export default function PromoLanding() {
  const { code } = useParams({ strict: false }) as { code?: string };
  const promoCode = code?.trim() ?? "";
  const { state: authState, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const redirectTarget = `${window.location.origin}/upgrade/select-server?promo=${promoCode}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    redirectTarget,
  )}`;

  return (
    <Stack gap="xl">
      <PageHeader
        title="Promo unlocked"
        description="Apply this code when you check out a paid plan."
      />

      <Surface p="xl" tone="raised">
        <Stack gap="md">
          <Group gap="sm" align="center">
            <ThemeIcon color="brand" variant="light">
              <IconGift size={18} />
            </ThemeIcon>
            <Title order={4}>Your promo code</Title>
          </Group>
          <Group gap="sm" align="center">
            <Text fw={600}>Use code</Text>
            <Code className="ph-no-capture ph-mask">{promoCode}</Code>
          </Group>
          <Text c="dimmed" size="sm">
            Choose a server to apply this code at checkout. You can review plans
            before confirming.
          </Text>
          <Group gap="sm" wrap="wrap">
            {authState === "authenticated" ? (
              <Button
                onClick={() =>
                  navigate({
                    to: "/upgrade/select-server",
                    search: { promo: promoCode },
                  })
                }
                rightSection={<IconArrowRight size={16} />}
              >
                Choose a server
              </Button>
            ) : (
              <Button
                component="a"
                href={loginUrl}
                loading={authLoading}
                rightSection={<IconArrowRight size={16} />}
              >
                Connect Discord to continue
              </Button>
            )}
            <Text size="xs" c="dimmed">
              {authState === "authenticated"
                ? "You will pick a server next."
                : "We only use Discord to map the subscription to your server."}
            </Text>
          </Group>
        </Stack>
      </Surface>

      <Surface p="lg" tone="soft">
        <Stack gap="xs">
          <Text fw={600}>What happens next</Text>
          <Text size="sm" c="dimmed">
            Pick a server and plan, then Stripe will confirm your discount
            before you pay.
          </Text>
        </Stack>
      </Surface>
    </Stack>
  );
}
