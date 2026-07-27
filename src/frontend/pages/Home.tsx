import { useMemo, useState } from "react";
import {
  Anchor,
  Button,
  Container,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import SampleSummary from "../components/SampleSummary";
import { trpc } from "../services/trpc";
import { track } from "../services/analytics";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import {
  annualSavingsLabel,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";
import { DISCORD_BOT_INVITE_URL } from "../utils/discordInvite";

const PRICING_TABLE_MIN_WIDTH = 560;

const CAPABILITIES = [
  "Auto-record the channels you pick",
  "Captures chat and attendance too",
  "Corrections, approved by your team",
  "A dictionary for your server's jargon",
  "Export audio, transcript, and notes",
  "Send notes to Notion",
  "Replies out loud, and reads typed messages aloud",
  "MCP access for Claude and other clients",
];

const CONTROLS = [
  "Records only on /startmeeting, or in channels you choose.",
  "The bot sits visibly in the channel the whole time.",
  "Delete any meeting. Remove the bot to stop everything.",
];

type PricingRow = {
  label: string;
  free: string;
  basic: string;
  pro: string;
};

const PRICING_ROWS: PricingRow[] = [
  {
    label: "Recording",
    free: "4 hours a week",
    basic: "20 hours a week",
    pro: "No weekly limit",
  },
  {
    label: "Longest meeting",
    free: "90 minutes",
    basic: "2 hours",
    pro: "2 hours",
  },
  {
    label: "Ask searches",
    free: "Last 5 meetings",
    basic: "Last 25 meetings",
    pro: "Last 100 meetings",
  },
  {
    label: "Text to speech",
    free: "50 a month",
    basic: "1,000 a month",
    pro: "Unlimited",
  },
  {
    label: "Live voice",
    free: "No",
    basic: "Yes",
    pro: "Yes",
  },
  {
    label: "History",
    free: "Recent",
    basic: "Longer",
    pro: "No limit",
  },
];

export default function Home() {
  const navigate = useNavigate();
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("month");
  const pricingQuery = trpc.pricing.plans.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
  });
  const paidPlans = useMemo(
    () => pricingQuery.data?.plans ?? [],
    [pricingQuery.data],
  );
  const planLookup = useMemo(() => buildPaidPlanLookup(paidPlans), [paidPlans]);
  const hasAnnualPlans = paidPlans.some((plan) => plan.interval === "year");
  const basicPlan = resolvePaidPlan(planLookup, "basic", billingInterval);
  const proPlan = resolvePaidPlan(planLookup, "pro", billingInterval);

  const startUpgrade = (plan: PaidTier) => {
    track("pricing_cta_clicked", { plan, interval: billingInterval });
    navigate({
      to: "/upgrade/select-server",
      search: { plan, interval: billingInterval },
    });
  };

  const trackInvite = (location: string) => () => {
    track("add_to_discord_clicked", { location });
  };

  return (
    <Container size={720} py={{ base: 48, md: 96 }}>
      <Stack gap={96}>
        <Stack gap="xl" data-testid="home-hero">
          <Title
            order={1}
            fw={600}
            fz={{ base: 30, md: 42 }}
            lh={1.15}
            style={{ letterSpacing: "-0.03em" }}
          >
            Saves the whole call.
            <br />
            Takes the notes so you don&apos;t have to.
            <br />
            Finds the quote when you ask.
          </Title>
          <Text size="lg" c="dimmed" maw={560}>
            A Discord bot that records your voice calls and posts the notes back
            to the channel.
          </Text>
          <Group gap="sm" wrap="wrap">
            <Button
              size="md"
              component="a"
              href={DISCORD_BOT_INVITE_URL}
              data-testid="home-cta-discord"
              onClick={trackInvite("hero")}
            >
              Add to Discord
            </Button>
            <Button
              size="md"
              variant="subtle"
              component="a"
              href="#what-comes-back"
            >
              See what it sends back
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            Free tier, no card. Nothing records until you turn it on.
          </Text>
        </Stack>

        <Stack gap="lg" id="what-comes-back">
          <Title order={2} fz={22} fw={600}>
            What comes back
          </Title>
          <SampleSummary />
        </Stack>

        <Stack gap="lg">
          <Title order={2} fz={22} fw={600}>
            Ask it later
          </Title>
          <Text>
            Ask &quot;what did we decide about the schedule?&quot; Get the
            answer, the quote, and the timestamp.
          </Text>
          <Text size="sm" c="dimmed">
            Already run Craig? This is the part you do by hand.
          </Text>
        </Stack>

        <Stack gap="lg">
          <Title order={2} fz={22} fw={600}>
            Also
          </Title>
          <SimpleGrid
            cols={{ base: 1, sm: 2 }}
            spacing="sm"
            verticalSpacing="sm"
          >
            {CAPABILITIES.map((capability) => (
              <Text key={capability} size="sm" c="dimmed">
                {capability}
              </Text>
            ))}
          </SimpleGrid>
        </Stack>

        <Stack gap="lg">
          <Title order={2} fz={22} fw={600}>
            Who controls it
          </Title>
          <Stack gap="xs">
            {CONTROLS.map((line) => (
              <Text key={line} size="sm" c="dimmed">
                {line}
              </Text>
            ))}
            <Text size="sm" c="dimmed">
              Open source under the AGPL, on{" "}
              <Anchor
                href="https://github.com/Chronote-gg/chronote"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </Anchor>
              .
            </Text>
          </Stack>
        </Stack>

        <Stack gap="lg">
          <Group justify="space-between" align="baseline" wrap="wrap" gap="sm">
            <Title order={2} fz={22} fw={600}>
              Pricing
            </Title>
            <SegmentedControl
              value={billingInterval}
              onChange={(value) => setBillingInterval(value as BillingInterval)}
              data={[
                { label: "Monthly", value: "month" },
                {
                  label: "Annual",
                  value: "year",
                  disabled: !hasAnnualPlans,
                },
              ]}
              size="xs"
            />
          </Group>
          <Text size="sm" c="dimmed">
            Per server, not per member.
            {billingInterval === "year" ? ` ${annualSavingsLabel}.` : ""}
          </Text>
          <Table.ScrollContainer minWidth={PRICING_TABLE_MIN_WIDTH}>
            <Table verticalSpacing="xs" horizontalSpacing="md" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th />
                  <Table.Th>Free</Table.Th>
                  <Table.Th>Basic</Table.Th>
                  <Table.Th>Pro</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td c="dimmed">Price</Table.Td>
                  <Table.Td fw={600}>$0</Table.Td>
                  <Table.Td fw={600}>
                    {formatPlanPrice(basicPlan, billingInterval)}
                  </Table.Td>
                  <Table.Td fw={600}>
                    {formatPlanPrice(proPlan, billingInterval)}
                  </Table.Td>
                </Table.Tr>
                {PRICING_ROWS.map((row) => (
                  <Table.Tr key={row.label}>
                    <Table.Td c="dimmed">{row.label}</Table.Td>
                    <Table.Td>{row.free}</Table.Td>
                    <Table.Td>{row.basic}</Table.Td>
                    <Table.Td>{row.pro}</Table.Td>
                  </Table.Tr>
                ))}
                <Table.Tr>
                  <Table.Td />
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="subtle"
                      component="a"
                      href={DISCORD_BOT_INVITE_URL}
                      onClick={trackInvite("pricing-free")}
                    >
                      Get started
                    </Button>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      data-testid="home-cta-basic"
                      onClick={() => startUpgrade("basic")}
                    >
                      Upgrade
                    </Button>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      data-testid="home-cta-pro"
                      onClick={() => startUpgrade("pro")}
                    >
                      Upgrade
                    </Button>
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Text size="xs" c="dimmed">
            Meetings cap at 2 hours right now.
          </Text>
        </Stack>

        <Group gap="md" wrap="wrap" align="center">
          <Button
            size="md"
            component="a"
            href={DISCORD_BOT_INVITE_URL}
            onClick={trackInvite("footer-cta")}
          >
            Add to Discord
          </Button>
          <Text size="sm" c="dimmed">
            The first summary lands after your next call.
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
