import BillingRenewalGrace from "../components/BillingRenewalGrace";
import CheckoutRecovery, {
  IntroOfferAvailability,
} from "../components/CheckoutRecovery";
import { useBillingRenewalRecovery } from "../hooks/useBillingRenewalRecovery";
import { useBillingChange } from "../hooks/useBillingChange";
import BillingChangePanel from "../components/BillingChangePanel";
import { useBillingRenewal } from "../hooks/useBillingRenewal";
import BillingRenewalStatus from "../components/BillingRenewalStatus";
import BillingPaymentHistory from "../components/BillingPaymentHistory";
import { useIntroOfferExpiry } from "../hooks/useIntroOfferExpiry";
import {
  isTerminalStripeHistory,
  requiresStripeManagement,
} from "../utils/billingManagement";
import { useIntroOfferExposure } from "../hooks/useIntroOfferExposure";
import RecordingPlanContext from "../components/RecordingPlanContext";
import {
  resolveRecordingLimitContext,
  recordingLimitAnalytics,
  resolvePurchaseSource,
} from "../../utils/purchaseAnalytics";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ChangeEvent,
} from "react";
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
} from "@mantine/core";
import { IconCheck, IconCreditCard } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { inferRouterInputs } from "@trpc/server";
import type { BasicIntroOffer, IntroOfferChoice } from "../../types/pricing";
import BasicIntroTerms from "../components/BasicIntroTerms";
import IntroPromotionChoice from "../components/IntroPromotionChoice";
import SubscriptionDetails from "../components/SubscriptionDetails";
import classes from "./UpgradeServerSelect.module.css";
import { useCheckoutAttempt } from "../hooks/useCheckoutAttempt";
import { useGuildContext } from "../contexts/GuildContext";
import PageHeader from "../components/PageHeader";
import Surface from "../components/Surface";
import PricingCard from "../components/PricingCard";
import { trpc } from "../services/trpc";
import { track, isDoNotTrackEnabled } from "../services/analytics";
import { showBillingError } from "../utils/billingErrorNotification";
import { uiBorders, uiColors } from "../uiTokens";
import type { inferRouterOutputs } from "@trpc/server";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import type { AppRouter } from "../../trpc/router";
import {
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatPlanPrice,
  introOfferPrice,
  resolveIntroOffer,
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
};

type BillingPaidProps = BillingBaseProps & {
  data: BillingData;
  statusLabel: string;
  statusLine: string;
  busy: boolean;
  renewal: ReturnType<typeof useBillingRenewal>;
  onPortal: () => void;
  normalPrice: string | null;
};

type BillingPlansProps = {
  data: BillingData;
  interval: BillingInterval;
  onIntervalChange: (value: BillingInterval) => void;
  hasAnnualPlans: boolean;
  showPlans: boolean;
  onExpandPlans: () => void;
  onTogglePlans: () => void;
  onCheckout: (tier: PlanTier) => void;
  canChange: boolean;
  promoCode: string;
  onPromoCodeChange: (value: string) => void;
  basicPlan: ReturnType<typeof resolvePaidPlan>;
  proPlan: ReturnType<typeof resolvePaidPlan>;
  offer: BasicIntroOffer;
  offerChoice: IntroOfferChoice;
  onOfferChoiceChange: (choice: IntroOfferChoice) => void;
  busy: boolean;
  checkoutBlocked: boolean;
};

const DEFAULT_DESCRIPTION = "Manage subscriptions for the current server.";

