import { TRPCClientError } from "@trpc/client";
import { notifications } from "@mantine/notifications";

export function showBillingError(
  error: unknown,
  action: "checkout" | "portal",
) {
  const expected =
    error instanceof TRPCClientError &&
    (error.data?.code === "FORBIDDEN" || error.data?.code === "BAD_REQUEST");
  notifications.show({
    color: "red",
    title: action === "checkout" ? "Checkout failed" : "Billing portal failed",
    message: expected
      ? error.message
      : action === "checkout"
        ? "Could not start checkout. Please try again."
        : "Could not open billing portal. Please try again.",
  });
}
