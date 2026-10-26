/** @jest-environment node */
import {
  parseBillingHistoryArgs,
  billingHistorySummary,
} from "../../scripts/billing-history";
test("import defaults to dry-run and requires explicit account, mode, server and cutoff", () => {
  expect(
    parseBillingHistoryArgs([
      "import",
      "--account",
      "acct-owned",
      "--mode",
      "test",
      "--guild",
      "111111111111111111",
      "--cutoff",
      "1000",
    ]),
  ).toMatchObject({ command: "import", apply: false, createdBefore: 1000 });
  expect(() =>
    parseBillingHistoryArgs([
      "import",
      "--account",
      "acct-owned",
      "--mode",
      "test",
    ]),
  ).toThrow();
});
test("an apply flag cannot replace scope or boundary revision", () => {
  expect(() =>
    parseBillingHistoryArgs([
      "invalidate",
      "--account",
      "acct-owned",
      "--mode",
      "test",
      "--apply",
    ]),
  ).toThrow();
  expect(
    parseBillingHistoryArgs([
      "invalidate",
      "--account",
      "acct-owned",
      "--mode",
      "test",
      "--revision",
      "reviewed-r1",
      "--apply",
    ]),
  ).toMatchObject({ apply: true, expectedRevision: "reviewed-r1" });
});
test("help does not require configured financial scope", () => {
  expect(parseBillingHistoryArgs(["--help"])).toEqual({ command: "help" });
});

test("an absent invalidation is reported honestly without leaking private scope", () => {
  expect(
    billingHistorySummary("invalidate", "test", {
      status: "absent",
      accountId: "private",
    }),
  ).toEqual({ command: "invalidate", mode: "test", action: "absent" });
});
