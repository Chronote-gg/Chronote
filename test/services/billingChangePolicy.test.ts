import { resolveChangeTiming } from "../../src/services/billingChangePolicy";

describe("plan change timing", () => {
  it.each([
    ["basic", "month", "basic", "year", "immediate"],
    ["basic", "year", "basic", "month", "renewal"],
    ["basic", "month", "pro", "month", "immediate"],
    ["basic", "month", "pro", "year", "immediate"],
    ["basic", "year", "pro", "month", "immediate"],
    ["basic", "year", "pro", "year", "immediate"],
    ["pro", "month", "basic", "month", "renewal"],
    ["pro", "month", "basic", "year", "renewal"],
    ["pro", "year", "basic", "month", "renewal"],
    ["pro", "year", "basic", "year", "renewal"],
    ["pro", "month", "pro", "year", "immediate"],
    ["pro", "year", "pro", "month", "renewal"],
    ["basic", "month", "free", "month", "renewal"],
    ["basic", "year", "free", "year", "renewal"],
    ["pro", "month", "free", "month", "renewal"],
    ["pro", "year", "free", "year", "renewal"],
    ["basic", "month", "basic", "month", "unchanged"],
    ["basic", "year", "basic", "year", "unchanged"],
    ["pro", "month", "pro", "month", "unchanged"],
    ["pro", "year", "pro", "year", "unchanged"],
  ] as const)(
    "%s/%s to %s/%s is %s",
    (sourceTier, sourceInterval, targetTier, targetInterval, expected) => {
      expect(
        resolveChangeTiming({
          sourceTier,
          sourceInterval,
          targetTier,
          targetInterval,
        }),
      ).toBe(expected);
    },
  );
});
