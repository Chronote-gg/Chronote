import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Center,
  Collapse,
  Divider,
  Group,
  List,
  Loader,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  useComputedColorScheme,
} from "@mantine/core";
import { IconCheck, IconCreditCard } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useSearch } from "@tanstack/react-router";
import { useGuildContext } from "../contexts/GuildContext";
import PageHeader from "../components/PageHeader";
import Surface from "../components/Surface";
import PricingCard from "../components/PricingCard";
import { trpc } from "../services/trpc";
import { uiBorders, uiColors, uiGradients } from "../uiTokens";
import type { inferRouterOutputs } from "@trpc/server";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import type { AppRouter } from "../../trpc/router";
import {
  annualSavingsLabel,
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";

type PlanTier = "free" | "basic" | "pro";

type Benefit = {
  label: string;
  values: Record<PlanTier, string>;
};

type RouterOutput = inferRouterOutputs<AppRouter>;
type BillingData = RouterOutput["billing"]["me"];

type BillingUsage = NonNullable<BillingData["usage"]>;

type BillingShellProps = {
  children: ReactNode;
  description?: string;
};

type BillingBaseProps = {
  serverName: string;
  usage?: BillingUsage | null;
  isDark: boolean;
};

type BillingPaidProps = BillingBaseProps & {
  data: BillingData;
  statusLabel: string;
  statusLine: string;
  isPortalPending: boolean;
  canManage: boolean;
  onPortal: () => void;
};

type BillingPlansProps = {
  data: BillingData;
  interval: BillingInterval;
  onIntervalChange: (value: BillingInterval) => void;
  hasAnnualPlans: boolean;
  showPlans: boolean;
  onExpandPlans: () => void;
  onTogglePlans: () => void;
  onCheckout: (tier: PaidTier) => void;
  promoCode: string;
  onPromoCodeChange: (value: string) => void;
  basicPlan: ReturnType<typeof resolvePaidPlan>;
  proPlan: ReturnType<typeof resolvePaidPlan>;
};

const DEFAULT_DESCRIPTION = "Manage subscriptions for the current server.";

const BENEFITS: Benefit[] = [
  {
    label: "Recording time per week",
    values: { free: "4 hours", basic: "20 hours", pro: "Unlimited" },
  },
  {
    label: "Max meeting length",
    values: {
      free: "90 minutes",
      basic: "2 hours",
      pro: "2 hours (8 hours coming soon)",
    },
  },
  {
    label: "Retention window",
    values: { free: "30 days", basic: "Extended", pro: "Unlimited" },
  },
  {
    label: "Ask history",
    values: {
      free: "Recent meetings",
      basic: "Longer history",
      pro: "Full retention",
    },
  },
  {
    label: "Live voice mode",
    values: { free: "No", basic: "Yes", pro: "Yes" },
  },
  {
    label: "Priority features",
    values: { free: "Not included", basic: "Not included", pro: "Yes" },
  },
];

const formatUsageMinutes = (minutes: number) => {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
  }
  return `${minutes}m`;
};

