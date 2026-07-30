import { Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { type Guild, useGuildContext } from "../contexts/GuildContext";
import { buildApiUrl } from "../services/apiClient";
import type { BillingInterval, PaidTier } from "../../types/pricing";

const PLAN_LABELS: Record<PaidTier, string> = {
  basic: "Basic",
  pro: "Pro",
};

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "Billed monthly.",
  year: "Billed annually.",
};

const encodeServerId = (serverId: string) => encodeURIComponent(serverId);

const resolvePrimaryActionLabel = (serverId: string, serverName: string) => {
  if (!serverId) {
    return "Open portal";
  }

  return serverName ? `Open ${serverName}` : "Open server";
};

export const resolveOpenPortalPath = (serverId: string, guilds: Guild[]) => {
  if (!serverId) {
    return "/portal";
  }

  const encodedServerId = encodeServerId(serverId);
  const matchedGuild = guilds.find((guild) => guild.id === serverId);

  if (!matchedGuild) {
    return `/portal/server/${encodedServerId}/ask`;
  }

  if (matchedGuild.canManage === false) {
    return `/portal/server/${encodedServerId}/ask`;
  }

  return `/portal/server/${encodedServerId}/library`;
};

export const resolvePostAuthPortalPath = (
  serverId: string,
  guilds: Guild[],
) => {
  if (!serverId) {
    return "/portal";
  }

  const encodedServerId = encodeServerId(serverId);
  const matchedGuild = guilds.find((guild) => guild.id === serverId);

  if (matchedGuild?.canManage === false) {
    return `/portal/server/${encodedServerId}/ask`;
  }

  return `/portal/server/${encodedServerId}/library`;
};

export const resolveBillingPath = (serverId: string) => {
  if (serverId) {
    return `/portal/server/${encodeServerId(serverId)}/billing`;
  }

  // Billing is server-scoped, so missing server context needs explicit selection.
  return "/portal/select-server";
};

/**
 * Stripe sends the plan and interval back on the success URL, so the page can
 * confirm what was actually bought rather than saying only that something was.
 */
export const resolveUpgradeSuccessTitle = (
  planLabel: string,
  serverName: string,
) => {
  if (!planLabel) {
    return serverName ? `${serverName} is upgraded` : "Upgrade complete";
  }

  return serverName
    ? `${serverName} is on ${planLabel}`
    : `You are on ${planLabel}`;
};

type UpgradeSuccessHeroProps = {
  isAuthenticated: boolean;
  authLoading: boolean;
  loginUrl: string;
  serverId: string;
  serverName: string;
  planLabel?: string;
  intervalLabel?: string;
  promoCode: string;
  onOpenPortal: () => void;
  onOpenBilling: () => void;
  onBackToHomepage: () => void;
};

export function UpgradeSuccessHero({
  isAuthenticated,
  authLoading,
  loginUrl,
  serverId,
  serverName,
  planLabel = "",
  intervalLabel = "",
  promoCode,
  onOpenPortal,
  onOpenBilling,
  onBackToHomepage,
}: UpgradeSuccessHeroProps) {
  return (
    <Stack gap="xl" align="flex-start">
      <Stack gap="sm" align="flex-start">
        <Title
          order={1}
          fw={600}
          fz={{ base: 28, md: 36 }}
          lh={1.15}
          style={{ letterSpacing: "-0.02em", textWrap: "balance" }}
        >
          {resolveUpgradeSuccessTitle(planLabel, serverName)}
        </Title>
        <Text c="dimmed">
          {intervalLabel
            ? `${intervalLabel} Your saved meetings and notes are untouched.`
            : "Your saved meetings and notes are untouched."}
        </Text>
        {promoCode ? (
          <Text size="sm" c="dimmed">
            Promo {promoCode} applied.
          </Text>
        ) : null}
      </Stack>

      <Group gap="sm" wrap="wrap">
        {isAuthenticated ? (
          <Button
            size="md"
            radius="md"
            onClick={onOpenPortal}
            rightSection={<IconArrowRight size={16} />}
          >
            {resolvePrimaryActionLabel(serverId, serverName)}
          </Button>
        ) : (
          <Button
            size="md"
            radius="md"
            component="a"
            href={loginUrl}
            loading={authLoading}
            rightSection={<IconArrowRight size={16} />}
          >
            Connect Discord
          </Button>
        )}
        {isAuthenticated ? (
          <Button size="md" variant="subtle" onClick={onOpenBilling}>
            Manage billing
          </Button>
        ) : (
          <Button size="md" variant="subtle" onClick={onBackToHomepage}>
            Back to homepage
          </Button>
        )}
      </Group>

      <Text size="sm" c="dimmed">
        New limits apply to your next meeting. If the plan still looks the same
        in the portal, give it a minute and refresh.
      </Text>
    </Stack>
  );
}

export default function UpgradeSuccess() {
  const { state: authState, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { guilds } = useGuildContext();
  const search = useSearch({ from: "/marketing/upgrade/success" });
  const promoCode = search.promo?.trim() ?? "";
  const serverId = search.serverId?.trim() ?? "";
  const planLabel = search.plan ? PLAN_LABELS[search.plan] : "";
  const intervalLabel = search.interval ? INTERVAL_LABELS[search.interval] : "";
  const isAuthenticated = authState === "authenticated";
  const serverName = guilds.find((guild) => guild.id === serverId)?.name ?? "";
  const openPortalPath = resolveOpenPortalPath(serverId, guilds);
  const postAuthPortalPath = resolvePostAuthPortalPath(serverId, guilds);
  const billingPath = resolveBillingPath(serverId);

  const redirectTarget = `${window.location.origin}${postAuthPortalPath}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    redirectTarget,
  )}`;

  return (
    <Container size={720} pt={{ base: 28, md: 48 }} pb={{ base: 48, md: 96 }}>
      <UpgradeSuccessHero
        isAuthenticated={isAuthenticated}
        authLoading={authLoading}
        loginUrl={loginUrl}
        serverId={serverId}
        serverName={serverName}
        planLabel={planLabel}
        intervalLabel={intervalLabel}
        promoCode={promoCode}
        onOpenPortal={() => navigate({ to: openPortalPath })}
        onOpenBilling={() => navigate({ to: billingPath })}
        onBackToHomepage={() => navigate({ to: "/" })}
      />
    </Container>
  );
}
