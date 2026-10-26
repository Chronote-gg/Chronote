import { act, renderHook } from "@testing-library/react";
import { resetFrontendMocks } from "./testUtils";
import { billingRenewalCancelMutation, trpcUtils } from "./mocks/trpc";
import { useBillingRenewalRecovery } from "../../src/frontend/hooks/useBillingRenewalRecovery";
import type { RenewalRecoveryView } from "../../src/types/renewalRecovery";
const view = (): RenewalRecoveryView => ({
  status: "grace",
  priorTier: "pro",
  selectedTier: "basic",
  selectedInterval: "month",
  scheduledChange: true,
  endsAt: new Date(Date.now() + 45000).toISOString(),
  amountDue: 1000,
  currency: "usd",
  paymentUrl: "https://invoice.stripe.com/i/owned",
  canManage: true,
});
beforeEach(() => {
  resetFrontendMocks();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});
test("cancellation uses the selected server and refreshes billing and both old controls", async () => {
  const onBillingChanged = jest.fn(async () => undefined);
  billingRenewalCancelMutation.mutateAsync.mockResolvedValue({
    ...view(),
    status: "canceled",
    paymentUrl: null,
  });
  const { result } = renderHook(() =>
    useBillingRenewalRecovery({
      serverId: "g1",
      active: true,
      view: view(),
      onBillingChanged,
    }),
  );
  await act(async () => {
    await result.current.cancel();
  });
  expect(billingRenewalCancelMutation.mutateAsync).toHaveBeenCalledWith({
    serverId: "g1",
  });
  expect(trpcUtils.billing.me.setData).toHaveBeenCalledWith(
    { serverId: "g1" },
    expect.any(Function),
  );
  expect(onBillingChanged).toHaveBeenCalled();
  expect(trpcUtils.billing.change.invalidate).toHaveBeenCalledWith({
    serverId: "g1",
  });
  expect(trpcUtils.billing.renewal.invalidate).toHaveBeenCalledWith({
    serverId: "g1",
  });
});
test("a failed cancellation refreshes status and retains a calm error", async () => {
  const onBillingChanged = jest.fn(async () => undefined);
  billingRenewalCancelMutation.mutateAsync.mockRejectedValue(
    new Error("Provider unavailable"),
  );
  const { result } = renderHook(() =>
    useBillingRenewalRecovery({
      serverId: "g1",
      active: true,
      view: view(),
      onBillingChanged,
    }),
  );
  await act(async () => {
    await result.current.cancel();
  });
  expect(result.current.error).toMatch(/check.*status/i);
  expect(onBillingChanged).toHaveBeenCalled();
});
test("polls pending payment and refreshes at the original deadline, then cleans up timers", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(100000);
  const onBillingChanged = jest.fn(async () => undefined);
  const current = view();
  const { unmount } = renderHook(() =>
    useBillingRenewalRecovery({
      serverId: "g1",
      active: true,
      view: current,
      onBillingChanged,
    }),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(30000);
  });
  expect(onBillingChanged).toHaveBeenCalledTimes(1);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(15000);
  });
  expect(onBillingChanged).toHaveBeenCalledTimes(2);
  unmount();
  await jest.advanceTimersByTimeAsync(60000);
  expect(onBillingChanged).toHaveBeenCalledTimes(2);
});
test("a late result cannot update the newly selected server", async () => {
  let finish!: (result: RenewalRecoveryView) => void;
  billingRenewalCancelMutation.mutateAsync.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const onBillingChanged = jest.fn(async () => undefined);
  const { result, rerender } = renderHook(
    ({ serverId }) =>
      useBillingRenewalRecovery({
        serverId,
        active: true,
        view: view(),
        onBillingChanged,
      }),
    { initialProps: { serverId: "g1" } },
  );
  let cancellation!: Promise<void>;
  act(() => {
    cancellation = result.current.cancel();
  });
  rerender({ serverId: "g2" });
  await act(async () => {
    finish({ status: "none" });
    await cancellation;
  });
  expect(trpcUtils.billing.me.setData).not.toHaveBeenCalled();
  expect(onBillingChanged).not.toHaveBeenCalled();
});
test("a successful payment read clears the recovery and refreshes plan controls", async () => {
  const onBillingChanged = jest.fn(async () => undefined);
  const { result, rerender } = renderHook(
    ({ current }: { current: RenewalRecoveryView }) =>
      useBillingRenewalRecovery({
        serverId: "g1",
        active: true,
        view: current,
        onBillingChanged,
      }),
    { initialProps: { current: view() } },
  );
  await act(async () => {
    rerender({ current: { status: "none" } });
  });
  expect(result.current.pending).toBe(false);
  expect(trpcUtils.billing.change.invalidate).toHaveBeenCalled();
});
