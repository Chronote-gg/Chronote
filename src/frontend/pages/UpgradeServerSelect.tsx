import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  List,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconCreditCard,
  IconRocket,
  IconSparkles,
  IconTicket,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import PageHeader from "../components/PageHeader";
import ServerPicker from "../components/ServerPicker";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";
import { usePortalStore } from "../stores/portalStore";
import { heroBackground, uiBorders, uiColors, uiTypography } from "../uiTokens";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import {
  annualSavingsLabel,
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";

const BASIC_FEATURES = [
  "Up to 20 hours per week",
  "Up to 2 hours per meeting",
  "Ask across longer history",
  "Live voice mode",
];

const PRO_FEATURES = [
  "Unlimited retention",
  "Unlimited recording time",
  "Ask across full retention",
  "Up to 2 hours per meeting (8 hours coming soon)",
  "Priority features and support",
];

const buildUpgradeQuery = (options: {
  promo?: string;
  serverId?: string;
  plan?: PaidTier;
  interval?: BillingInterval;
  canceled?: boolean;
}) => {
  const params = new URLSearchParams();
  if (options.promo) params.set("promo", options.promo);
  if (options.serverId) params.set("serverId", options.serverId);
  if (options.plan) params.set("plan", options.plan);
  if (options.interval) params.set("interval", options.interval);
  if (options.canceled) params.set("canceled", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
};

export default function UpgradeServerSelect() {
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const navigate = useNavigate({ from: "/upgrade/select-server" });
  const search = useSearch({ strict: false }) as {
    promo?: string;
    serverId?: string;
    plan?: PaidTier;
    interval?: BillingInterval;
    canceled?: boolean;
  };
  const { state: authState, loading: authLoading } = useAuth();
  const {
    guilds,
    loading: guildLoading,
    selectedGuildId,
    setSelectedGuildId,
    error: guildError,
  } = useGuildContext();
  const setLastServerId = usePortalStore((state) => state.setLastServerId);
  const [promoCode, setPromoCode] = useState(search.promo?.trim() ?? "");
  const [interval, setInterval] = useState<BillingInterval>(
    search.interval ?? "month",
  );
  const [selectedPlan, setSelectedPlan] = useState<PaidTier>(
    search.plan ?? "pro",
  );
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    search.serverId ?? selectedGuildId ?? null,
  );

  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const billingQuery = trpc.billing.me.useQuery(
    { serverId: selectedServerId ?? undefined },
    {
      enabled:
        authState === "authenticated" && Boolean(selectedServerId?.length),
    },
  );
  const checkoutMutation = trpc.billing.checkout.useMutation();
  const portalMutation = trpc.billing.portal.useMutation();

  const eligibleGuilds = useMemo(
    () => guilds.filter((guild) => guild.canManage),
    [guilds],
  );
  const paidPlans = pricingQuery.data?.plans ?? [];
  const planLookup = useMemo(() => buildPaidPlanLookup(paidPlans), [paidPlans]);
  const basicPlan = resolvePaidPlan(planLookup, "basic", interval);
  const proPlan = resolvePaidPlan(planLookup, "pro", interval);
  const hasAnnualPlans = paidPlans.some((plan) => plan.interval === "year");
  const billingData = billingQuery.data;
  const currentTier = billingData?.tier ?? "free";
  const billingEnabled = billingData?.billingEnabled ?? false;
  const isAlreadyPro = currentTier === "pro";
  const isAlreadyBasic = currentTier === "basic";

  useEffect(() => {
    if (!search.serverId) return;
    if (search.serverId === selectedServerId) return;
    setSelectedServerId(search.serverId);
  }, [search.serverId, selectedServerId]);

  useEffect(() => {
    if (selectedServerId && selectedGuildId !== selectedServerId) {
      setSelectedGuildId(selectedServerId);
    }
  }, [selectedServerId, selectedGuildId, setSelectedGuildId]);

  useEffect(() => {
    if (selectedServerId) {
      setLastServerId(selectedServerId);
    }
  }, [selectedServerId, setLastServerId]);

  useEffect(() => {
    if (!billingData) return;
    if (billingData.tier === "pro") {
      setSelectedPlan("pro");
      return;
    }
    if (billingData.tier === "basic" && selectedPlan === "basic") {
      setSelectedPlan("pro");
    }
  }, [billingData, selectedPlan]);

  const promoQuery = buildUpgradeQuery({
    promo: promoCode || undefined,
    serverId: search.serverId,
    plan: search.plan,
    interval: search.interval,
    canceled: search.canceled,
  });

  const redirectTarget = `${window.location.origin}/upgrade/select-server${promoQuery}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    redirectTarget,
  )}`;

  const selectedServer = eligibleGuilds.find(
    (guild) => guild.id === selectedServerId,
  );
  const serverLabel = selectedServer?.name ?? "your server";

  const handleSelectServer = (serverId: string) => {
    setSelectedServerId(serverId);
    navigate({
      search: (prev) => ({ ...prev, serverId }),
    });
  };

  const handlePlanChange = (nextPlan: PaidTier) => {
    setSelectedPlan(nextPlan);
    navigate({
      search: (prev) => ({ ...prev, plan: nextPlan }),
    });
  };

  const handleIntervalChange = (next: BillingInterval) => {
    setInterval(next);
    navigate({
      search: (prev) => ({ ...prev, interval: next }),
    });
  };

  const handleCheckout = async () => {
    try {
      if (!selectedServerId) return;
      const plan = resolvePaidPlan(planLookup, selectedPlan, interval);
      if (!plan) {
        notifications.show({
          color: "red",
          title: "Pricing unavailable",
          message:
            "We could not find pricing for that plan. Please try again later.",
        });
        return;
      }
      const promotionCode = promoCode.trim();
      const body = await checkoutMutation.mutateAsync({
        serverId: selectedServerId,
        tier: selectedPlan,
        interval,
        promotionCode: promotionCode.length ? promotionCode : undefined,
      });
      window.location.href = body.url;
    } catch (err) {
      console.error(err);
      const rawMessage = String(err ?? "");
      const errorMessage = rawMessage.includes("promotion")
        ? rawMessage
        : "Could not start checkout. Please try again.";
      notifications.show({
        color: "red",
        title: "Checkout failed",
        message: errorMessage,
      });
    }
  };

  const handlePortal = async () => {
    if (!selectedServerId) return;
    try {
      const body = await portalMutation.mutateAsync({
        serverId: selectedServerId,
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

  return (
    <Stack gap="xl">
      <Surface
        p={{ base: "lg", md: "xl" }}
        tone="raised"
        style={{ backgroundImage: heroBackground(isDark) }}
      >
        <Stack gap="md">
          <Text size="xs" c="dimmed" style={uiTypography.heroKicker}>
            Upgrade flow
          </Text>
          <Title order={2}>Choose the server to upgrade.</Title>
          <Text c="dimmed" size="sm">
            Pick a server and plan, we will take you straight to Stripe to
            confirm the upgrade.
          </Text>
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
          {search.canceled ? (
            <Group gap="xs">
              <ThemeIcon color="yellow" variant="light" size="sm">
                <IconAlertTriangle size={14} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                Checkout canceled. You can pick a server to try again.
              </Text>
            </Group>
          ) : null}
        </Stack>
      </Surface>

      {authState === "unauthenticated" ? (
        <Surface p="xl" tone="soft">
          <Stack gap="sm">
            <Text fw={600}>Connect Discord to continue</Text>
            <Text size="sm" c="dimmed">
              We use Discord to map your subscription to the correct server.
            </Text>
            <Button
              component="a"
              href={loginUrl}
              rightSection={<IconArrowRight size={16} />}
              loading={authLoading}
            >
              Connect Discord
            </Button>
          </Stack>
        </Surface>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
          <Stack gap="lg">
            <PageHeader
              title="Select a server"
              description="Only servers you manage are eligible for upgrades."
            />
            {guildError ? (
              <Surface p="lg" tone="soft">
                <Text size="sm" c="dimmed">
                  {guildError === "auth"
                    ? "Please reconnect to Discord to view your servers."
                    : guildError}
                </Text>
              </Surface>
            ) : (
              <ServerPicker
                guilds={eligibleGuilds}
                loading={guildLoading}
                selectedGuildId={selectedServerId}
                onSelect={handleSelectServer}
                actionLabel={() => "Select server"}
                emptyTitle="No eligible servers"
                emptyDescription="You need Manage Server permission to upgrade a server."
                searchPlaceholder="Search managed servers"
                rootTestId="upgrade-server-select"
                cardTestId="upgrade-server-card"
                actionTestId="upgrade-server-open"
              />
            )}
          </Stack>

          <Stack gap="lg">
            <PageHeader
              title="Choose a plan"
              description="Upgrade instantly, keep your existing data and history."
            />
            {!selectedServerId ? (
              <Surface p="xl" tone="soft">
                <Stack gap="xs">
                  <Text fw={600}>Pick a server to continue</Text>
                  <Text size="sm" c="dimmed">
                    Select the server you want to upgrade to see plan options.
                  </Text>
                </Stack>
              </Surface>
            ) : billingQuery.isLoading ? (
              <Surface p="xl" tone="soft">
                <Group gap="sm">
                  <ThemeIcon color="brand" variant="light">
                    <IconSparkles size={18} />
                  </ThemeIcon>
                  <Text c="dimmed">
                    Loading plan details for {serverLabel}...
                  </Text>
                </Group>
              </Surface>
            ) : !billingEnabled ? (
              <Alert color="yellow" title="Billing disabled">
                Billing is not enabled in this environment.
              </Alert>
            ) : isAlreadyPro ? (
              <Surface p="xl" tone="soft">
                <Stack gap="sm">
                  <Group gap="sm" align="center">
                    <ThemeIcon color="brand" variant="light">
                      <IconSparkles size={18} />
                    </ThemeIcon>
                    <Text fw={600}>{serverLabel} is already on Pro.</Text>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Manage billing or head back to the server portal.
                  </Text>
                  <Group gap="sm">
                    <Button
                      variant="gradient"
                      gradient={{ from: "brand", to: "violet" }}
                      onClick={handlePortal}
                      loading={portalMutation.isPending}
                    >
                      Manage billing
                    </Button>
                    <Button
                      variant="light"
                      onClick={() =>
                        navigate({
                          to: "/portal/server/$serverId/library",
                          params: { serverId: selectedServerId },
                        })
                      }
                    >
                      Open server
                    </Button>
                  </Group>
                </Stack>
              </Surface>
            ) : (
              <Stack gap="lg">
                <Surface p="lg" tone="soft">
                  <Stack gap="sm">
                    <Group gap="sm" align="center" justify="space-between">
                      <Group gap="sm" align="center">
                        <ThemeIcon color="brand" variant="light">
                          <IconCreditCard size={18} />
                        </ThemeIcon>
                        <Text fw={600}>Upgrade {serverLabel}</Text>
                      </Group>
                      <SegmentedControl
                        size="sm"
                        value={interval}
                        onChange={(value) =>
                          handleIntervalChange(value as BillingInterval)
                        }
                        data={[
                          { label: "Monthly", value: "month" },
                          {
                            label: "Annual (best value)",
                            value: "year",
                            disabled: !hasAnnualPlans,
                          },
                        ]}
                      />
                    </Group>
                    <TextInput
                      label="Promo code"
                      placeholder="Enter code"
                      value={promoCode}
                      onChange={(event) =>
                        setPromoCode(event.currentTarget.value)
                      }
                    />
                    <Text size="xs" c="dimmed">
                      Applied at checkout. One code per purchase.
                    </Text>
                  </Stack>
                </Surface>

                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                  <Surface
                    p="lg"
                    tone="soft"
                    h="100%"
                    style={{
                      borderWidth:
                        selectedPlan === "basic"
                          ? uiBorders.highlightWidth
                          : undefined,
                      borderColor:
                        selectedPlan === "basic"
                          ? uiColors.highlightBorder
                          : undefined,
                    }}
                  >
                    <Stack gap="sm" h="100%">
                      <Group gap="sm" align="center" justify="space-between">
                        <Group gap="sm" align="center">
                          <ThemeIcon color="brand" variant="light">
                            <IconCheck size={18} />
                          </ThemeIcon>
                          <Title order={4}>Basic</Title>
                        </Group>
                        {selectedPlan === "basic" ? (
                          <Badge color="brand" variant="light" size="sm">
                            Selected
                          </Badge>
                        ) : null}
                      </Group>
                      <Text size="sm" c="dimmed">
                        Unlock longer sessions and deeper recall.
                      </Text>
                      <Text fw={700} size="xl">
                        {formatPlanPrice(basicPlan, interval)}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {billingLabelForInterval(interval)}
                        {interval === "year" ? `, ${annualSavingsLabel}` : ""}
                      </Text>
                      <List
                        spacing="xs"
                        size="sm"
                        icon={
                          <ThemeIcon color="brand" size={20}>
                            <IconCheck size={12} />
                          </ThemeIcon>
                        }
                      >
                        {BASIC_FEATURES.map((feature) => (
                          <List.Item key={feature}>{feature}</List.Item>
                        ))}
                      </List>
                      <Button
                        mt="auto"
                        variant={selectedPlan === "basic" ? "light" : "outline"}
                        onClick={() => handlePlanChange("basic")}
                        disabled={isAlreadyBasic || !basicPlan}
                      >
                        {isAlreadyBasic
                          ? "Current plan"
                          : selectedPlan === "basic"
                            ? "Selected"
                            : "Select Basic"}
                      </Button>
                    </Stack>
                  </Surface>

                  <Surface
                    p="lg"
                    tone="raised"
                    h="100%"
                    style={{
                      borderWidth:
                        selectedPlan === "pro"
                          ? uiBorders.highlightWidth
                          : uiBorders.defaultWidth,
                      borderColor:
                        selectedPlan === "pro"
                          ? uiColors.highlightBorder
                          : uiColors.accentBorder,
                    }}
                  >
                    <Stack gap="sm" h="100%">
                      <Group gap="sm" align="center" justify="space-between">
                        <Group gap="sm" align="center">
                          <ThemeIcon color="brand" variant="light">
                            <IconRocket size={18} />
                          </ThemeIcon>
                          <Title order={4}>Pro</Title>
                        </Group>
                        <Group gap="xs">
                          <Badge
                            variant="gradient"
                            gradient={{ from: "brand", to: "violet" }}
                            size="sm"
                          >
                            Recommended
                          </Badge>
                          {selectedPlan === "pro" ? (
                            <Badge color="brand" variant="light" size="sm">
                              Selected
                            </Badge>
                          ) : null}
                        </Group>
                      </Group>
                      <Text size="sm" c="dimmed">
                        Unlimited retention with priority features.
                      </Text>
                      <Text fw={700} size="xl">
                        {formatPlanPrice(proPlan, interval)}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {billingLabelForInterval(interval)}
                        {interval === "year" ? `, ${annualSavingsLabel}` : ""}
                      </Text>
                      <List
                        spacing="xs"
                        size="sm"
                        icon={
                          <ThemeIcon color="brand" size={20}>
                            <IconCheck size={12} />
                          </ThemeIcon>
                        }
                      >
                        {PRO_FEATURES.map((feature) => (
                          <List.Item key={feature}>{feature}</List.Item>
                        ))}
                      </List>
                      <Button
                        mt="auto"
                        variant={
                          selectedPlan === "pro" ? "gradient" : "outline"
                        }
                        gradient={{ from: "brand", to: "violet" }}
                        onClick={() => handlePlanChange("pro")}
                        disabled={!proPlan}
                        rightSection={<IconSparkles size={16} />}
                      >
                        {selectedPlan === "pro" ? "Selected" : "Select Pro"}
                      </Button>
                    </Stack>
                  </Surface>
                </SimpleGrid>

                <Divider />

                <Surface p="lg" tone="raised">
                  <Stack gap="sm">
                    <Group gap="sm" align="center">
                      <ThemeIcon color="brand" variant="light">
                        <IconCreditCard size={18} />
                      </ThemeIcon>
                      <Text fw={600}>Ready to continue</Text>
                    </Group>
                    <Text size="sm" c="dimmed">
                      Stripe confirms your discount and the prorated upgrade
                      before you pay.
                    </Text>
                    <Button
                      size="lg"
                      fullWidth
                      variant="gradient"
                      gradient={{ from: "brand", to: "violet" }}
                      rightSection={<IconArrowRight size={18} />}
                      onClick={handleCheckout}
                      disabled={isAlreadyPro}
                      loading={checkoutMutation.isPending}
                    >
                      {`Continue to Stripe (${
                        selectedPlan === "pro" ? "Pro" : "Basic"
                      })`}
                    </Button>
                    <Text size="xs" c="dimmed" ta="center">
                      You can change or cancel anytime in the billing portal.
                    </Text>
                  </Stack>
                </Surface>
              </Stack>
            )}
          </Stack>
        </SimpleGrid>
      )}
    </Stack>
  );
}
