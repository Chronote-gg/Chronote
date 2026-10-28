import { useIntroOfferExpiry } from "../hooks/useIntroOfferExpiry";
import {
  isTerminalStripeHistory,
  requiresStripeManagement,
} from "../utils/billingManagement";
import RecordingPlanContext from "../components/RecordingPlanContext";
import CheckoutRecovery, {
  IntroOfferAvailability,
} from "../components/CheckoutRecovery";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { track, isDoNotTrackEnabled } from "../services/analytics";
import {
  resolvePurchaseSource,
  resolveRecordingLimitContext,
  recordingLimitAnalytics,
} from "../../utils/purchaseAnalytics";
import PricingCard from "../components/PricingCard";
import BasicIntroTerms from "../components/BasicIntroTerms";
import IntroPromotionChoice from "../components/IntroPromotionChoice";
import type { inferRouterInputs } from "@trpc/server";
import type { AppRouter } from "../../trpc/router";
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
  introOfferPrice,
  resolveIntroOffer,
  resolvePaidPlan,
} from "../utils/pricing";
import classes from "./UpgradeServerSelect.module.css";
import { useCheckoutAttempt } from "../hooks/useCheckoutAttempt";
import { useIntroOfferExposure } from "../hooks/useIntroOfferExposure";

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

