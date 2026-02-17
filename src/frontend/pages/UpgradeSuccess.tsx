import {
  Badge,
  Box,
  Button,
  Group,
  List,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconArrowRight,
  IconCheck,
  IconCreditCard,
  IconConfetti,
  IconSparkles,
  IconTicket,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";
import { type Guild, useGuildContext } from "../contexts/GuildContext";
import { buildApiUrl } from "../services/apiClient";
import { heroBackground, uiTypography } from "../uiTokens";
import styles from "./UpgradeSuccess.module.css";

const CONFETTI_PIECES = [
  { left: 6, delayMs: 0, durationMs: 1800, rotateDeg: -20, color: "#22d3ee" },
  {
    left: 14,
    delayMs: 120,
    durationMs: 2100,
    rotateDeg: 30,
    color: "#60a5fa",
  },
  {
    left: 22,
    delayMs: 240,
    durationMs: 1700,
    rotateDeg: -32,
    color: "#34d399",
  },
  {
    left: 31,
    delayMs: 80,
    durationMs: 1950,
    rotateDeg: 28,
    color: "#f59e0b",
  },
  {
    left: 43,
    delayMs: 260,
    durationMs: 2250,
    rotateDeg: -36,
    color: "#22d3ee",
  },
  {
    left: 54,
    delayMs: 40,
    durationMs: 1850,
    rotateDeg: 20,
    color: "#c084fc",
  },
  {
    left: 62,
    delayMs: 180,
    durationMs: 2120,
    rotateDeg: -26,
    color: "#34d399",
  },
  {
    left: 71,
    delayMs: 300,
    durationMs: 2050,
    rotateDeg: 36,
    color: "#f97316",
  },
  {
    left: 79,
    delayMs: 140,
    durationMs: 1820,
    rotateDeg: -18,
    color: "#22d3ee",
  },
  {
    left: 88,
    delayMs: 340,
    durationMs: 2350,
    rotateDeg: 22,
    color: "#6366f1",
  },
  {
    left: 94,
    delayMs: 210,
    durationMs: 1900,
    rotateDeg: -28,
    color: "#fde047",
  },
] as const;

const UPGRADE_CHECKLIST = [
  "Higher plan limits are now active.",
  "Billing controls are available in your server portal.",
  "Your saved meetings and notes stay exactly where they are.",
] as const;

const PLAN_LABELS = {
  basic: "Basic",
  pro: "Pro",
} as const;

const INTERVAL_LABELS = {
  month: "Monthly",
  year: "Annual",
} as const;

type UpgradeSuccessPrimaryActionProps = {
  isAuthenticated: boolean;
  authLoading: boolean;
  loginUrl: string;
  serverId: string;
  serverName: string;
  onOpenPortal: () => void;
};

type UpgradeSuccessSecondaryActionProps = {
  isAuthenticated: boolean;
  onOpenBilling: () => void;
  onBackToHomepage: () => void;
};

type PromoAppliedRowProps = {
  promoCode: string;
};

type UpgradeStatusBadgesProps = {
  planChipLabel?: string;
  hasServerId: boolean;
};

const resolveUpgradeSuccessCopy = (serverId: string, serverName: string) =>
  serverId
    ? `Your subscription is active for ${serverName}.`
    : "Your subscription is active and ready to power your next meeting.";

const resolveUpgradeSuccessTitle = (serverId: string, serverName: string) => {
  if (!serverId) {
    return "Upgrade complete";
  }

  return serverName ? `${serverName} is upgraded` : "Your server is upgraded";
};

const resolvePrimaryActionLabel = (serverId: string, serverName: string) => {
  if (!serverId) {
    return "Open portal";
  }

  return serverName ? `Open ${serverName}` : "Open server";
};

export const resolveOpenPortalPath = (serverId: string, guilds: Guild[]) => {
  if (!serverId) {
    return "/portal/select-server";
  }

  const matchedGuild = guilds.find((guild) => guild.id === serverId);

  if (!matchedGuild) {
    return `/portal/server/${serverId}/ask`;
  }

  if (matchedGuild.canManage === false) {
    return `/portal/server/${serverId}/ask`;
  }

  return `/portal/server/${serverId}/library`;
};

export const resolveBillingPath = (serverId: string) =>
  serverId ? `/portal/server/${serverId}/billing` : "/portal/select-server";

function PromoAppliedRow({ promoCode }: PromoAppliedRowProps) {
  if (!promoCode) {
    return null;
  }

  return (
    <Group gap="xs">
      <ThemeIcon color="brand" variant="light" size="sm">
        <IconTicket size={14} />
      </ThemeIcon>
      <Text size="sm" fw={600}>
        Promo applied
      </Text>
      <Text size="sm" c="dimmed">
        {promoCode}
      </Text>
    </Group>
  );
}

function UpgradeStatusBadges({
  planChipLabel,
  hasServerId,
}: UpgradeStatusBadgesProps) {
  return (
    <Group gap="xs" wrap="wrap">
      <Badge variant="light" color="brand">
        Plan active now
      </Badge>
      {planChipLabel ? (
        <Badge variant="light" color="cyan">
          {planChipLabel}
        </Badge>
      ) : null}
      {hasServerId ? (
        <Badge variant="light" color="teal">
          Server linked
        </Badge>
      ) : null}
    </Group>
  );
}

type UpgradeSuccessHeroProps = {
  isDark: boolean;
  isAuthenticated: boolean;
  authLoading: boolean;
  loginUrl: string;
  serverId: string;
  serverName: string;
  headerCopy: string;
  promoCode: string;
  onOpenPortal: () => void;
  onOpenBilling: () => void;
  onBackToHomepage: () => void;
  plan?: "basic" | "pro";
  interval?: "month" | "year";
};

export function UpgradeSuccessHero({
  isDark,
  isAuthenticated,
  authLoading,
  loginUrl,
  serverId,
  serverName,
  headerCopy,
  promoCode,
  onOpenPortal,
  onOpenBilling,
  onBackToHomepage,
  plan,
  interval,
}: UpgradeSuccessHeroProps) {
  const planChipLabel =
    plan && interval
      ? `${PLAN_LABELS[plan]} · ${INTERVAL_LABELS[interval]}`
      : undefined;

  return (
    <Surface
      p={{ base: "lg", md: "xl" }}
      tone="raised"
      className={styles.heroSurface}
      style={{ backgroundImage: heroBackground(isDark) }}
    >
      <Box className={styles.confettiLayer} aria-hidden>
        {CONFETTI_PIECES.map((piece) => (
          <Box
            key={`${piece.left}-${piece.delayMs}`}
            className={styles.confettiPiece}
            style={{
              left: `${piece.left}%`,
              backgroundColor: piece.color,
              animationDelay: `${piece.delayMs}ms`,
              animationDuration: `${piece.durationMs}ms`,
              "--confetti-rotate-start": `${piece.rotateDeg}deg`,
              "--confetti-rotate-end": `${piece.rotateDeg + 240}deg`,
            }}
          />
        ))}
      </Box>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap="md" className={styles.heroContent}>
          <Text size="xs" c="dimmed" style={uiTypography.heroKicker}>
            Upgrade successful
          </Text>
          <Group gap="sm" align="center">
            <ThemeIcon color="brand" variant="light" size="lg">
              <IconConfetti size={18} />
            </ThemeIcon>
            <Title order={2}>
              {resolveUpgradeSuccessTitle(serverId, serverName)}
            </Title>
          </Group>
          <Text c="dimmed" size="sm">
            {headerCopy}
          </Text>
          <UpgradeStatusBadges
            planChipLabel={planChipLabel}
            hasServerId={Boolean(serverId)}
          />
          <PromoAppliedRow promoCode={promoCode} />
          <Group gap="sm" wrap="wrap">
            <UpgradeSuccessPrimaryAction
              isAuthenticated={isAuthenticated}
              authLoading={authLoading}
              loginUrl={loginUrl}
              serverId={serverId}
              serverName={serverName}
              onOpenPortal={onOpenPortal}
            />
            <UpgradeSuccessSecondaryAction
              isAuthenticated={isAuthenticated}
              onOpenBilling={onOpenBilling}
              onBackToHomepage={onBackToHomepage}
            />
          </Group>
        </Stack>

        <Surface p="lg" tone="soft" className={styles.detailsPanel}>
          <Stack gap="sm">
            <Text fw={600}>What unlocked today</Text>
            <List
              spacing="sm"
              size="sm"
              icon={
                <ThemeIcon color="brand" size={18} radius="xl">
                  <IconCheck size={12} />
                </ThemeIcon>
              }
            >
              {UPGRADE_CHECKLIST.map((line) => (
                <List.Item key={line}>
                  <Text size="sm" c="dimmed">
                    {line}
                  </Text>
                </List.Item>
              ))}
            </List>
          </Stack>
        </Surface>
      </SimpleGrid>
    </Surface>
  );
}

function UpgradeSuccessPrimaryAction({
  isAuthenticated,
  authLoading,
  loginUrl,
  serverId,
  serverName,
  onOpenPortal,
}: UpgradeSuccessPrimaryActionProps) {
  if (isAuthenticated) {
    return (
      <Button
        onClick={onOpenPortal}
        rightSection={<IconArrowRight size={16} />}
      >
        {resolvePrimaryActionLabel(serverId, serverName)}
      </Button>
    );
  }
  return (
    <Button
      component="a"
      href={loginUrl}
      rightSection={<IconArrowRight size={16} />}
      loading={authLoading}
    >
      Connect Discord
    </Button>
  );
}

function UpgradeSuccessSecondaryAction({
  isAuthenticated,
  onOpenBilling,
  onBackToHomepage,
}: UpgradeSuccessSecondaryActionProps) {
  if (isAuthenticated) {
    return (
      <Button
        variant="light"
        onClick={onOpenBilling}
        rightSection={<IconSparkles size={16} />}
      >
        Manage billing
      </Button>
    );
  }
  return (
    <Button
      variant="light"
      onClick={onBackToHomepage}
      rightSection={<IconSparkles size={16} />}
    >
      Back to homepage
    </Button>
  );
}

export default function UpgradeSuccess() {
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const { state: authState, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { guilds } = useGuildContext();
  const search = useSearch({ from: "/marketing/upgrade/success" });
  const promoCode = search.promo?.trim() ?? "";
  const serverId = search.serverId?.trim() ?? "";
  const isAuthenticated = authState === "authenticated";
  const resolvedServerName = guilds.find(
    (guild) => guild.id === serverId,
  )?.name;
  const serverName = resolvedServerName ?? "";
  const headerCopy = resolveUpgradeSuccessCopy(
    serverId,
    resolvedServerName ?? "your server",
  );
  const openPortalPath = resolveOpenPortalPath(serverId, guilds);
  const billingPath = resolveBillingPath(serverId);
  const handleOpenPortal = () => {
    navigate({ to: openPortalPath });
  };
  const handleOpenBilling = () => {
    navigate({ to: billingPath });
  };
  const handleBackToHomepage = () => {
    navigate({ to: "/" });
  };

  const redirectTarget = `${window.location.origin}${openPortalPath}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    redirectTarget,
  )}`;

  return (
    <Stack gap="xl">
      <UpgradeSuccessHero
        isDark={isDark}
        isAuthenticated={isAuthenticated}
        authLoading={authLoading}
        loginUrl={loginUrl}
        serverId={serverId}
        serverName={serverName}
        headerCopy={headerCopy}
        promoCode={promoCode}
        onOpenPortal={handleOpenPortal}
        onOpenBilling={handleOpenBilling}
        onBackToHomepage={handleBackToHomepage}
        plan={search.plan}
        interval={search.interval}
      />

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
        <Surface p="lg" tone="soft">
          <Stack gap="sm">
            <ThemeIcon color="brand" variant="light">
              <IconSparkles size={18} />
            </ThemeIcon>
            <Text fw={600}>Announce the upgrade</Text>
            <Text size="sm" c="dimmed">
              Drop a quick message so your team knows the new plan is live.
            </Text>
          </Stack>
        </Surface>
        <Surface p="lg" tone="soft">
          <Stack gap="sm">
            <ThemeIcon color="brand" variant="light">
              <IconCreditCard size={18} />
            </ThemeIcon>
            <Text fw={600}>Keep billing in sync</Text>
            <Text size="sm" c="dimmed">
              Update payment methods, invoices, and plan settings from one
              place.
            </Text>
          </Stack>
        </Surface>
        <Surface p="lg" tone="soft">
          <Stack gap="sm">
            <ThemeIcon color="brand" variant="light">
              <IconSparkles size={18} />
            </ThemeIcon>
            <Text fw={600}>Run your first upgraded meeting</Text>
            <Text size="sm" c="dimmed">
              Start a session and use the higher limits right away.
            </Text>
          </Stack>
        </Surface>
      </SimpleGrid>
    </Stack>
  );
}
