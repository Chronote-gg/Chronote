import {
  Alert,
  Avatar,
  Box,
  Button,
  Container,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { track, isDoNotTrackEnabled } from "../services/analytics";
import { resolvePurchaseSource } from "../../utils/purchaseAnalytics";
import PricingCard from "../components/PricingCard";
import ServerPicker from "../components/ServerPicker";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";
import { showBillingError } from "../utils/billingErrorNotification";
import { usePortalStore } from "../stores/portalStore";
import type { PaidTier } from "../../types/pricing";
import {
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";

const FEATURES = {
  free: [
    "4 recording hours per rolling week",
    "Up to 90 minutes per meeting",
    "Ask across the last 5 meetings",
  ],
  basic: [
    "20 recording hours per rolling week",
    "Up to 2 hours per meeting",
    "Ask across the last 25 meetings",
  ],
  pro: [
    "No weekly recording limit",
    "Up to 2 hours per meeting",
    "Ask across the last 100 meetings",
  ],
};

export default function UpgradeServerSelect() {
  const navigate = useNavigate({ from: "/upgrade/select-server" });
  const search = useSearch({ strict: false });
  const { state: authState, loading: authLoading } = useAuth();
  const {
    guilds,
    loading: guildLoading,
    selectedGuildId,
    setSelectedGuildId,
    error: guildError,
    refresh,
  } = useGuildContext();
  const setLastServerId = usePortalStore((state) => state.setLastServerId);
  const [initialServerId] = useState(selectedGuildId);
  const selectedServerId = search.serverId ?? initialServerId;
  const [changingServer, setChangingServer] = useState(false);
  const [promoCode, setPromoCode] = useState(search.promo?.trim() ?? "");
  const interval = search.interval ?? "month";
  const source = resolvePurchaseSource(search.source);
  const eligibleGuilds = useMemo(
    () => guilds.filter((guild) => guild.canManage),
    [guilds],
  );
  const selectedServer = eligibleGuilds.find(
    (guild) => guild.id === selectedServerId,
  );
  const serverReady =
    authState === "authenticated" &&
    !guildLoading &&
    !guildError &&
    Boolean(selectedServer);
  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const billingQuery = trpc.billing.me.useQuery(
    { serverId: selectedServerId ?? undefined },
    { enabled: serverReady, retry: false },
  );
  const checkoutMutation = trpc.billing.checkout.useMutation();
  const portalMutation = trpc.billing.portal.useMutation();
  const planLookup = useMemo(
    () => buildPaidPlanLookup(pricingQuery.data?.plans ?? []),
    [pricingQuery.data],
  );
  const basicPlan = resolvePaidPlan(planLookup, "basic", interval);
  const proPlan = resolvePaidPlan(planLookup, "pro", interval);
  const billing =
    serverReady && !billingQuery.isError ? billingQuery.data : undefined;
  const currentTier = billing?.tier;
  const isComped = billing?.billingSource === "manual_comp";
  const isForced = billing?.billingSource === "forced";
  const managementOnly =
    isForced ||
    (billing?.hasStripeBilling && currentTier === "free") ||
    (currentTier === "pro" && !isComped);
  const busy = checkoutMutation.isPending || portalMutation.isPending;
  const purchaseReady =
    serverReady &&
    !changingServer &&
    Boolean(billing?.billingEnabled) &&
    !billingQuery.isFetching &&
    !pricingQuery.isError &&
    !managementOnly &&
    !busy;

  const arrived = useRef(false);
  const readyStates = useRef(new Set<string>());
  const lastBlocked = useRef<string | undefined>(undefined);
  const requestedPlan = search.plan ?? "basic";
  const requestedPrice = resolvePaidPlan(planLookup, requestedPlan, interval);
  const requestedTierEligible =
    requestedPlan === "pro" ||
    (currentTier !== "pro" && (currentTier !== "basic" || isComped));
  const blockedReason = authLoading
    ? undefined
    : authState !== "authenticated"
      ? "auth_required"
      : guildError
        ? "discovery_failed"
        : guildLoading
          ? undefined
          : !selectedServer
            ? selectedServerId
              ? "unavailable_server"
              : "server_required"
            : changingServer
              ? "server_required"
              : billingQuery.isError
                ? "billing_failed"
                : billingQuery.isFetching || !billing
                  ? undefined
                  : !billing.billingEnabled
                    ? "billing_disabled"
                    : managementOnly
                      ? "existing_billing"
                      : !requestedTierEligible
                        ? "current_plan"
                        : pricingQuery.isError
                          ? "pricing_failed"
                          : pricingQuery.isLoading
                            ? undefined
                            : !requestedPrice
                              ? "price_missing"
                              : undefined;
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    track("upgrade_arrived", {
      source,
      event_version: 1,
      canceled: Boolean(search.canceled),
    });
  }, [source, search.canceled]);
  useEffect(() => {
    const properties = {
      source,
      guild_id: serverReady ? selectedServerId : undefined,
      tier: requestedPlan,
      interval,
      promo_present: Boolean(promoCode.trim()),
      event_version: 1,
    };
    if (blockedReason && lastBlocked.current !== blockedReason) {
      track("upgrade_blocked", { ...properties, reason: blockedReason });
    }
    lastBlocked.current = blockedReason;
    const key = `${selectedServerId}:${requestedPlan}:${interval}:${source}`;
    if (
      purchaseReady &&
      requestedTierEligible &&
      requestedPrice &&
      !readyStates.current.has(key)
    ) {
      readyStates.current.add(key);
      track("upgrade_ready", properties);
    }
  }, [
    blockedReason,
    source,
    serverReady,
    selectedServerId,
    requestedPlan,
    interval,
    promoCode,
    purchaseReady,
    requestedPrice,
    requestedTierEligible,
  ]);

  useEffect(() => setPromoCode(search.promo?.trim() ?? ""), [search.promo]);
  useEffect(() => {
    if (!serverReady || !selectedServerId) return;
    if (selectedGuildId !== selectedServerId)
      setSelectedGuildId(selectedServerId);
    setLastServerId(selectedServerId);
  }, [
    serverReady,
    selectedServerId,
    selectedGuildId,
    setSelectedGuildId,
    setLastServerId,
  ]);

  const intent = {
    ...search,
    source,
    serverId: selectedServerId ?? undefined,
    interval,
    promo: promoCode.trim() || undefined,
  };
  const params = new URLSearchParams();
  if (intent.serverId) params.set("serverId", intent.serverId);
  if (intent.plan) params.set("plan", intent.plan);
  params.set("source", source);
  params.set("interval", intent.interval);
  if (intent.promo) params.set("promo", intent.promo);
  if (intent.canceled) params.set("canceled", "true");
  const returnUrl = `${window.location.origin}/upgrade/select-server?${params}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(returnUrl)}`;
  const handleAuthStarted = () =>
    track("upgrade_auth_started", {
      source,
      event_version: 1,
      promo_present: Boolean(intent.promo),
    });

  const chooseServer = (serverId: string) => {
    setChangingServer(false);
    navigate({ search: { ...intent, serverId } });
  };
  const handleCheckout = async (tier: PaidTier) => {
    if (
      !purchaseReady ||
      !selectedServerId ||
      !resolvePaidPlan(planLookup, tier, interval)
    )
      return;
    if (
      tier === "basic" &&
      (currentTier === "pro" || (currentTier === "basic" && !isComped))
    )
      return;
    // The clicked tier travels with the request, never through a state update.
    navigate({
      replace: true,
      search: { ...intent, plan: tier, canceled: undefined },
    });
    try {
      track("upgrade_plan_clicked", {
        guild_id: selectedServerId,
        tier,
        interval,
        source,
        promo_present: Boolean(intent.promo),
        event_version: 1,
      });
      const body = await checkoutMutation.mutateAsync({
        serverId: selectedServerId,
        tier,
        interval,
        promotionCode: intent.promo,
        source,
        ...(isDoNotTrackEnabled() ? { analyticsDisabled: true } : {}),
      });
      window.location.href = body.url;
    } catch (err) {
      showBillingError(err, "checkout");
    }
  };
  const handlePortal = async () => {
    if (!serverReady || !selectedServerId || busy) return;
    try {
      const body = await portalMutation.mutateAsync({
        serverId: selectedServerId,
      });
      window.location.href = body.url;
    } catch (err) {
      showBillingError(err, "portal");
    }
  };

  const currentPlanLabel = currentTier
    ? `Current plan: ${{ free: "Free", basic: "Basic", pro: "Pro" }[currentTier]}${isComped ? " (complimentary)" : isForced ? " (environment override)" : ""}`
    : "Checking current plan...";
  const serverIcon = selectedServer?.icon
    ? `https://cdn.discordapp.com/icons/${selectedServer.id}/${selectedServer.icon}.png`
    : undefined;
  const pickerTitle = guildLoading
    ? "Loading your servers..."
    : selectedServerId && !selectedServer
      ? "That server is unavailable"
      : "Choose your server";
  const pickerDescription =
    selectedServerId && !selectedServer && !guildLoading
      ? "It may belong to another account, or you may not have Manage Server permission. Choose a server below or switch your Discord account."
      : "Only servers you manage can be upgraded.";
  const billingDisabled = billing && !billing.billingEnabled;
  const showBillingManagement =
    billing && (billing.canManageBillingPortal || managementOnly);

  return (
    <Container size={1040} py={{ base: "md", md: "xl" }} px={0}>
      <Stack gap="xl" data-testid="upgrade-purchase">
        <Title
          order={1}
          fz={{ base: 30, md: 42 }}
          lh={1.15}
          style={{ letterSpacing: "-0.025em", textWrap: "balance" }}
        >
          More time for your meetings.
        </Title>
        {search.canceled && (
          <Alert color="gray" title="Checkout canceled">
            Your plan options are still here when you are ready to continue.
          </Alert>
        )}
        {authState !== "authenticated" ? (
          <Surface p="lg">
            <Stack gap="sm" align="flex-start">
              <Text fw={600}>Connect Discord to choose your server</Text>
              <Text size="sm" c="dimmed">
                One subscription covers everyone in a server you manage.
              </Text>
              <Button
                component="a"
                href={loginUrl}
                onClick={handleAuthStarted}
                loading={authLoading}
                rightSection={<IconArrowRight size={16} />}
              >
                Connect Discord
              </Button>
            </Stack>
          </Surface>
        ) : (
          <Surface p="lg">
            <Stack gap="md">
              {serverReady && (
                <Group justify="space-between">
                  <Group wrap="nowrap" style={{ minWidth: 0 }}>
                    <Avatar src={serverIcon} radius="md">
                      {selectedServer?.name.slice(0, 1)}
                    </Avatar>
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Text fw={600} style={{ overflowWrap: "anywhere" }}>
                        {selectedServer?.name}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {currentPlanLabel}
                      </Text>
                    </Stack>
                  </Group>
                  <Button
                    variant="subtle"
                    size="sm"
                    disabled={busy}
                    onClick={() => setChangingServer(!changingServer)}
                  >
                    {changingServer ? "Keep this server" : "Change server"}
                  </Button>
                </Group>
              )}
              {guildError ? (
                <Alert color="red" title="Servers unavailable">
                  <Stack gap="sm">
                    <Text size="sm">
                      {guildError === "auth"
                        ? "Reconnect Discord to load servers you manage."
                        : guildError}
                    </Text>
                    <Group>
                      <Button
                        size="sm"
                        variant="light"
                        onClick={() => void refresh()}
                      >
                        Retry servers
                      </Button>
                      <Button
                        size="sm"
                        component="a"
                        href={loginUrl}
                        onClick={handleAuthStarted}
                      >
                        Reconnect Discord
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              ) : (
                (!serverReady || changingServer) && (
                  <>
                    <Text fw={600}>{pickerTitle}</Text>
                    <Text size="sm" c="dimmed">
                      {pickerDescription}
                    </Text>
                    <ServerPicker
                      guilds={eligibleGuilds}
                      loading={guildLoading}
                      selectedGuildId={selectedServerId}
                      onSelect={chooseServer}
                      actionLabel={() => "Select server"}
                      emptyTitle="No eligible servers"
                      emptyDescription="You need Manage Server permission to upgrade a server."
                      searchPlaceholder="Search managed servers"
                      rootTestId="upgrade-server-select"
                      cardTestId="upgrade-server-card"
                      actionTestId="upgrade-server-open"
                    />
                  </>
                )
              )}
              {serverReady && billingQuery.isError && (
                <Alert color="red" title="Billing status unavailable">
                  <Stack gap="sm">
                    <Text size="sm">
                      We couldn’t check this server’s current plan.
                    </Text>
                    <Button
                      size="sm"
                      variant="light"
                      onClick={() => void billingQuery.refetch()}
                    >
                      Retry billing
                    </Button>
                  </Stack>
                </Alert>
              )}
              {billingDisabled && (
                <Alert color="yellow" title="Billing disabled">
                  Billing is not enabled in this environment.
                </Alert>
              )}
              {showBillingManagement && (
                <Stack gap="sm">
                  <Text size="sm">
                    {managementOnly
                      ? "Review this server’s existing plan in its billing settings."
                      : "Existing subscription changes remain subject to billing confirmation."}
                  </Text>
                  <Group>
                    {billing.canManageBillingPortal && (
                      <Button
                        variant="light"
                        onClick={handlePortal}
                        loading={portalMutation.isPending}
                        disabled={busy}
                      >
                        Manage billing
                      </Button>
                    )}
                    <Button
                      variant="subtle"
                      onClick={() =>
                        navigate({
                          to: "/portal/server/$serverId/billing",
                          params: { serverId: selectedServerId! },
                        })
                      }
                    >
                      Open server billing
                    </Button>
                  </Group>
                </Stack>
              )}
            </Stack>
          </Surface>
        )}
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              Per server, not per member.
            </Text>
            <SegmentedControl
              aria-label="Billing period"
              value={interval}
              onChange={(value) =>
                navigate({
                  search: {
                    ...intent,
                    interval: value === "year" ? "year" : "month",
                  },
                })
              }
              data={[
                { label: "Monthly", value: "month" },
                {
                  label: "Annual",
                  value: "year",
                  disabled: !planLookup.basic.year && !planLookup.pro.year,
                },
              ]}
              disabled={busy}
            />
          </Group>
          {pricingQuery.isError && (
            <Alert color="red" title="Pricing unavailable">
              <Stack gap="sm">
                <Text size="sm">Please try again before continuing.</Text>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => void pricingQuery.refetch()}
                >
                  Retry pricing
                </Button>
              </Stack>
            </Alert>
          )}
          <SimpleGrid
            cols={{ base: 1, lg: 3 }}
            spacing="md"
            data-testid="upgrade-plans"
          >
            <PricingCard
              name="Free"
              price="$0"
              description="For occasional meetings."
              features={FEATURES.free}
              badge={
                currentTier === "free" && !billing?.hasStripeBilling
                  ? "Current plan"
                  : "Free plan"
              }
              billingLabel="No subscription needed"
              tone="soft"
              testId="upgrade-plan-free"
            />
            <PricingCard
              name="Basic"
              price={formatPlanPrice(basicPlan, interval)}
              description="For regular meetings."
              features={FEATURES.basic}
              highlighted
              badge={currentTier === "basic" ? "Current plan" : "Recommended"}
              billingLabel={billingLabelForInterval(interval)}
              cta={
                currentTier === "basic" && !isComped
                  ? "Current plan"
                  : "Continue with Basic"
              }
              ctaDisabled={
                !purchaseReady ||
                !basicPlan ||
                currentTier === "pro" ||
                (currentTier === "basic" && !isComped)
              }
              ctaProps={{
                variant: "filled",
                onClick: () => void handleCheckout("basic"),
                rightSection: <IconArrowRight size={16} />,
              }}
              testId="upgrade-plan-basic"
            />
            <PricingCard
              name="Pro"
              price={formatPlanPrice(proPlan, interval)}
              description="For busy servers."
              features={FEATURES.pro}
              badge={currentTier === "pro" ? "Current plan" : undefined}
              billingLabel={billingLabelForInterval(interval)}
              cta="Continue with Pro"
              ctaDisabled={!purchaseReady || !proPlan}
              ctaProps={{
                variant: "outline",
                onClick: () => void handleCheckout("pro"),
                rightSection: <IconArrowRight size={16} />,
              }}
              testId="upgrade-plan-pro"
            />
          </SimpleGrid>
          <Box component="details" open={intent.promo ? true : undefined}>
            <Text component="summary" size="sm" style={{ cursor: "pointer" }}>
              Have a code?{intent.promo ? " (code entered)" : ""}
            </Text>
            <TextInput
              mt="sm"
              maw={360}
              label="Promo code"
              className="ph-no-capture"
              value={promoCode}
              disabled={busy}
              onChange={(event) => setPromoCode(event.currentTarget.value)}
              onBlur={() => navigate({ replace: true, search: intent })}
              description="Eligibility and discounts are confirmed at checkout."
            />
          </Box>
          <Text size="sm" c="dimmed">
            Payment is handled securely by Stripe. Any available changes and
            discounts are confirmed before payment.
          </Text>
          <Text size="sm" c="dimmed">
            Your subscription helps keep Chronote running.
          </Text>
        </Stack>
      </Stack>
    </Container>
  );
}
