import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SubscriptionDetails from "./SubscriptionDetails";
import type { ProviderSubscriptionDetails } from "../../types/pricing";

const annual: ProviderSubscriptionDetails = {
  status: "available",
  priceId: "basic-year",
  currency: "usd",
  unitAmount: 10000,
  discountedUnitAmount: null,
  interval: "year",
  renewalAt: "2027-10-12T12:00:00Z",
  cancelAtPeriodEnd: false,
  discount: null,
  planChangesRestricted: false,
  planChangeRestrictionEndsAt: null,
  firstYearPayment: {
    status: "available",
    currency: "usd",
    discountedSubtotal: 6000,
    amountPaid: 6420,
    periodStartsAt: "2026-10-12T12:00:00Z",
    periodEndsAt: "2027-10-12T12:00:00Z",
  },
};
const show = (details: ProviderSubscriptionDetails) =>
  render(
    <MantineProvider>
      <SubscriptionDetails details={details} />
    </MantineProvider>,
  );
it("separates verified first-year payment including tax from annual renewal", () => {
  show(annual);
  expect(screen.getByText(/\$64.20 paid/)).toBeVisible();
  expect(screen.getByText(/10\/12\/2026 to 10\/12\/2027/)).toBeVisible();
  expect(screen.getByText(/Next renewal: \$100\/year/)).toBeVisible();
  expect(screen.queryByText(/restricted/)).not.toBeInTheDocument();
});
it("does not invent paid first-year price when invoice evidence is unavailable", () => {
  show({ ...annual, firstYearPayment: { status: "unavailable" } });
  expect(
    screen.getByText(/First-year payment details are unavailable/),
  ).toBeVisible();
  expect(screen.queryByText(/\$60/)).not.toBeInTheDocument();
});
it("shows the monthly discount without treating an active offer as a warning", () => {
  show({
    ...annual,
    interval: "month",
    unitAmount: 1000,
    discountedUnitAmount: 600,
    firstYearPayment: null,
    planChangesRestricted: true,
    planChangeRestrictionEndsAt: null,
    discount: {
      introductory: true,
      endsAt: null,
      durationMonths: 3,
      percentOff: 40,
      amountOff: null,
    },
  });
  expect(screen.getByText(/Current price: \$6\/month/)).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByTestId("payment-settling")).not.toBeInTheDocument();
});
it("keeps cancellation honest and does not call it a renewal", () => {
  show({ ...annual, cancelAtPeriodEnd: true });
  expect(
    screen.getByText(
      `Cancels on ${new Date(annual.renewalAt!).toLocaleDateString()}. No automatic renewal.`,
    ),
  ).toBeVisible();
  expect(screen.queryByText(/Next renewal/)).not.toBeInTheDocument();
});

it("shows a neutral message while a payment is pending", () => {
  render(
    <MantineProvider>
      <SubscriptionDetails
        details={{ ...annual, paymentProgress: "processing" }}
      />
    </MantineProvider>,
  );
  expect(screen.getByTestId("payment-settling")).toHaveTextContent(
    "Your previous payment is still being settled. Please come back later.",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("unknown payment status does not claim unpaid or processing", () => {
  show({ ...annual, paymentProgress: "unavailable" });
  expect(screen.getByTestId("payment-status-unavailable")).toHaveTextContent(
    "check the status",
  );
  expect(screen.queryByTestId("payment-settling")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("payment-needs-attention"),
  ).not.toBeInTheDocument();
});
it("action-required payment points at a check instead of telling the user to wait", () => {
  show({ ...annual, paymentProgress: "action_required" });
  expect(screen.getByTestId("payment-needs-attention")).toHaveTextContent(
    "Open Manage billing",
  );
  expect(screen.queryByTestId("payment-settling")).not.toBeInTheDocument();
});
