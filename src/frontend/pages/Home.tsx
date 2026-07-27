import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Container,
  Group,
  List,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import AddToDiscordButton from "../components/AddToDiscordButton";
import SampleSummary from "../components/SampleSummary";
import Wordmark from "../components/Wordmark";
import { trpc } from "../services/trpc";
import { track } from "../services/analytics";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import {
  annualSavingsLabel,
  buildPaidPlanLookup,
  formatPlanPrice,
  resolvePaidPlan,
} from "../utils/pricing";

const PRICING_TABLE_MIN_WIDTH = 560;
const RECOMMENDED_TIER_TINT = "rgba(111, 117, 255, 0.08)";

const CAPABILITIES = [
  "Ask what was decided and get the quote with its timestamp",
  "Auto-record the channels you pick",
  "Captures chat and attendance too",
  "Corrections, approved by your team",
  "A dictionary for your server's jargon",
  "Export audio, transcript, and notes",
  "Send notes to Notion",
  "Replies out loud, and reads typed messages aloud",
  "MCP access for Claude and other clients",
];

const CAPABILITY_COLUMNS = [
  CAPABILITIES.slice(0, Math.ceil(CAPABILITIES.length / 2)),
  CAPABILITIES.slice(Math.ceil(CAPABILITIES.length / 2)),
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

const recommendedCell = { backgroundColor: RECOMMENDED_TIER_TINT };

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

  return (
    <Container size={720} pt={{ base: 28, md: 48 }} pb={{ base: 48, md: 96 }}>
      <Stack gap={96}>
        <Stack gap="xl" align="center" ta="center" data-testid="home-hero">
          <Wordmark fz={{ base: 26, md: 34 }} />
          <Title
            order={1}
            fw={600}
            fz={{ base: 34, md: 48 }}
            lh={1.1}
            style={{ letterSpacing: "-0.03em", textWrap: "balance" }}
          >
            Writes down notes so you don&apos;t have to.
          </Title>
          <Text size="lg" c="dimmed" maw={560}>
            Chronote joins your Discord voice calls and posts the summary back
            to the channel.
          </Text>
          <AddToDiscordButton location="hero" testId="home-cta-discord" />
        </Stack>

        <Stack gap="md" id="what-comes-back">
          <Title order={2} fz={22} fw={600}>
            What comes back
          </Title>
          <Text size="sm" c="dimmed">
            An example of the summary Chronote posts to your channel.
          </Text>
          <SampleSummary />
        </Stack>

        <Stack gap="md">
          <Title order={2} fz={22} fw={600}>
            Also
          </Title>
          <SimpleGrid
            cols={{ base: 1, sm: 2 }}
            spacing="xl"
            verticalSpacing={0}
          >
            {CAPABILITY_COLUMNS.map((column) => (
              <List key={column[0]} spacing="sm" size="md" withPadding>
                {column.map((capability) => (
                  <List.Item key={capability}>{capability}</List.Item>
                ))}
              </List>
            ))}
          </SimpleGrid>
        </Stack>

        <Stack gap="md">
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
          <Paper withBorder radius="md" p={{ base: "sm", sm: "lg" }}>
            <Table.ScrollContainer minWidth={PRICING_TABLE_MIN_WIDTH}>
              <Table verticalSpacing="sm" horizontalSpacing="md" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th />
                    <Table.Th>Free</Table.Th>
                    <Table.Th style={recommendedCell}>
                      <Group gap="xs" wrap="nowrap">
                        <span>Basic</span>
                        <Badge size="xs" variant="light">
                          Best value
                        </Badge>
                      </Group>
                    </Table.Th>
                    <Table.Th>Pro</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td c="dimmed">Price</Table.Td>
                    <Table.Td fw={700} fz="lg">
                      $0
                    </Table.Td>
                    <Table.Td fw={700} fz="lg" style={recommendedCell}>
                      {formatPlanPrice(basicPlan, billingInterval)}
                    </Table.Td>
                    <Table.Td fw={700} fz="lg">
                      {formatPlanPrice(proPlan, billingInterval)}
                    </Table.Td>
                  </Table.Tr>
                  {PRICING_ROWS.map((row) => (
                    <Table.Tr key={row.label}>
                      <Table.Td c="dimmed">{row.label}</Table.Td>
                      <Table.Td>{row.free}</Table.Td>
                      <Table.Td style={recommendedCell}>{row.basic}</Table.Td>
                      <Table.Td>{row.pro}</Table.Td>
                    </Table.Tr>
                  ))}
                  <Table.Tr>
                    <Table.Td />
                    <Table.Td />
                    <Table.Td style={recommendedCell}>
                      <Button
                        size="sm"
                        radius="md"
                        fw={600}
                        data-testid="home-cta-basic"
                        onClick={() => startUpgrade("basic")}
                      >
                        Upgrade
                      </Button>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="sm"
                        radius="md"
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
          </Paper>
        </Stack>

        <Group justify="center">
          <AddToDiscordButton location="footer-cta" />
        </Group>
      </Stack>
    </Container>
  );
}
