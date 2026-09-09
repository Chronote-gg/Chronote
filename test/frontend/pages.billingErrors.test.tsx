import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Notifications, notifications } from "@mantine/notifications";
import { TRPCClientError } from "@trpc/client";
import {
  authState,
  guildState,
  renderWithMantine,
  resetFrontendMocks,
} from "./testUtils";
import {
  billingCheckoutMutation,
  billingPortalMutation,
  setBillingQuery,
  setPricingQuery,
} from "./mocks/trpc";
import Billing from "../../src/frontend/pages/Billing";
import UpgradeServerSelect from "../../src/frontend/pages/UpgradeServerSelect";

const payerMessage =
  "Only the original payer can manage this server's Stripe billing";
const recoveryMessage =
  "Resolve the existing subscription in billing management before changing plans";
const rpcError = (code: string, message: string) =>
  new TRPCClientError(message, {
    result: { error: { code: -32003, message, data: { code } } },
  });

describe.each([
  ["Billing", Billing],
  ["Upgrade server selection", UpgradeServerSelect],
] as const)("%s billing action errors", (_name, Page) => {
  beforeEach(() => {
    resetFrontendMocks();
    notifications.clean();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    authState.state = "authenticated";
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setPricingQuery({
      data: {
        plans: [
          {
            tier: "basic",
            interval: "month",
            priceId: "price_basic",
            unitAmount: 500,
            currency: "usd",
          },
          {
            tier: "pro",
            interval: "month",
            priceId: "price_pro",
            unitAmount: 1500,
            currency: "usd",
          },
        ],
      },
    });
  });
  afterEach(() => {
    cleanup();
    act(() => notifications.clean());
    jest.restoreAllMocks();
  });

  describe.each(["checkout", "portal"] as const)("%s", (action) => {
    test.each([
      ["payer denial", rpcError("FORBIDDEN", payerMessage), payerMessage],
      [
        "subscription recovery",
        rpcError("BAD_REQUEST", recoveryMessage),
        recoveryMessage,
      ],
      [
        "promotion validation",
        rpcError("BAD_REQUEST", "Invalid promotion code"),
        "Invalid promotion code",
      ],
      [
        "unexpected provider failure",
        rpcError("INTERNAL_SERVER_ERROR", "promotion provider secret details"),
        null,
      ],
      ["untyped failure", new Error("promotion provider secret details"), null],
    ])(
      "shows the appropriate message for %s",
      async (_case, error, expected) => {
        setBillingQuery({
          data: {
            billingEnabled: true,
            tier: action === "portal" ? "pro" : "free",
            status: "active",
            canManageBillingPortal: true,
            usage: null,
          },
        });
        const mutation =
          action === "portal" ? billingPortalMutation : billingCheckoutMutation;
        mutation.mutateAsync.mockRejectedValueOnce(error);
        renderWithMantine(
          <>
            <Page />
            <Notifications transitionDuration={0} autoClose={false} />
          </>,
        );
        fireEvent.click(
          screen.getByRole("button", {
            name:
              action === "portal"
                ? /manage billing/i
                : Page === Billing
                  ? /upgrade to pro/i
                  : /continue to stripe/i,
          }),
        );
        const message =
          expected ??
          (action === "portal"
            ? "Could not open billing portal. Please try again."
            : "Could not start checkout. Please try again.");
        expect(await screen.findByText(message)).toBeVisible();
        expect(
          screen.queryByText("promotion provider secret details"),
        ).not.toBeInTheDocument();
      },
    );
  });
});
