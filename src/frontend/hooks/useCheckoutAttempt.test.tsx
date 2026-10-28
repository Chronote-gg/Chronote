import { act, renderHook } from "@testing-library/react";
import { useCheckoutAttempt } from "./useCheckoutAttempt";
import { showBillingError } from "../utils/billingErrorNotification";

jest.mock("../utils/billingErrorNotification", () => ({
  showBillingError: jest.fn(),
}));

const request = {
  serverId: "s1",
  tier: "basic" as const,
  interval: "month" as const,
};

function setup() {
  const hook = renderHook(() =>
    useCheckoutAttempt("s1", async () => undefined),
  );
  act(() => {
    hook.result.current.begin(request, { status: "inactive" });
  });
  return hook;
}

afterEach(() => jest.clearAllMocks());

it("retry resubmits the saved request and reports a current failure", async () => {
  const { result } = setup();
  const submit = jest.fn().mockRejectedValue(new Error("network"));
  await act(() => result.current.retry(submit));
  expect(submit).toHaveBeenCalledWith(request);
  expect(showBillingError).toHaveBeenCalledWith(expect.any(Error), "checkout");
});

it("retry ignores a failure that lands after the attempt was refreshed", async () => {
  const { result } = setup();
  let fail: (error: Error) => void = () => undefined;
  const submit = jest.fn(
    () => new Promise<{ url: string }>((_, reject) => (fail = reject)),
  );
  let pending: Promise<void> = Promise.resolve();
  act(() => {
    pending = result.current.retry(submit);
  });
  act(() => result.current.refresh());
  await act(async () => {
    fail(new Error("late"));
    await pending;
  });
  expect(showBillingError).not.toHaveBeenCalled();
});

it("retry does nothing without a saved attempt", async () => {
  const { result } = renderHook(() =>
    useCheckoutAttempt("s1", async () => undefined),
  );
  const submit = jest.fn();
  await act(() => result.current.retry(submit));
  expect(submit).not.toHaveBeenCalled();
});
