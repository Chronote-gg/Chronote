import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import BillingRenewalStatus from "../../src/frontend/components/BillingRenewalStatus";
import BillingPaymentHistory from "../../src/frontend/components/BillingPaymentHistory";
import { renderWithMantine } from "./testUtils";
import { renewalQuote } from "../fixtures/renewal";
const actions = () => ({
  onConfirm: jest.fn(),
  onCheckStatus: jest.fn(),
  onRetry: jest.fn(),
  onPortal: jest.fn(),
  busy: false,
  canManageBilling: true,
});
it("shows verified exclusive renewal terms and submits exactly the displayed consent", () => {
  const callbacks = actions();
  renderWithMantine(
    <BillingRenewalStatus
      {...callbacks}
      state={{
        kind: "off",
        tier: "basic",
        endsAt: renewalQuote.terms.renewsAt,
        action: {
          kind: "ready",
          quoteToken: "signed-quote",
          expiresAt: 1300000,
          terms: renewalQuote.terms,
        },
      }}
    />,
  );
  expect(screen.getByText("Renewal off")).toBeTruthy();
  expect(
    screen.getByText("Your Basic plan ends October 12, 2027."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Turn renewal back on to continue at $100/year before tax.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn renewal back on" }));
  expect(callbacks.onConfirm).toHaveBeenCalledWith("signed-quote");
  expect(callbacks.onPortal).not.toHaveBeenCalled();
});
it("keeps inclusive tax and a remaining discount truthful", () => {
  renderWithMantine(
    <BillingRenewalStatus
      {...actions()}
      state={{
        kind: "on",
        terms: {
          ...renewalQuote.terms,
          interval: "month",
          unitAmount: 600,
          taxBehavior: "inclusive",
          discount: {
            endsAt: "2027-12-12T12:00:00.000Z",
            regularUnitAmount: 1000,
          },
        },
      }}
    />,
  );
  expect(screen.getByText(/\$6\/month, tax included/)).toBeTruthy();
  expect(screen.getByText(/\$10\/month/)).toBeTruthy();
  expect(screen.queryByText(/before tax/)).toBeNull();
});
it("never offers payer actions to another manager, including inconsistent ready input", () => {
  const callbacks = actions();
  renderWithMantine(
    <BillingRenewalStatus
      {...callbacks}
      canManageBilling={false}
      state={{
        kind: "off",
        tier: "basic",
        endsAt: renewalQuote.terms.renewsAt,
        action: {
          kind: "ready",
          quoteToken: "signed-quote",
          expiresAt: 1300000,
          terms: renewalQuote.terms,
        },
      }}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Turn renewal back on" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  expect(screen.getByText(/original payer/)).toBeTruthy();
});
it("recovers the existing operation without another confirmation", () => {
  const callbacks = actions();
  renderWithMantine(
    <BillingRenewalStatus
      {...callbacks}
      state={{
        kind: "processing",
        operationId: "existing-operation",
        endsAt: renewalQuote.terms.renewsAt,
      }}
    />,
  );
  expect(screen.getByText("Checking renewal")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Turn renewal back on" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(callbacks.onCheckStatus).toHaveBeenCalledWith("existing-operation");
});
it("does not infer an ended subscription from unavailable terms", () => {
  renderWithMantine(
    <BillingRenewalStatus
      {...actions()}
      state={{ kind: "unavailable", knownEndsAt: renewalQuote.terms.renewsAt }}
    />,
  );
  expect(screen.getByText(/October 12, 2027/)).toBeTruthy();
  expect(screen.queryByText(/Free|Get Basic again/)).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});
it("keeps payment amounts behind history disclosure and payer-only receipts outside", async () => {
  const onViewReceipts = jest.fn();
  renderWithMantine(
    <BillingPaymentHistory
      firstYearPayment={{
        status: "available",
        currency: "usd",
        discountedSubtotal: 6000,
        amountPaid: 6420,
        periodStartsAt: "2026-10-12T12:00:00.000Z",
        periodEndsAt: "2027-10-12T12:00:00.000Z",
      }}
      previousStatus="active"
      canViewReceipts
      onViewReceipts={onViewReceipts}
      busy={false}
    />,
  );
  expect(screen.getByText(/\$64.20/)).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Payment history" }));
  await waitFor(() => expect(screen.getByText(/\$64.20/)).toBeVisible());
  fireEvent.click(
    screen.getByRole("button", { name: "View invoices and receipts" }),
  );
  expect(onViewReceipts).toHaveBeenCalledTimes(1);
});
it("preserves readable payment summary without exposing another payer's portal", () => {
  renderWithMantine(
    <BillingPaymentHistory
      firstYearPayment={{ status: "unavailable" }}
      previousStatus="active"
      canViewReceipts={false}
      onViewReceipts={jest.fn()}
      busy={false}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "View invoices and receipts" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Payment history" }));
  expect(screen.getByText(/original payer/)).toBeTruthy();
});
it("lets an original claimant check a pending operation while receipt permission is unavailable", () => {
  const callbacks = actions();
  renderWithMantine(
    <BillingRenewalStatus
      {...callbacks}
      canManageBilling={false}
      state={{
        kind: "processing",
        operationId: "existing-operation",
        endsAt: renewalQuote.terms.renewsAt,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(callbacks.onCheckStatus).toHaveBeenCalledWith("existing-operation");
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
});
it("retains previous-subscription summary without granting receipt-account access", () => {
  renderWithMantine(
    <BillingPaymentHistory
      firstYearPayment={null}
      previousStatus="canceled"
      canViewReceipts={false}
      onViewReceipts={jest.fn()}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Payment history" }));
  expect(screen.getByText("Previous subscription: Canceled.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "View invoices and receipts" }),
  ).toBeNull();
});
it("keeps review-operation status checks available without receipt access", () => {
  const callbacks = actions();
  renderWithMantine(
    <BillingRenewalStatus
      {...callbacks}
      canManageBilling={false}
      state={{
        kind: "needs_review",
        operationId: "existing-operation",
        knownEndsAt: renewalQuote.terms.renewsAt,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect(callbacks.onCheckStatus).toHaveBeenCalledWith("existing-operation");
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
});
it.each([true, false])(
  "keeps a known payment problem visible with payer permission %s",
  (canManageBilling) => {
    const callbacks = actions();
    renderWithMantine(
      <BillingRenewalStatus
        {...callbacks}
        canManageBilling={canManageBilling}
        state={{ kind: "payment_problem" }}
      />,
    );
    expect(screen.getByText("Payment needs attention")).toBeVisible();
    if (canManageBilling) {
      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      expect(callbacks.onPortal).toHaveBeenCalledTimes(1);
    } else
      expect(
        screen.queryByRole("button", { name: "Manage billing" }),
      ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Turn renewal back on" }),
    ).toBeNull();
  },
);