export default function UpgradeServerSelect({
  from = "/upgrade/select-server",
}: {
  from?: "/upgrade" | "/upgrade/select-server";
}) {
  const navigate = useNavigate({ from });
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
  const limitContext = useMemo(
    () => resolveRecordingLimitContext(search),
    [search.limitType, search.limitSurface],
  );
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
  const liveOffers = useIntroOfferExpiry(billing, () =>
    Promise.allSettled([billingQuery.refetch(), pricingQuery.refetch()]),
  );
  const offerChoice = promoCode.trim()
    ? (search.offerChoice ?? "automatic")
    : "automatic";
  const attemptIdentity = JSON.stringify([
    selectedServerId,
    search.plan,
    interval,
    offerChoice,
    promoCode.trim(),
    source,
    limitContext,
  ]);
  const checkoutAttempt = useCheckoutAttempt(attemptIdentity, () =>
    Promise.allSettled([billingQuery.refetch(), pricingQuery.refetch()]),
  );
  const failedCheckout = checkoutAttempt.attempt?.request ?? null;
  const frozenOffer = checkoutAttempt.attempt?.offer ?? null;
  const offer =
    frozenOffer ??
    resolveIntroOffer(
      interval === "year" ? liveOffers.annualIntroOffer : liveOffers.introOffer,
      basicPlan,
    );
  const shownOffer =
    offerChoice === "promotion" && promoCode.trim()
      ? { status: "inactive" as const }
      : offer;
  const offerBlocked = offer.status === "unavailable";
  const displayedOffer =
    shownOffer.status === "available" ? shownOffer.id : "none";
  useIntroOfferExposure({
    offer: displayedOffer,
    entry: `${from}:${selectedServerId ?? "unresolved"}`,
    surface: "upgrade",
    guildId: serverReady ? (selectedServerId ?? undefined) : undefined,
    enabled: serverReady && !changingServer,
  });
  const currentTier = billing?.tier;
  const isComped = billing?.billingSource === "manual_comp";
  const isForced = billing?.billingSource === "forced";
  const basicTierEligible =
    currentTier !== "pro" && (currentTier !== "basic" || isComped);
  const terminalHistory = Boolean(billing && isTerminalStripeHistory(billing));
  const managementOnly =
    isForced ||
    (billing && requiresStripeManagement(billing)) ||
    (currentTier === "pro" && !isComped);
  const busy = checkoutMutation.isPending || portalMutation.isPending;
  const purchaseReady =
    serverReady &&
    !changingServer &&
    Boolean(billing?.billingEnabled) &&
    !billingQuery.isFetching &&
    !pricingQuery.isError &&
    !pricingQuery.isFetching &&
    !managementOnly &&
    !checkoutAttempt.refreshing &&
    !busy;

  const basicActionEnabled =
    purchaseReady &&
    Boolean(basicPlan) &&
    basicTierEligible &&
    !offerBlocked &&
    !failedCheckout;
  const proActionEnabled = purchaseReady && Boolean(proPlan) && !failedCheckout;

  const arrived = useRef(false);
  const readyStates = useRef(new Set<string>());
  const lastBlocked = useRef<string | undefined>(undefined);
  const requestedPlan =
    search.plan ?? (basicTierEligible && basicPlan ? "basic" : "pro");
  const requestedPrice = resolvePaidPlan(planLookup, requestedPlan, interval);
  const requestedTierEligible = requestedPlan === "pro" || basicTierEligible;
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
      ...recordingLimitAnalytics(limitContext ?? {}),
      event_version: 1,
      canceled: Boolean(search.canceled),
    });
  }, [source, search.canceled, limitContext]);
  useEffect(() => {
    const properties = {
      source,
      ...recordingLimitAnalytics(limitContext ?? {}),
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
    const key = `${selectedServerId}:${requestedPlan}:${interval}:${source}:${displayedOffer}`;
    if (
      (requestedPlan === "basic" ? basicActionEnabled : proActionEnabled) &&
      !readyStates.current.has(key)
    ) {
      readyStates.current.add(key);
      track("upgrade_ready", {
        ...properties,
        offer: requestedPlan === "basic" ? displayedOffer : "none",
      });
    }
  }, [
    limitContext,
    blockedReason,
    source,
    serverReady,
    selectedServerId,
    requestedPlan,
    interval,
    promoCode,
    basicActionEnabled,
    proActionEnabled,
    displayedOffer,
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
    limitType: limitContext?.limitType,
    limitSurface: limitContext?.limitSurface,
    source,
    serverId: selectedServerId ?? undefined,
    interval,
    promo: promoCode.trim() || undefined,
  };
  const params = new URLSearchParams();
  if (intent.serverId) params.set("serverId", intent.serverId);
  if (intent.plan) params.set("plan", intent.plan);
  params.set("source", source);
  if (limitContext) {
    params.set("limitType", limitContext.limitType);
    params.set("limitSurface", limitContext.limitSurface);
  }
  params.set("interval", intent.interval);
  if (intent.promo) params.set("promo", intent.promo);
  params.set("offerChoice", offerChoice);
  if (intent.canceled) params.set("canceled", "true");
  const returnUrl = `${window.location.origin}/upgrade/select-server?${params}`;
  const loginUrl = `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(returnUrl)}`;
  const handleAuthStarted = () =>
    track("upgrade_auth_started", {
      source,
      ...recordingLimitAnalytics(limitContext ?? {}),
      event_version: 1,
      promo_present: Boolean(intent.promo),
    });

  const chooseServer = (serverId: string) => {
    setChangingServer(false);
    navigate({ search: { ...intent, serverId } });
  };
  const handleCheckout = async (tier: PaidTier) => {
    if (
      !selectedServerId ||
      !(tier === "basic" ? basicActionEnabled : proActionEnabled)
    )
      return;
    // The clicked tier travels with the request, never through a state update.
    await navigate({
      replace: true,
      search: { ...intent, plan: tier, canceled: undefined },
    });
    let attempt: ReturnType<typeof checkoutAttempt.begin> | null = null;
    try {
      track("upgrade_plan_clicked", {
        guild_id: selectedServerId,
        tier,
        interval,
        source,
        ...recordingLimitAnalytics(limitContext ?? {}),
        promo_present: Boolean(intent.promo),
        offer: tier === "basic" ? displayedOffer : "none",
        event_version: 1,
      });
      const request: inferRouterInputs<AppRouter>["billing"]["checkout"] = {
        serverId: selectedServerId,
        tier,
        interval,
        promotionCode:
          tier === "basic" &&
          offer.status === "available" &&
          offerChoice === "automatic"
            ? undefined
            : intent.promo,
        savedPromotionCode: intent.promo,
        expectedOffer:
          tier === "basic" &&
          offer.status === "available" &&
          offerChoice === "automatic"
            ? offer.id
            : "none",
        offerChoice,
        source,
        ...limitContext,
        ...(isDoNotTrackEnabled() ? { analyticsDisabled: true } : {}),
      };
      attempt = checkoutAttempt.begin(request, offer);
      const body = await checkoutMutation.mutateAsync(request);
      if (checkoutAttempt.isCurrent(attempt)) window.location.href = body.url;
    } catch (err) {
      if (attempt && checkoutAttempt.isCurrent(attempt))
        showBillingError(err, "checkout");
    }
  };
  const retryCheckout = () => {
    if (busy || !serverReady) return;
    void checkoutAttempt.retry(checkoutMutation.mutateAsync);
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

  const guildErrorText =
    guildError === "auth"
      ? "Reconnect Discord to load servers you manage."
      : guildError;
  const toggleServerPicker = () => setChangingServer(!changingServer);
  const refreshServers = () => void refresh();
  const retryBilling = () => void billingQuery.refetch();
  const billingManagementMessage = terminalHistory
    ? "Billing history and payment methods remain available."
    : managementOnly
      ? "Review this server’s existing plan in its billing settings."
      : "Existing subscription changes remain subject to billing confirmation.";
  const billingManagementAction = terminalHistory
    ? "View billing history"
    : "Manage billing";
  return (
    <Container
      size={1040}
      py={{ base: "md", md: "xl" }}
      px={0}
      style={{ containerType: "inline-size" }}
    >
      <Stack gap="xl" data-testid="upgrade-purchase">
        <Title
          order={1}
          fz={{ base: 30, md: 42 }}
          lh={1.15}
          style={{ letterSpacing: "-0.025em", textWrap: "balance" }}
        >
          Upgrade your plan
        </Title>
        <Text c="dimmed">Your subscription helps keep Chronote running.</Text>
        <RecordingPlanContext context={limitContext} />
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
                    disabled={busy || Boolean(failedCheckout)}
                    onClick={toggleServerPicker}
                  >
                    {changingServer ? "Keep this server" : "Change server"}
                  </Button>
                </Group>
              )}
              {guildError ? (
                <Alert color="red" title="Servers unavailable">
                  <Stack gap="sm">
                    <Text size="sm">{guildErrorText}</Text>
                    <Group>
                      <Button
                        size="sm"
                        variant="light"
                        onClick={refreshServers}
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
                    <Button size="sm" variant="light" onClick={retryBilling}>
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
                  <Text size="sm">{billingManagementMessage}</Text>
                  <Group>
                    {billing.canManageBillingPortal && (
                      <Button
                        variant="light"
                        onClick={handlePortal}
                        loading={portalMutation.isPending}
                        disabled={busy}
                      >
                        {billingManagementAction}
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
          <Stack gap="xs" align="center">
            <SegmentedControl
              aria-label="Billing period"
              data-testid="upgrade-billing-period"
              classNames={{
                root: classes.billingPeriod,
                control: classes.control,
                label: classes.label,
              }}
              size="lg"
              radius="lg"
              color="brand"
              withItemsBorders={false}
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
              disabled={busy || Boolean(failedCheckout)}
            />
          </Stack>
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
          <div className={classes.plans} data-testid="upgrade-plans">
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
              billingLabel="Always free"
              tone="soft"
              testId="upgrade-plan-free"
            />
            <PricingCard
              name="Basic"
              price={introOfferPrice(shownOffer, basicPlan, interval)}
              description="For regular meetings."
              features={FEATURES.basic}
              highlighted
              badge={currentTier === "basic" ? "Current plan" : "Recommended"}
              billingLabel={
                offerChoice === "promotion" && promoCode.trim()
                  ? "Promotion price confirmed at checkout"
                  : billingLabelForInterval(interval)
              }
              terms={<BasicIntroTerms offer={shownOffer} />}
              introOffer={shownOffer}
              cta={
                currentTier === "basic" && !isComped
                  ? "Current plan"
                  : "Continue with Basic"
              }
              ctaDisabled={!basicActionEnabled}
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
              ctaDisabled={!proActionEnabled}
              ctaProps={{
                variant: "outline",
                onClick: () => void handleCheckout("pro"),
                rightSection: <IconArrowRight size={16} />,
              }}
              testId="upgrade-plan-pro"
            />
          </div>
          <IntroOfferAvailability offer={offer} />
          <CheckoutRecovery
            offer={offer}
            checkoutFailed={Boolean(failedCheckout)}
            retryDisabled={busy || !serverReady}
            refreshDisabled={busy}
            onRetry={retryCheckout}
            onRefresh={checkoutAttempt.refresh}
          />
          {!managementOnly && offer.status === "available" && intent.promo && (
            <IntroPromotionChoice
              choice={offerChoice}
              disabled={busy || Boolean(failedCheckout)}
              onChange={(value) =>
                navigate({
                  replace: true,
                  search: { ...intent, offerChoice: value },
                })
              }
            />
          )}
          {!managementOnly && (
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
                disabled={busy || Boolean(failedCheckout)}
                onChange={(event) => setPromoCode(event.currentTarget.value)}
                onBlur={() => navigate({ replace: true, search: intent })}
                description="Eligibility and discounts are confirmed at checkout."
              />
            </Box>
          )}
          <Text size="sm" c="dimmed">
            Prices are per server. Payment is handled securely by Stripe. Any
            available changes and discounts are confirmed before payment.
          </Text>
        </Stack>
      </Stack>
    </Container>
  );
}
