import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, jest } from "@jest/globals";
import { resetFrontendMocks } from "./testUtils";
import { billingChangeQuery, trpcUtils } from "./mocks/trpc";
import { useBillingChange } from "../../src/frontend/hooks/useBillingChange";
import { previewChangeReview } from "../../src/frontend/pages/billingChangeFixtures";
beforeEach(resetFrontendMocks);
it.each(["succeeded", "none"] as const)(
  "refreshes billing after a pending read becomes %s",
  async (state) => {
    const operation = {
      ...previewChangeReview({
        tier: "pro",
        interval: "month",
        expectedOffer: "none",
      }),
      state: "accepted" as const,
    };
    billingChangeQuery.data = operation;
    const onBillingChanged = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const { rerender } = renderHook(() =>
      useBillingChange({ serverId: "g1", active: true, onBillingChanged }),
    );
    expect(onBillingChanged).not.toHaveBeenCalled();
    billingChangeQuery.data =
      state === "none"
        ? { kind: "none", enabled: true }
        : { ...operation, state };
    await act(async () => {
      rerender();
    });
    expect(onBillingChanged).toHaveBeenCalledTimes(1);
    expect(trpcUtils.billing.change.invalidate).toHaveBeenCalledWith({
      serverId: "g1",
    });
    await act(async () => {
      rerender();
    });
    expect(onBillingChanged).toHaveBeenCalledTimes(1);
  },
);

it("recovers an operation for terminal subscription history without enabling a new change", () => {
  billingChangeQuery.data = { kind: "none", enabled: true };
  const onBillingChanged = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useBillingChange({
      serverId: "g1",
      active: true,
      canStart: false,
      onBillingChanged,
    }),
  );
  expect(result.current.enabled).toBe(false);
});