const BENEFITS: Benefit[] = [
  {
    label: "Recording time per rolling week",
    values: { free: "4 hours", basic: "20 hours", pro: "No weekly limit" },
  },
  {
    label: "Max meeting length",
    values: {
      free: "90 minutes",
      basic: "2 hours",
      pro: "2 hours",
    },
  },
  {
    label: "Ask history",
    values: {
      free: "Up to 5 meetings",
      basic: "Up to 25 meetings",
      pro: "Up to 100 meetings",
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

const recoveryStatusLabel = (data: BillingData, fallback: string) => {
  const status = data.renewalRecovery?.status;
  if (status === "canceled") return "Access ending";
  return status === "grace" || status === "reconciling"
    ? "Grace period"
    : fallback;
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
  cancellationAt?: string | null,
) =>
  cancellationAt
    ? `${statusLabel}, ends ${new Date(cancellationAt).toLocaleDateString()}`
    : nextBillingDate
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

const BillingFreePanel = ({ serverName, usage }: BillingBaseProps) => (
  <Surface p="xl" data-testid="billing-current-plan">
    <Stack gap="sm">
      <Group gap="sm">
        <ThemeIcon color="brand" variant="light">
          <IconCreditCard size={18} />
        </ThemeIcon>
        <Text fw={600}>Current plan</Text>
      </Group>
      <Text size="lg" fw={700}>
        Free
      </Text>
      <Text size="sm" c="dimmed">
        Server: {serverName}
      </Text>
      <BillingUsageMeter usage={usage} />
    </Stack>
  </Surface>
);

const BillingPlanDescription = ({
  data,
  normalPrice,
  statusLine,
}: Pick<BillingPaidProps, "data" | "normalPrice" | "statusLine">) => {
  const isComped = data.billingSource === "manual_comp";
  const planName = formatStatusLabel(data.tier);
  const showRenewal = Boolean(data.hasStripeBilling);
  const expiryLine = data.activeGrant?.expiresAt
    ? `Comp runs through ${new Date(data.activeGrant.expiresAt).toLocaleDateString()}.`
    : "No payment required.";
  return (
    <>
      {isComped ? (
        <Stack gap={4}>
          <Text c="var(--mantine-color-text)" size="sm">
            Chronote has granted this server {planName} for free.{" "}
            {normalPrice
              ? `This is normally ${normalPrice}.`
              : "Regular pricing is unavailable right now."}
          </Text>
          <Text c="dimmed" size="sm">
            {expiryLine}
          </Text>
          {data.activeGrant?.publicNote ? (
            <Text size="sm">{data.activeGrant.publicNote}</Text>
          ) : null}
        </Stack>
      ) : !showRenewal && data.tier !== "free" ? (
        <Text c="dimmed" size="sm">
          {statusLine}
        </Text>
      ) : null}
    </>
  );
};

const showsLegacyRenewal = (data: BillingData) =>
  Boolean(data.hasStripeBilling) && !hasRenewalRecovery(data);
const hasRenewalRecovery = (data: BillingData) =>
  (data.renewalRecovery?.status ?? "none") !== "none";
const BillingPlanPaymentStatus = ({ data }: Pick<BillingPaidProps, "data">) => {
  const progress =
    data.subscriptionDetails?.status === "available"
      ? data.subscriptionDetails.paymentProgress
      : undefined;
  return !hasRenewalRecovery(data) &&
    data.billingSource !== "manual_comp" &&
    progress &&
    progress !== "not_pending" ? (
    <SubscriptionDetails details={data.subscriptionDetails} />
  ) : null;
};

const BillingPaidPanel = ({
  data,
  serverName,
  statusLabel,
  statusLine,
  usage,
  busy,
  renewal,
  onPortal,
  normalPrice,
}: BillingPaidProps) => (
  <Surface p="xl" data-testid="billing-current-plan">
    {(() => {
      const isComped = data.billingSource === "manual_comp";
      const planName = formatStatusLabel(data.tier);
      const renewalState =
        renewal.view?.state ??
        ({
          kind: "unavailable",
          knownEndsAt: data.cancellationAt ?? null,
        } as const);
      const showRenewal = showsLegacyRenewal(data);
      return (
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
                  {planName}
                </Text>
                {(isComped || (!showRenewal && data.tier !== "free")) && (
                  <Badge color={isComped ? "teal" : "brand"}>
                    {isComped
                      ? "Comped by Chronote"
                      : recoveryStatusLabel(data, statusLabel)}
                  </Badge>
                )}
              </Group>
              <BillingPlanDescription
                data={data}
                normalPrice={normalPrice}
                statusLine={statusLine}
              />
              <Text size="sm" c="dimmed">
                Server: {serverName}
              </Text>
              {showRenewal ? (
                <BillingRenewalStatus
                  state={renewalState}
                  canManageBilling={renewal.view?.canManageBilling ?? false}
                  busy={busy}
                  onConfirm={renewal.onConfirm}
                  onCheckStatus={renewal.onCheckStatus}
                  onRetry={renewal.onRetry}
                  onPortal={onPortal}
                />
              ) : null}
              <BillingPlanPaymentStatus data={data} />
              <BillingUsageMeter usage={usage} />
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
      );
    })()}
  </Surface>
);

function basicPlanCta(data: BillingData, isComped: boolean): string {
  if (isTerminalStripeHistory(data) && !isComped) return "Get Basic again";
  const basicCta =
    data.tier === "basic"
      ? isComped
        ? "Start paying for Basic"
        : "Current plan"
      : data.tier === "pro"
        ? "Included in Pro"
        : "Upgrade to Basic";
  return basicCta;
}
function proPlanCta(data: BillingData, isComped: boolean): string {
  if (isTerminalStripeHistory(data) && !isComped && hasRenewalRecovery(data))
    return "Get Pro again";
  const proCta =
    data.tier === "pro"
      ? isComped
        ? "Start paying for Pro"
        : "Current plan"
      : "Upgrade to Pro";
  return proCta;
}
function currentBasicBlocksPurchase(
  data: BillingData,
  isComped: boolean,
  canChange: boolean,
  interval: BillingInterval,
): boolean {
  return (
    (data.tier === "pro" && !canChange && !isTerminalStripeHistory(data)) ||
    (data.tier === "basic" &&
      !isTerminalStripeHistory(data) &&
      !isComped &&
      (!canChange ||
        (data.subscriptionDetails?.status === "available" &&
          data.subscriptionDetails.interval === interval)))
  );
}
function basicPlanDisabled(
  data: BillingData,
  basicPlan: ReturnType<typeof resolvePaidPlan>,
  busy: boolean,
  checkoutBlocked: boolean,
  offer: BasicIntroOffer,
  isComped: boolean,
  canChange = false,
  interval: BillingInterval = "month",
): boolean {
  const basicDisabled =
    !basicPlan ||
    (requiresStripeManagement(data) && !canChange) ||
    data.billingSource === "forced" ||
    busy ||
    checkoutBlocked ||
    offer.status === "unavailable" ||
    currentBasicBlocksPurchase(data, isComped, canChange, interval);
  return basicDisabled;
}
function proPlanDisabled(
  data: BillingData,
  proPlan: ReturnType<typeof resolvePaidPlan>,
  busy: boolean,
  checkoutBlocked: boolean,
  isComped: boolean,
  canChange = false,
  interval: BillingInterval = "month",
): boolean {
  const proDisabled =
    !proPlan ||
    (requiresStripeManagement(data) && !canChange) ||
    data.billingSource === "forced" ||
    busy ||
    checkoutBlocked ||
    (data.tier === "pro" &&
      !isTerminalStripeHistory(data) &&
      !isComped &&
      (!canChange ||
        (data.subscriptionDetails?.status === "available" &&
          data.subscriptionDetails.interval === interval)));
  return proDisabled;
}

type BillingPlanCardsProps = Pick<
  BillingPlansProps,
  | "data"
  | "interval"
  | "basicPlan"
  | "proPlan"
  | "offer"
  | "busy"
  | "checkoutBlocked"
  | "onCheckout"
  | "canChange"
> & { shownOffer: BasicIntroOffer };

function freePlanAction(
  data: BillingPlanCardsProps["data"],
  canChange: boolean,
  busy: boolean,
  checkoutBlocked: boolean,
) {
  return {
    cta:
      data.tier === "free"
        ? "Current plan"
        : canChange
          ? "Switch to Free"
          : "Available",
    ctaDisabled:
      data.tier !== "free" && (!canChange || busy || checkoutBlocked),
  };
}
function BillingPlanCards({
  data,
  interval,
  basicPlan,
  proPlan,
  offer,
  busy,
  checkoutBlocked,
  onCheckout,
  shownOffer,
  canChange,
}: BillingPlanCardsProps) {
  const isComped = data.billingSource === "manual_comp";
  const basicCta = canChange ? "Review Basic" : basicPlanCta(data, isComped);
  const proCta = canChange ? "Review Pro" : proPlanCta(data, isComped);
  const basicDisabled = basicPlanDisabled(
    data,
    basicPlan,
    busy,
    checkoutBlocked,
    offer,
    isComped,
    canChange,
    interval,
  );
  const proDisabled = proPlanDisabled(
    data,
    proPlan,
    busy,
    checkoutBlocked,
    isComped,
    canChange,
    interval,
  );
  const freeAction = freePlanAction(data, canChange, busy, checkoutBlocked);
  const checkoutBasic = () => onCheckout("basic");
  const checkoutPro = () => onCheckout("pro");
  return (
    <div className={classes.plans}>
      <PricingCard
        name="Free"
        price="$0"
        description="Lightweight coverage for smaller servers."
        features={[
          "4 recording hours per rolling week",
          "Up to 90 minutes per meeting",
          "Ask across up to 5 meetings",
          "Notes, tags, and summaries",
        ]}
        cta={freeAction.cta}
        ctaDisabled={freeAction.ctaDisabled}
        ctaProps={{
          variant: data.tier === "free" ? "light" : "outline",
          onClick: () => onCheckout("free"),
        }}
        badge={data.tier === "free" ? "Current plan" : "Free forever"}
        billingLabel="Always free"
        testId="billing-plan-free"
      />
      <PricingCard
        name="Basic"
        price={introOfferPrice(shownOffer, basicPlan, interval)}
        description="Unlock longer sessions and deeper recall."
        features={[
          "20 recording hours per rolling week",
          "Up to 2 hours per meeting",
          "Ask across up to 25 meetings",
          "Live voice mode",
        ]}
        cta={basicCta}
        ctaDisabled={basicDisabled}
        ctaProps={
          basicDisabled
            ? { variant: "light" }
            : { variant: "filled", onClick: checkoutBasic }
        }
        highlighted
        badge={paidPlanBadge(data, "basic", "Best value")}
        billingLabel={billingLabelForInterval(interval)}
        terms={<BasicIntroTerms offer={shownOffer} />}
        introOffer={shownOffer}
        testId="billing-plan-basic"
      />
      <PricingCard
        name="Pro"
        price={formatPlanPrice(proPlan, interval)}
        description="More recording time and a wider Ask history."
        features={[
          "No weekly recording limit",
          "Ask across up to 100 meetings",
          "Up to 2 hours per meeting",
          "Priority features + support",
        ]}
        cta={proCta}
        ctaDisabled={proDisabled}
        ctaProps={proDisabled ? { variant: "light" } : { onClick: checkoutPro }}
        badge={paidPlanBadge(data, "pro", "More recording time")}
        tone="default"
        borderColor={uiColors.accentBorder}
        borderWidth={uiBorders.accentWidth}
        billingLabel={billingLabelForInterval(interval)}
        testId="billing-plan-pro"
      />
    </div>
  );
}

function expandedPlanSelection(data: BillingData, showPlans: boolean): boolean {
  return (
    data.tier === "free" ||
    data.billingSource === "manual_comp" ||
    isTerminalStripeHistory(data) ||
    showPlans
  );
}
function paidPlanBadge(
  data: BillingData,
  tier: PaidTier,
  fallback: string,
): string {
  return data.tier === tier && !isTerminalStripeHistory(data)
    ? "Current plan"
    : fallback;
}
function selectedIntroOffer(tier: PlanTier, offer: BasicIntroOffer) {
  return tier === "basic" && offer.status === "available" ? offer.id : "none";
}
function BillingPlansSection({
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
  offer,
  offerChoice,
  onOfferChoiceChange,
  busy,
  checkoutBlocked,
  canChange,
}: BillingPlansProps) {
  const isFreePlan = data.tier === "free";
  const plansExpanded = expandedPlanSelection(data, showPlans);
  const hasPromo = promoCode.trim().length > 0;
  const managementOnly =
    requiresStripeManagement(data) || data.billingSource === "forced";
  const shownOffer =
    offerChoice === "promotion" && hasPromo
      ? { status: "inactive" as const }
      : offer;
  const changeInterval = (value: string) =>
    onIntervalChange(value as BillingInterval);
  const changePromo = (event: ChangeEvent<HTMLInputElement>) =>
    onPromoCodeChange(event.currentTarget.value);
  const clearPromo = () => onPromoCodeChange("");
  return (
    <Surface
      p="lg"
      tone="default"
      onClick={!plansExpanded ? onExpandPlans : undefined}
      style={{
        width: "100%",
        containerType: "inline-size",
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
            onChange={changeInterval}
            data={[
              { label: "Monthly", value: "month" },
              {
                label: "Annual",
                value: "year",
                disabled: !hasAnnualPlans,
              },
            ]}
            size="sm"
            data-testid="billing-interval"
            aria-label="Billing period"
            classNames={{
              root: classes.billingPeriod,
              control: classes.control,
              label: classes.label,
            }}
            disabled={busy || checkoutBlocked}
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
        {!managementOnly && (
          <Stack gap={4}>
            <Group gap="sm" align="flex-end" wrap="wrap">
              <TextInput
                label="Promo code"
                placeholder="Enter code"
                className="ph-no-capture"
                value={promoCode}
                disabled={busy || checkoutBlocked}
                onChange={changePromo}
                style={{ flex: "1 1 220px" }}
              />
              {hasPromo ? (
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  disabled={busy || checkoutBlocked}
                  onClick={clearPromo}
                >
                  Clear
                </Button>
              ) : null}
            </Group>
            <Text size="xs" c="dimmed">
              One code per purchase. Applied at checkout.
            </Text>
          </Stack>
        )}
        {!managementOnly && offer.status === "available" && hasPromo && (
          <IntroPromotionChoice
            choice={offerChoice}
            onChange={onOfferChoiceChange}
            disabled={busy || checkoutBlocked}
          />
        )}
        <IntroOfferAvailability offer={offer} />
        {!plansExpanded ? (
          <Text size="sm" c="dimmed">
            Compare plan details when you are ready to change tiers.
          </Text>
        ) : null}
        <Collapse expanded={plansExpanded}>
          <Divider my="sm" />
          <BillingPlanCards
            data={data}
            interval={interval}
            basicPlan={basicPlan}
            proPlan={proPlan}
            offer={offer}
            busy={busy}
            checkoutBlocked={checkoutBlocked}
            canChange={canChange}
            onCheckout={onCheckout}
            shownOffer={shownOffer}
          />
        </Collapse>
      </Stack>
    </Surface>
  );
}

type CheckoutRequest = inferRouterInputs<AppRouter>["billing"]["checkout"];
function billingCheckoutRequest({
  serverId: selectedGuildId,
  tier,
  interval,
  promotionCode,
  offer,
  offerChoice,
  source,
  limitContext,
}: {
  serverId: string;
  tier: PaidTier;
  interval: BillingInterval;
  promotionCode: string;
  offer: BasicIntroOffer;
  offerChoice: IntroOfferChoice;
  source: CheckoutRequest["source"];
  limitContext: ReturnType<typeof resolveRecordingLimitContext>;
}): CheckoutRequest {
  const request: inferRouterInputs<AppRouter>["billing"]["checkout"] = {
    serverId: selectedGuildId,
    tier,
    interval,
    promotionCode:
      tier === "basic" &&
      offer.status === "available" &&
      offerChoice === "automatic"
        ? undefined
        : promotionCode || undefined,
    savedPromotionCode: promotionCode || undefined,
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
  return request;
}

type CheckoutReadiness = {
  canChange?: boolean;
  busy: boolean;
  refreshing: boolean;
  failedCheckout: CheckoutRequest | null;
  billingFetching: boolean;
  pricingFetching: boolean;
  pricingError: boolean;
  data: BillingData | null;
  tier: PaidTier;
  offer: BasicIntroOffer;
};

function checkoutIsBlocked({
  busy,
  refreshing,
  failedCheckout,
  billingFetching,
  pricingFetching,
  pricingError,
  data,
  tier,
  offer,
  canChange = false,
}: CheckoutReadiness): boolean {
  return Boolean(
    busy ||
    refreshing ||
    failedCheckout ||
    billingFetching ||
    pricingFetching ||
    pricingError ||
    (data && requiresStripeManagement(data) && !canChange) ||
    data?.billingSource === "forced" ||
    (tier === "basic" && offer.status === "unavailable"),
  );
}

function BillingCurrentPlan({
  data,
  serverName,
  isPortalPending,
  selectedGuildId,
  busy,
  onPortal: handlePortal,
  normalPlan,
  renewal,
}: {
  data: BillingData;
  serverName: string;
  isPortalPending: boolean;
  selectedGuildId: string | null;
  busy: boolean;
  onPortal: () => void;
  normalPlan: ReturnType<typeof resolvePaidPlan>;
  renewal: ReturnType<typeof useBillingRenewal>;
}) {
  const isFreeTier = data.tier === "free";
  const hasTerminalSubscription = isTerminalStripeHistory(data);
  const firstYearPayment =
    data.subscriptionDetails?.status === "available"
      ? data.subscriptionDetails.firstYearPayment
      : null;
  const canViewReceipts =
    Boolean(selectedGuildId) && (renewal.view?.canManageBilling ?? false);
  const showHistory =
    data.hasStripeBilling &&
    Boolean(firstYearPayment || canViewReceipts || hasTerminalSubscription);
  const statusLabel = formatStatusLabel(data.status);
  const statusLine = formatStatusLine(
    statusLabel,
    data.nextBillingDate,
    data.cancellationAt,
  );
  return (
    <>
      {isFreeTier && (!data.hasStripeBilling || hasTerminalSubscription) ? (
        <BillingFreePanel serverName={serverName} usage={data.usage} />
      ) : (
        <BillingPaidPanel
          data={data}
          serverName={serverName}
          statusLabel={statusLabel}
          statusLine={statusLine}
          usage={data.usage}
          busy={busy}
          renewal={renewal}
          onPortal={handlePortal}
          normalPrice={normalPlan ? formatPlanPrice(normalPlan, "month") : null}
        />
      )}
      {showHistory ? (
        <Surface p="md">
          <BillingPaymentHistory
            firstYearPayment={firstYearPayment}
            previousStatus={data.stripeStatus ?? data.status}
            canViewReceipts={canViewReceipts}
            onViewReceipts={handlePortal}
            busy={isPortalPending || busy}
          />
        </Surface>
      ) : null}
    </>
  );
}

function useBillingRoute() {
  const search = useSearch({ from: "/portal/server/$serverId/billing" });
  const navigate = useNavigate({ from: "/portal/server/$serverId/billing" });
  const interval = search.interval ?? "month";
  const source =
    search.source === undefined
      ? "portal_billing"
      : resolvePurchaseSource(search.source);
  const limitContext = useMemo(
    () => resolveRecordingLimitContext(search),
    [search.limitType, search.limitSurface],
  );
  const { serverId: routeServerId } = useParams({
    from: "/portal/server/$serverId/billing",
  });
  const [promoCode, setPromoCode] = useState(() => search.promo ?? "");
  const offerChoice = promoCode.trim()
    ? (search.offerChoice ?? "automatic")
    : "automatic";
  useEffect(() => setPromoCode(search.promo ?? ""), [search.promo]);
  return {
    search,
    navigate,
    interval,
    source,
    limitContext,
    routeServerId,
    promoCode,
    setPromoCode,
    offerChoice,
  };
}

function useBillingPricing(
  pricingData: RouterOutput["pricing"]["plans"] | undefined,
  data: BillingData | null,
  frozenOffer: BasicIntroOffer | null,
  interval: BillingInterval,
) {
  const paidPlans = pricingData?.plans ?? [];
  const planLookup = useMemo(() => buildPaidPlanLookup(paidPlans), [paidPlans]);
  const basicPlan = resolvePaidPlan(planLookup, "basic", interval);
  const proPlan = resolvePaidPlan(planLookup, "pro", interval);
  const normalPlan = resolvePaidPlan(
    planLookup,
    data?.tier === "pro" ? "pro" : "basic",
    "month",
  );
  const offer =
    frozenOffer ??
    resolveIntroOffer(
      interval === "year" ? data?.annualIntroOffer : data?.introOffer,
      basicPlan,
    );
  const hasAnnualPlans = paidPlans.some((plan) => plan.interval === "year");
  return { basicPlan, proPlan, normalPlan, planLookup, offer, hasAnnualPlans };
}

function useBillingEntryAnalytics({
  loading,
  error,
  data,
  selectedGuildId,
  source,
  limitContext,
}: {
  loading: boolean;
  error: string | null;
  data: BillingData | null;
  selectedGuildId: string | null;
  source: CheckoutRequest["source"];
  limitContext: ReturnType<typeof resolveRecordingLimitContext>;
}) {
  const arrivedServers = useRef(new Set<string>());
  useEffect(() => {
    if (
      loading ||
      error ||
      !data ||
      !selectedGuildId ||
      arrivedServers.current.has(selectedGuildId)
    )
      return;
    arrivedServers.current.add(selectedGuildId);
    track("billing_entry_arrived", {
      guild_id: selectedGuildId,
      source,
      ...recordingLimitAnalytics(limitContext ?? {}),
      current_tier: data.tier,
      event_version: 1,
    });
  }, [loading, error, data, selectedGuildId, source, limitContext]);
}

function useBillingQueries(routeServerId: string) {
  const { selectedGuildId, guilds, loading: guildLoading } = useGuildContext();
  const billingQuery = trpc.billing.me.useQuery(
    { serverId: selectedGuildId ?? undefined },
    { enabled: Boolean(selectedGuildId) },
  );
  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const serverName = useMemo(
    () =>
      guilds.find((g) => g.id === selectedGuildId)?.name || "Unknown server",
    [guilds, selectedGuildId],
  );
  const liveOffers = useIntroOfferExpiry(billingQuery.data, () =>
    Promise.allSettled([billingQuery.refetch(), pricingQuery.refetch()]),
  );
  const data = useMemo(
    () =>
      billingQuery.data
        ? {
            ...billingQuery.data,
            introOffer: liveOffers.introOffer,
            annualIntroOffer: liveOffers.annualIntroOffer,
          }
        : null,
    [billingQuery.data, liveOffers.introOffer, liveOffers.annualIntroOffer],
  );
  const loading =
    billingQuery.isLoading ||
    guildLoading ||
    Boolean(selectedGuildId && selectedGuildId !== routeServerId);
  const error = billingQuery.error ? "Unable to load billing status." : null;

  return {
    selectedGuildId,
    billingQuery,
    pricingQuery,
    serverName,
    data,
    loading,
    error,
  };
}

function useBillingOfferExposure({
  data,
  offer,
  offerChoice,
  routeServerId,
  selectedGuildId,
  loading,
  error,
  showPlans,
  setShowPlans,
}: {
  data: BillingData | null;
  offer: BasicIntroOffer;
  offerChoice: IntroOfferChoice;
  routeServerId: string;
  selectedGuildId: string | null;
  loading: boolean;
  error: string | null;
  showPlans: boolean;
  setShowPlans: (value: boolean) => void;
}) {
  const isFreeTier = data?.tier === "free";
  const displayedOffer =
    offer.status === "available" && offerChoice === "automatic"
      ? offer.id
      : "none";
  useIntroOfferExposure({
    offer: displayedOffer,
    entry: `portal_billing:${routeServerId}`,
    surface: "portal_billing",
    guildId: selectedGuildId ?? undefined,
    enabled: !loading && !error && showPlans,
  });

  useEffect(() => {
    if (isFreeTier) {
      setShowPlans(true);
    }
  }, [isFreeTier]);

  return displayedOffer;
}

function canSelectBillingChange(input: {
  tier: PlanTier;
  serverId: string | null;
  routeServerId: string;
  busy: boolean;
  pricingReady: boolean;
  offer: BasicIntroOffer;
}) {
  return Boolean(
    input.serverId &&
    input.serverId === input.routeServerId &&
    !input.busy &&
    (input.tier === "free" ||
      (input.pricingReady &&
        (input.tier === "pro" || input.offer.status !== "unavailable"))),
  );
}
function isChangePricingReady(
  input: {
    isFetching: boolean;
    isLoading: boolean;
    isError: boolean;
  },
  basic: ReturnType<typeof resolvePaidPlan>,
  pro: ReturnType<typeof resolvePaidPlan>,
) {
  return (
    !input.isFetching &&
    !input.isLoading &&
    !input.isError &&
    Boolean(basic && pro)
  );
}
function billingChangeAccess(
  data: BillingData | null,
  sameServer: boolean,
  payerCanManage: boolean | undefined,
  recoveryPending: boolean,
) {
  return {
    active: Boolean(data?.hasStripeBilling && sameServer && payerCanManage),
    canStart: Boolean(
      data && !isTerminalStripeHistory(data) && !recoveryPending,
    ),
  };
}
function billingRecoverySnapshot(
  data: BillingData | null,
  sameServer: boolean,
) {
  return {
    active: Boolean(data?.hasStripeBilling) && sameServer,
    view: data?.renewalRecovery,
  };
}
export function Billing() {
  const [showPlans, setShowPlans] = useState(false);
  const {
    search,
    navigate,
    interval,
    source,
    limitContext,
    routeServerId,
    promoCode,
    setPromoCode,
    offerChoice,
  } = useBillingRoute();
  const {
    selectedGuildId,
    billingQuery,
    pricingQuery,
    serverName,
    data,
    loading,
    error,
  } = useBillingQueries(routeServerId);
  const checkoutMutation = trpc.billing.checkout.useMutation();
  const portalMutation = trpc.billing.portal.useMutation();
  const renewal = useBillingRenewal({
    serverId: selectedGuildId,
    active: billingRecoverySnapshot(data, selectedGuildId === routeServerId)
      .active,
    onBillingChanged: () => billingQuery.refetch(),
  });
  const recovery = useBillingRenewalRecovery({
    serverId: selectedGuildId,
    ...billingRecoverySnapshot(data, selectedGuildId === routeServerId),
    onBillingChanged: () => billingQuery.refetch(),
  });
  const change = useBillingChange({
    serverId: selectedGuildId,
    ...billingChangeAccess(
      data,
      selectedGuildId === routeServerId,
      renewal.view?.canManageBilling,
      recovery.pending,
    ),
    onBillingChanged: () => renewal.onRetry(),
  });
  const attemptIdentity = JSON.stringify([
    routeServerId,
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

  const { basicPlan, proPlan, normalPlan, planLookup, offer, hasAnnualPlans } =
    useBillingPricing(pricingQuery.data, data, frozenOffer, interval);
  const busy = [
    checkoutMutation.isPending,
    portalMutation.isPending,
    renewal.busy,
    recovery.busy,
    change.busy,
  ].some(Boolean);
  const isPortalPending = portalMutation.isPending;
  const displayedOffer = useBillingOfferExposure({
    data,
    offer,
    offerChoice,
    routeServerId,
    selectedGuildId,
    loading,
    error,
    showPlans,
    setShowPlans,
  });

  useBillingEntryAnalytics({
    loading,
    error,
    data,
    selectedGuildId,
    source,
    limitContext,
  });

  const changePricingReady = isChangePricingReady(
    pricingQuery,
    basicPlan,
    proPlan,
  );
  const canSelectChange = (tier: PlanTier) =>
    canSelectBillingChange({
      tier,
      serverId: selectedGuildId,
      routeServerId,
      busy,
      pricingReady: changePricingReady,
      offer,
    });
  const handleCheckout = async (tier: PlanTier) => {
    if (recovery.pending) return;
    if (change.enabled) {
      if (!canSelectChange(tier)) return;
      await change.select({
        tier,
        interval,
        expectedOffer: selectedIntroOffer(tier, offer),
      });
      return;
    }
    if (tier === "free") return;
    let attempt: ReturnType<typeof checkoutAttempt.begin> | null = null;
    try {
      if (!selectedGuildId || selectedGuildId !== routeServerId) return;
      if (
        checkoutIsBlocked({
          busy,
          canChange: change.enabled,
          refreshing: checkoutAttempt.refreshing,
          failedCheckout,
          billingFetching: billingQuery.isFetching,
          pricingFetching: pricingQuery.isFetching,
          pricingError: pricingQuery.isError,
          data,
          tier,
          offer,
        })
      )
        return;
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
      track("upgrade_plan_clicked", {
        guild_id: selectedGuildId,
        tier,
        interval,
        source,
        ...recordingLimitAnalytics(limitContext ?? {}),
        promo_present: Boolean(promotionCode),
        offer: tier === "basic" ? displayedOffer : "none",
        event_version: 1,
      });
      const request = billingCheckoutRequest({
        serverId: selectedGuildId,
        tier,
        interval,
        promotionCode,
        offer,
        offerChoice,
        source,
        limitContext,
      });
      attempt = checkoutAttempt.begin(request, offer);
      const body = await checkoutMutation.mutateAsync(request);
      if (checkoutAttempt.isCurrent(attempt)) window.location.href = body.url;
    } catch (err) {
      if (attempt && checkoutAttempt.isCurrent(attempt)) {
        console.error(err);
        showBillingError(err, "checkout");
      }
    }
  };

  const routedSelection = useRef("");
  const routedChangeReady = search.plan ? canSelectChange(search.plan) : false;
  useEffect(() => {
    if (!search.plan || !change.enabled || !routedChangeReady) return;
    const key = JSON.stringify([routeServerId, search.plan, interval]);
    if (routedSelection.current === key) return;
    routedSelection.current = key;
    void handleCheckout(search.plan);
    void navigate({ replace: true, search: { ...search, plan: undefined } });
  }, [search.plan, change.enabled, routeServerId, interval, routedChangeReady]);

  const handlePortal = async () => {
    try {
      if (!selectedGuildId || selectedGuildId !== routeServerId) return;
      if (busy) return;
      const body = await portalMutation.mutateAsync({
        serverId: selectedGuildId,
      });
      window.location.href = body.url;
    } catch (err) {
      console.error(err);
      showBillingError(err, "portal");
    }
  };

  const changeInterval = (value: BillingInterval) =>
    navigate({
      replace: true,
      search: {
        ...search,
        interval: value,
        promo: promoCode.trim() || undefined,
      },
    });
  const changePromo = (value: string) => {
    setPromoCode(value);
    navigate({
      replace: true,
      search: { ...search, promo: value.trim() || undefined },
    });
  };
  const changeOffer = (value: IntroOfferChoice) =>
    navigate({ replace: true, search: { ...search, offerChoice: value } });
  const expandPlans = () => setShowPlans(true);
  const togglePlans = () => setShowPlans((prev) => !prev);
  const refreshOffers = () => checkoutAttempt.refresh();
  const retryCheckout = async () => {
    const attempt = checkoutAttempt.attempt;
    if (
      busy ||
      !selectedGuildId ||
      selectedGuildId !== routeServerId ||
      !attempt ||
      !checkoutAttempt.isCurrent(attempt)
    )
      return;
    try {
      const body = await checkoutMutation.mutateAsync(attempt.request);
      if (checkoutAttempt.isCurrent(attempt)) window.location.href = body.url;
    } catch (error) {
      if (checkoutAttempt.isCurrent(attempt))
        showBillingError(error, "checkout");
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

  return (
    <BillingShell>
      <RecordingPlanContext context={limitContext} />
      <BillingRenewalGrace
        key={selectedGuildId}
        recovery={recovery}
        serverName={serverName}
        onUpdatePaymentMethod={handlePortal}
        grantTier={data.grantTier}
      />
      <BillingCurrentPlan
        data={data}
        serverName={serverName}
        isPortalPending={isPortalPending}
        selectedGuildId={selectedGuildId}
        busy={busy}
        onPortal={handlePortal}
        normalPlan={normalPlan}
        renewal={renewal}
      />
      {!hasRenewalRecovery(data) ? (
        <BillingChangePanel change={change} serverName={serverName} />
      ) : null}
      <BillingPlansSection
        canChange={change.enabled}
        data={data}
        interval={interval}
        onIntervalChange={changeInterval}
        hasAnnualPlans={hasAnnualPlans}
        showPlans={showPlans}
        onExpandPlans={expandPlans}
        onTogglePlans={togglePlans}
        onCheckout={handleCheckout}
        promoCode={promoCode}
        onPromoCodeChange={changePromo}
        basicPlan={basicPlan}
        proPlan={proPlan}
        offer={offer}
        offerChoice={offerChoice}
        onOfferChoiceChange={changeOffer}
        busy={[
          busy,
          billingQuery.isFetching,
          pricingQuery.isFetching,
          checkoutAttempt.refreshing,
        ].some(Boolean)}
        checkoutBlocked={[
          recovery.pending,
          Boolean(failedCheckout),
          pricingQuery.isError,
          Boolean(change.pending),
        ].some(Boolean)}
      />
      <CheckoutRecovery
        offer={offer}
        checkoutFailed={Boolean(failedCheckout)}
        retryDisabled={busy}
        refreshDisabled={busy}
        onRetry={retryCheckout}
        onRefresh={refreshOffers}
      />
    </BillingShell>
  );
}

export default Billing;
