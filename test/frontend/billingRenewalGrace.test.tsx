import React from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import BillingRenewalGrace from "../../src/frontend/components/BillingRenewalGrace";
import type { RenewalRecoveryView } from "../../src/types/renewalRecovery";
import { renderWithMantine } from "./testUtils";

const endsAt = "2026-10-18T14:00:00.000Z";
const view = (
  overrides: Partial<Exclude<RenewalRecoveryView, { status: "none" }>> = {},
): RenewalRecoveryView => ({
  status: "grace",
  priorTier: "basic",
  selectedTier: "basic",
  selectedInterval: "month",
  scheduledChange: false,
  endsAt,
  amountDue: 1000,
  currency: "usd",
  paymentUrl: "https://invoice.stripe.com/i/owned",
  canManage: true,
  ...overrides,
});
function renderRecovery(
  value: RenewalRecoveryView = view(),
  grantTier: "basic" | "pro" | null = null,
) {
  const recovery = {
    view: value,
    busy: false,
    error: null,
    refresh: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    pending: value.status !== "none" && value.status !== "canceled",
  };
  const onUpdatePaymentMethod = jest.fn();
  return {
    ...renderWithMantine(
      <BillingRenewalGrace
        recovery={recovery}
        serverName="Engineering HQ"
        onUpdatePaymentMethod={onUpdatePaymentMethod}
        grantTier={grantTier}
      />,
    ),
    recovery,
    onUpdatePaymentMethod,
  };
}
beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T14:00:00Z"));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
test.each(["basic", "pro"] as const)(
  "names the %s renewal and shows the same invoice, amount and local deadline",
  (tier) => {
    renderRecovery(view({ priorTier: tier, selectedTier: tier }));
    expect(
      screen.getByText(
        new RegExp(
          `couldn't collect your ${tier === "basic" ? "Basic" : "Pro"} renewal payment`,
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Retry payment" })).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/owned",
    );
    expect(screen.getByText("$10 due")).toBeInTheDocument();
    const time = document.querySelector("time");
    expect(time).toHaveAttribute("dateTime", endsAt);
    expect(time?.textContent).toMatch(/GMT|UTC|EDT|EST/);
  },
);
test("separates a scheduled Basic charge from the Pro plan that remains available", () => {
  renderRecovery(
    view({ priorTier: "pro", selectedTier: "basic", scheduledChange: true }),
  );
  expect(screen.getByText(/scheduled change to Basic/)).toBeInTheDocument();
  expect(screen.getByText(/keep using Pro until/)).toBeInTheDocument();
  expect(
    screen.queryByText(/Complete payment to switch/),
  ).not.toBeInTheDocument();
});
test("requires confirmation before canceling and preserves the original access deadline", async () => {
  const { recovery } = renderRecovery();
  fireEvent.click(screen.getByRole("button", { name: "Cancel renewal" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Cancel this renewal?",
  });
  expect(
    within(dialog).getByText(/unpaid plan charge will be removed/),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/choose another plan once/),
  ).toBeInTheDocument();
  expect(recovery.cancel).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Cancel renewal" }),
  );
  expect(recovery.cancel).toHaveBeenCalledTimes(1);
});
test("card update opens billing without claiming that the renewal was paid", () => {
  const { onUpdatePaymentMethod } = renderRecovery();
  fireEvent.click(
    screen.getByRole("button", { name: "Update payment method" }),
  );
  expect(onUpdatePaymentMethod).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/payment complete/i)).not.toBeInTheDocument();
});
test.each(["settlement_pending", "reconciling"] as const)(
  "uses a quiet %s state without a payable link",
  (status) => {
    renderRecovery(view({ status, paymentUrl: null }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Retry payment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh status" }),
    ).toBeInTheDocument();
  },
);
test("canceled renewal retains access and allows choosing another plan", () => {
  renderRecovery(
    view({ status: "canceled", priorTier: "pro", paymentUrl: null }),
  );
  expect(screen.getByText("Renewal canceled")).toBeInTheDocument();
  expect(screen.getByText(/keep using Pro until/)).toBeInTheDocument();
  expect(screen.getByText(/choose another plan now/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel renewal" }),
  ).not.toBeInTheDocument();
});
test("the exact deadline removes retry actions even before a fresh server response", async () => {
  jest.useFakeTimers();
  jest.spyOn(Date, "now").mockRestore();
  jest.setSystemTime(Date.parse(endsAt) - 1);
  renderRecovery();
  expect(
    screen.getByRole("link", { name: "Retry payment" }),
  ).toBeInTheDocument();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
  expect(
    screen.queryByRole("link", { name: "Retry payment" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/now on Free/)).toBeInTheDocument();
});
test("does not promise Free when complimentary access will continue", () => {
  renderRecovery(view({ priorTier: "pro" }), "basic");
  expect(
    screen.getByText(/complimentary Basic access will continue/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/move to Free/)).not.toBeInTheDocument();
});
test("another manager sees the state without payer actions", () => {
  renderRecovery(view({ canManage: false, paymentUrl: null }));
  expect(
    screen.queryByRole("button", { name: "Cancel renewal" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Update payment method" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/original payer/)).toBeInTheDocument();
});
