import { useMemo, useState } from "react";
import {
  Button,
  Container,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  IconArrowRight,
  IconDownload,
  IconFileText,
  IconMicrophone,
  IconSearch,
  IconSparkles,
} from "@tabler/icons-react";
import FeatureCard from "../components/FeatureCard";
import PricingCard from "../components/PricingCard";
import Section from "../components/Section";
import Surface from "../components/Surface";
import { heroBackground, uiBorders, uiColors, uiTypography } from "../uiTokens";
import { trpc } from "../services/trpc";
import type { BillingInterval } from "../../types/pricing";
import {
  annualSavingsLabel,
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";
import { DISCORD_BOT_INVITE_URL } from "../utils/discordInvite";

const STEP_ICON_SIZE = 44;
const STEP_INNER_ICON_SIZE = 22;

const steps = [
  {
    icon: IconMicrophone,
    title: "Add the bot",
    description:
      "Invite Chronote to your Discord server with one click. No config required.",
    color: "cyan",
  },
  {
    icon: IconFileText,
    title: "Record a meeting",
    description:
      "Start a voice call and use /startmeeting, or turn on auto-record for hands-free capture.",
    color: "violet",
  },
  {
    icon: IconSparkles,
    title: "Get your notes",
    description:
      "Chronote posts a transcript and structured summary right back in your Discord channel.",
    color: "brand",
  },
] as const;

const features = [
  {
    title: "Automatic capture",
    description:
      "Join on demand or auto-record a channel. Capture audio, chat, and attendance.",
    icon: <IconMicrophone size={22} />,
  },
  {
    title: "Transcript + summary",
    description:
      "Structured notes land back in Discord with decisions and action items.",
    icon: <IconFileText size={22} />,
  },
  {
    title: "Search with quotes",
    description:
      "Ask across recent sessions with quotes and timestamps attached.",
    icon: <IconSearch size={22} />,
  },
  {
    title: "Exports + retention",
    description: "Download audio, transcript, and notes from the web library.",
    icon: <IconDownload size={22} />,
  },
];

export default function Home() {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const [interval, setInterval] = useState<BillingInterval>("month");
  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const paidPlans = pricingQuery.data?.plans ?? [];
  const planLookup = useMemo(() => buildPaidPlanLookup(paidPlans), [paidPlans]);
  const hasAnnualPlans = paidPlans.some((plan) => plan.interval === "year");
  const basicPlan = resolvePaidPlan(planLookup, "basic", interval);
  const proPlan = resolvePaidPlan(planLookup, "pro", interval);

  return (
    <Stack gap="xl">
      {/* Hero */}
      <Container size="md" py={{ base: "xl", md: 80 }}>
        <Stack
          align="center"
          gap="md"
          p={{ base: "lg", md: "xl" }}
          data-testid="home-hero"
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
            Transcripts and summaries for Discord voice.
          </Title>
          <Text size="lg" c="dimmed" maw={520}>
            Record voice channels, get notes back in Discord, and keep a
            searchable logbook on the web.
          </Text>
          <Button
            size="lg"
            variant="gradient"
            gradient={{ from: "brand", to: "violet" }}
            component="a"
            href={DISCORD_BOT_INVITE_URL}
            data-testid="home-cta-discord"
            rightSection={<IconArrowRight size={18} />}
          >
            Add to Discord
          </Button>
        </Stack>
      </Container>

      {/* How it works */}
      <Section
        eyebrow="How it works"
        title="Three steps to meeting notes"
        align="center"
      >
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
          {steps.map((step) => (
            <Surface key={step.title} p="lg">
              <Stack gap="sm" align="center" ta="center">
                <ThemeIcon
                  variant="light"
                  color={step.color}
                  size={STEP_ICON_SIZE}
                  radius="md"
                >
                  <step.icon size={STEP_INNER_ICON_SIZE} />
                </ThemeIcon>
                <Text fw={600}>{step.title}</Text>
                <Text size="sm" c="dimmed">
                  {step.description}
                </Text>
              </Stack>
            </Surface>
          ))}
        </SimpleGrid>
      </Section>

      {/* Features */}
      <Section
        eyebrow="Features"
        title="Everything you need to remember the meeting"
        description="Capture now, find it later, all without leaving Discord."
        align="center"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
          {features.map((feature) => (
            <FeatureCard
              key={feature.title}
              title={feature.title}
              description={feature.description}
              icon={feature.icon}
            />
          ))}
        </SimpleGrid>
      </Section>

      {/* Pricing */}
      <Section
        eyebrow="Pricing"
        title="Memory power, server-based pricing"
        description="Start free, upgrade when you need more history and longer retention."
      >
        <Group justify="space-between" align="center" wrap="wrap">
          <Text size="sm" c="dimmed">
            Pricing shown per server.
          </Text>
          <SegmentedControl
            value={interval}
            onChange={(value) => setInterval(value as BillingInterval)}
            data={[
              { label: "Monthly", value: "month" },
              {
                label: "Annual (best value)",
                value: "year",
                disabled: !hasAnnualPlans,
              },
            ]}
            size="sm"
          />
        </Group>
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
          <PricingCard
            name="Free"
            price="$0"
            description="Great for smaller servers and one-off sessions."
            badge="Free forever"
            features={[
              "Up to 4 hours per week",
              "Up to 60 minutes per meeting",
              "Ask across recent meetings",
              "Notes, tags, and summary embeds",
            ]}
            cta="Get started"
            billingLabel="Always free"
          />
          <PricingCard
            name="Basic"
            price={formatPlanPrice(basicPlan, interval)}
            description="Unlock longer sessions and more history."
            features={[
              "Up to 20 hours per week",
              "Up to 2 hours per meeting",
              "Ask across longer history",
              "Live voice mode",
            ]}
            cta="Upgrade to Basic"
            highlighted
            billingLabel={`${billingLabelForInterval(interval)}${
              interval === "year" ? ` • ${annualSavingsLabel}` : ""
            }`}
          />
          <PricingCard
            name="Pro"
            price={formatPlanPrice(proPlan, interval)}
            description="Unlimited retention and full-history search."
            features={[
              "Unlimited retention",
              "Unlimited recording time",
              "Ask across full retention",
              "Up to 2 hours per meeting (8 hours coming soon)",
              "Priority features + support",
            ]}
            cta="Upgrade to Pro"
            ctaDisabled
            badge="Unlimited meetings"
            tone="raised"
            borderColor={uiColors.accentBorder}
            borderWidth={uiBorders.accentWidth}
            billingLabel={`${billingLabelForInterval(interval)}${
              interval === "year" ? ` • ${annualSavingsLabel}` : ""
            }`}
          />
        </SimpleGrid>
      </Section>

      {/* Bottom CTA */}
      <Container size="sm">
        <Surface p={{ base: "lg", md: "xl" }}>
          <Stack align="center" gap="md" ta="center">
            <Title order={3}>Ready to keep the record?</Title>
            <Text c="dimmed" maw={420}>
              Add Chronote, record your first session, and get notes in minutes.
            </Text>
            <Button
              size="md"
              variant="gradient"
              gradient={{ from: "brand", to: "violet" }}
              component="a"
              href={DISCORD_BOT_INVITE_URL}
              rightSection={<IconArrowRight size={16} />}
            >
              Add to Discord
            </Button>
          </Stack>
        </Surface>
      </Container>
    </Stack>
  );
}