const formatStatusLabel = (status: string) =>
  status
    .split(/[_-\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const formatStatusLine = (
  statusLabel: string,
  nextBillingDate?: string | null,
) =>
  nextBillingDate
    ? `${statusLabel} - next billing ${new Date(
        nextBillingDate,
      ).toLocaleDateString()}`
    : statusLabel;

const BillingShell = ({
  children,
  description = DEFAULT_DESCRIPTION,
}: BillingShellProps) => (
  <Stack gap="xl" w="100%" data-testid="billing-page">
    <PageHeader title="Billing" description={description} />
    {children}
  </Stack>
);

const BillingLoadingState = () => (
  <BillingShell>
    <Center py="xl">
      <Stack gap="xs" align="center">
        <Loader color="brand" />
        <Text c="dimmed">Loading billing info...</Text>
      </Stack>
    </Center>
  </BillingShell>
);

const BillingErrorState = ({ message }: { message: string }) => (
  <BillingShell>
    <Text c="red">{message}</Text>
  </BillingShell>
);

const BillingNoServerState = () => (
  <BillingShell>
    <Surface p="xl">
      <Stack gap="sm">
        <Text fw={600}>Select a server to view billing</Text>
        <Text c="dimmed" size="sm">
          Choose a server in the sidebar to see its subscription status.
        </Text>
      </Stack>
    </Surface>
  </BillingShell>
);

const BillingDisabledState = () => (
  <BillingShell description="Billing is disabled in this environment.">
    <Alert title="Billing disabled" color="yellow">
      Billing is not enabled in this environment.
    </Alert>
  </BillingShell>
);

const BillingUsageMeter = ({ usage }: { usage?: BillingUsage | null }) => {
  if (!usage?.limitMinutes || usage.limitMinutes <= 0) return null;
  const used = usage.usedMinutes ?? 0;
  const limit = usage.limitMinutes;
  const percent = Math.min(100, (used / limit) * 100);
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs">
        <Text size="sm" c="dimmed">
          Usage (rolling 7 days)
        </Text>
        <Text size="sm" fw={600}>
          {formatUsageMinutes(used)} / {formatUsageMinutes(limit)}
        </Text>
      </Group>
      <Progress value={percent} color="brand" size="sm" />
    </Stack>
  );
};

const BillingFreePanel = ({ serverName, usage, isDark }: BillingBaseProps) => (
  <Surface
    p="xl"
    style={{ backgroundImage: uiGradients.billingPanel(isDark) }}
    data-testid="billing-current-plan"
  >
    <Stack gap="sm">
      <Group gap="sm">
        <ThemeIcon color="brand" variant="light">
          <IconCreditCard size={18} />
        </ThemeIcon>
        <Text fw={600}>You&apos;re on the Free plan</Text>
      </Group>
      <Text c="dimmed" size="sm">
        Unlock deeper recall, longer sessions, and higher retention by upgrading
        below.
      </Text>
      <Text size="sm" c="dimmed">
        Server: {serverName}
      </Text>
      <BillingUsageMeter usage={usage} />
    </Stack>
  </Surface>
);

const BillingPaidPanel = ({
  data,
  serverName,
  statusLabel,
  statusLine,
  usage,
  isPortalPending,
  canManage,
  onPortal,
  isDark,
}: BillingPaidProps) => (
  <Surface
    p="xl"
    style={{ backgroundImage: uiGradients.billingPanel(isDark) }}
    data-testid="billing-current-plan"
  >
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
      <Stack gap="md">
        <Stack gap="xs">
          <Group gap="sm">
            <ThemeIcon color="brand" variant="light">
              <IconCreditCard size={18} />
            </ThemeIcon>
            <Text fw={600}>Current plan</Text>
          </Group>
          <Group gap="sm" align="center">
            <Text size="lg" fw={700}>
              {data.tier === "pro" ? "Pro" : "Basic"}
            </Text>
            <Badge color="brand">{statusLabel}</Badge>
          </Group>
          <Text c="dimmed" size="sm">
            {statusLine}
          </Text>
          <Text size="sm" c="dimmed">
            Server: {serverName}
          </Text>
          <BillingUsageMeter usage={usage} />
        </Stack>

        <Divider />

        <Stack gap="xs">
          <Text fw={600}>Actions</Text>
          <Group gap="sm" wrap="wrap">
            <Button
              variant="gradient"
              gradient={{ from: "brand", to: "violet" }}
              disabled={!canManage}
              loading={isPortalPending}
              onClick={onPortal}
              data-testid="billing-manage"
            >
              Manage billing
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Changes apply immediately.
          </Text>
        </Stack>
      </Stack>

      <Stack gap="xs">
        <Text fw={600}>Included in this plan</Text>
        <List
          spacing="xs"
          size="sm"
          icon={
            <ThemeIcon color="brand" size={20}>
              <IconCheck size={12} />
            </ThemeIcon>
          }
        >
          {BENEFITS.map((benefit) => (
            <List.Item key={benefit.label}>
              {benefit.label}: {benefit.values[data.tier]}
            </List.Item>
          ))}
        </List>
      </Stack>
    </SimpleGrid>
  </Surface>
);

const BillingPlansSection = ({
  data,
  interval,
  onIntervalChange,
  hasAnnualPlans,
  showPlans,
  onExpandPlans,
  onTogglePlans,
  onCheckout,
  promoCode,
  onPromoCodeChange,
  basicPlan,
  proPlan,
}: BillingPlansProps) => {
  const isFreePlan = data.tier === "free";
  const plansExpanded = isFreePlan ? true : showPlans;
  const hasPromo = promoCode.trim().length > 0;
  return (
    <Surface
      p="lg"
      tone={plansExpanded ? "default" : "soft"}
      onClick={!plansExpanded ? onExpandPlans : undefined}
      style={{
        width: "100%",
        ...(plansExpanded
          ? {}
          : {
              cursor: "pointer",
              borderColor: uiColors.highlightBorder,
            }),
      }}
      data-testid="billing-plans"
    >
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm" align="center">
            <Title order={4}>Plans</Title>
          </Group>
          <SegmentedControl
            value={interval}
            onChange={(value) => onIntervalChange(value as BillingInterval)}
            data={[
              { label: "Monthly", value: "month" },
              {
                label: "Annual (best value)",
                value: "year",
                disabled: !hasAnnualPlans,
              },
            ]}
            size="sm"
            data-testid="billing-interval"
          />
          {isFreePlan ? null : (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={onTogglePlans}
            >
              {plansExpanded ? "Hide plans" : "Compare plans"}
            </Button>
          )}
        </Group>
        <Stack gap={4}>
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              label="Promo code"
              placeholder="Enter code"
              value={promoCode}
              onChange={(event) => onPromoCodeChange(event.currentTarget.value)}
              style={{ flex: "1 1 220px" }}
            />
            {hasPromo ? (
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                onClick={() => onPromoCodeChange("")}
              >
                Clear
              </Button>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            One code per purchase. Applied at checkout.
          </Text>
        </Stack>
        {!plansExpanded ? (
          <Text size="sm" c="dimmed">
            Compare plan details when you are ready to change tiers.
          </Text>
        ) : null}
        <Collapse expanded={plansExpanded}>
          <Divider my="sm" />
          <SimpleGrid cols={{ base: 1, xl: 3 }} spacing="md">
            <PricingCard
              name="Free"
              price="$0"
              description="Lightweight coverage for smaller servers."
              features={[
                "Up to 4 hours per week",
                "Up to 90 minutes per meeting",
                "Ask across recent meetings",
                "Notes, tags, and summaries",
              ]}
              cta={data.tier === "free" ? "Current plan" : "Available"}
              ctaDisabled={data.tier !== "free"}
              ctaProps={{
                variant: data.tier === "free" ? "light" : "outline",
              }}
              badge={data.tier === "free" ? "Current plan" : "Free forever"}
              billingLabel="Always free"
              testId="billing-plan-free"
            />
            <PricingCard
              name="Basic"
              price={formatPlanPrice(basicPlan, interval)}
              description="Unlock longer sessions and deeper recall."
              features={[
                "Up to 20 hours per week",
                "Up to 2 hours per meeting",
                "Ask across longer history",
                "Live voice mode",
              ]}
              cta={data.tier === "basic" ? "Current plan" : "Upgrade to Basic"}
              ctaDisabled={data.tier === "basic" || !basicPlan}
              ctaProps={
                data.tier === "basic"
                  ? { variant: "light" }
                  : { onClick: () => onCheckout("basic") }
              }
              highlighted
              badge={data.tier === "basic" ? "Current plan" : "Best value"}
              billingLabel={`${billingLabelForInterval(interval)}${
                interval === "year" ? ` - ${annualSavingsLabel}` : ""
              }`}
              testId="billing-plan-basic"
            />
            <PricingCard
              name="Pro"
              price={formatPlanPrice(proPlan, interval)}
              description="Unlimited retention and deep server memory."
              features={[
                "Unlimited retention",
                "Unlimited recording time",
                "Ask across full retention",
                "Up to 2 hours per meeting (8 hours coming soon)",
                "Priority features + support",
              ]}
              cta={data.tier === "pro" ? "Current plan" : "Upgrade to Pro"}
              ctaDisabled={data.tier === "pro" || !proPlan}
              ctaProps={
                data.tier === "pro"
                  ? { variant: "light" }
                  : { onClick: () => onCheckout("pro") }
              }
              badge={
                data.tier === "pro" ? "Current plan" : "Unlimited meetings"
              }
              tone="soft"
              borderColor={uiColors.accentBorder}
              borderWidth={uiBorders.accentWidth}
              billingLabel={`${billingLabelForInterval(interval)}${
                interval === "year" ? ` - ${annualSavingsLabel}` : ""
              }`}
              testId="billing-plan-pro"
            />
          </SimpleGrid>
        </Collapse>
      </Stack>
    </Surface>
  );
};

export function Billing() {
  const [showPlans, setShowPlans] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const search = useSearch({ from: "/portal/server/$serverId/billing" });
  const [promoCode, setPromoCode] = useState(() => search.promo ?? "");
  const { selectedGuildId, guilds, loading: guildLoading } = useGuildContext();
  const billingQuery = trpc.billing.me.useQuery(
    { serverId: selectedGuildId ?? undefined },
    { enabled: Boolean(selectedGuildId) },
  );
  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const checkoutMutation = trpc.billing.checkout.useMutation();
  const portalMutation = trpc.billing.portal.useMutation();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";

  const serverName = useMemo(
    () =>
      guilds.find((g) => g.id === selectedGuildId)?.name || "Unknown server",
    [guilds, selectedGuildId],
  );
  const data = billingQuery.data ?? null;
  const loading = billingQuery.isLoading || guildLoading;
  const error = billingQuery.error ? "Unable to load billing status." : null;
  const paidPlans = pricingQuery.data?.plans ?? [];
  const planLookup = useMemo(() => buildPaidPlanLookup(paidPlans), [paidPlans]);
  const basicPlan = resolvePaidPlan(planLookup, "basic", interval);
  const proPlan = resolvePaidPlan(planLookup, "pro", interval);
  const hasAnnualPlans = paidPlans.some((plan) => plan.interval === "year");
  const isPortalPending = portalMutation.isPending;
  const isFreeTier = data?.tier === "free";

  useEffect(() => {
    if (isFreeTier) {
      setShowPlans(true);
    }
  }, [isFreeTier]);

  const handleCheckout = async (tier: PaidTier) => {
    try {
      if (!selectedGuildId) return;
      const plan = resolvePaidPlan(planLookup, tier, interval);
      if (!plan) {
        notifications.show({
          color: "red",
          title: "Pricing unavailable",
          message: "We could not find pricing for that plan. Please try again.",
        });
        return;
      }
      const promotionCode = promoCode.trim();
      const body = await checkoutMutation.mutateAsync({
        serverId: selectedGuildId,
        tier,
        interval,
        promotionCode: promotionCode.length ? promotionCode : undefined,
      });
      window.location.href = body.url;
    } catch (err) {
      console.error(err);
      const errorMessage =
        err instanceof Error && err.message.includes("promotion")
          ? err.message
          : "Could not start checkout. Please try again.";
      notifications.show({
        color: "red",
        title: "Checkout failed",
        message: errorMessage,
      });
    }
  };

  const handlePortal = async () => {
    try {
      if (!selectedGuildId) return;
      const body = await portalMutation.mutateAsync({
        serverId: selectedGuildId,
      });
      window.location.href = body.url;
    } catch (err) {
      console.error(err);
      notifications.show({
        color: "red",
        title: "Billing portal failed",
        message: "Could not open billing portal. Please try again.",
      });
    }
  };

  if (loading) {
    return <BillingLoadingState />;
  }

  if (error) {
    return <BillingErrorState message={error} />;
  }

  if (!data) {
    return <BillingNoServerState />;
  }

  if (!data.billingEnabled) {
    return <BillingDisabledState />;
  }

  const statusLabel = formatStatusLabel(data.status);
  const statusLine = formatStatusLine(statusLabel, data.nextBillingDate);

  return (
    <BillingShell>
      {isFreeTier ? (
        <BillingFreePanel
          serverName={serverName}
          usage={data.usage}
          isDark={isDark}
        />
      ) : (
        <BillingPaidPanel
          data={data}
          serverName={serverName}
          statusLabel={statusLabel}
          statusLine={statusLine}
          usage={data.usage}
          isPortalPending={isPortalPending}
          canManage={Boolean(selectedGuildId)}
          onPortal={handlePortal}
          isDark={isDark}
        />
      )}
      <BillingPlansSection
        data={data}
        interval={interval}
        onIntervalChange={setInterval}
        hasAnnualPlans={hasAnnualPlans}
        showPlans={showPlans}
        onExpandPlans={() => setShowPlans(true)}
        onTogglePlans={() => setShowPlans((prev) => !prev)}
        onCheckout={handleCheckout}
        promoCode={promoCode}
        onPromoCodeChange={setPromoCode}
        basicPlan={basicPlan}
        proPlan={proPlan}
      />
    </BillingShell>
  );
}

export default Billing;
