jest.mock("../../src/db", () => ({ tryCreateInteractionReceipt: jest.fn() }));
jest.mock("../../src/services/configService", () => ({
  config: {
    stripe: { secretKey: "test-only" },
    subscription: { stripeMode: "test" },
    frontend: { siteUrl: "https://chronote.test" },
  },
}));
jest.mock("../../src/services/subscriptionService", () => ({
  resolveGuildSubscription: jest.fn(),
}));
jest.mock("../../src/repositories/subscriptionRepository", () => ({
  getSubscriptionRepository: () => ({ get: mockGetSubscription }),
}));

import { tryCreateInteractionReceipt } from "../../src/db";
import { config } from "../../src/services/configService";
import { resolveGuildSubscription } from "../../src/services/subscriptionService";
import { claimSummaryUpgradeUrl } from "../../src/services/summaryUpgradeService";
import type { MeetingData } from "../../src/types/meeting-data";

const mockGetSubscription = jest.fn();
const claim = jest.mocked(tryCreateInteractionReceipt);
const resolve = jest.mocked(resolveGuildSubscription);
const meeting = () =>
  ({
    guildId: "123456789",
    generateNotes: true,
    notesText: "The team agreed on next steps.",
    processing: { transcription: "ready", notes: "generated" },
  }) as MeetingData;

beforeEach(() => {
  jest.clearAllMocks();
  config.stripe.secretKey = "test-only";
  config.subscription.stripeMode = "test";
  resolve.mockResolvedValue({
    tier: "free",
    status: "free",
    source: "default",
    billingSource: "free",
    stripeTier: null,
    grantTier: null,
    activeGrant: null,
  });
  mockGetSubscription.mockResolvedValue(undefined);
  claim.mockResolvedValue(true);
});

test("preserves the server and Basic plan with a durable seven-day claim", async () => {
  const now = Date.now();
  jest.spyOn(Date, "now").mockReturnValue(now);
  expect(await claimSummaryUpgradeUrl(meeting())).toBe(
    "https://chronote.test/upgrade/select-server?serverId=123456789&plan=basic",
  );
  expect(claim).toHaveBeenCalledWith({
    interactionId: "summary-upgrade:123456789",
    interactionKind: "summary_upgrade",
    guildId: "123456789",
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + 7 * 24 * 60 * 60,
  });
  claim.mockResolvedValue(false);
  expect(await claimSummaryUpgradeUrl(meeting())).toBeUndefined();
  jest.restoreAllMocks();
});

test.each([
  { cancelled: true },
  { generateNotes: false },
  { notesText: " " },
  { processing: { transcription: "empty", notes: "skipped" } },
  { processing: { transcription: "partial", notes: "generated" } },
  { processing: { transcription: "ready", notes: "failed" } },
  { processing: undefined },
])("skips canceled or unsuccessful meetings: %j", async (override) => {
  expect(
    await claimSummaryUpgradeUrl({ ...meeting(), ...override } as MeetingData),
  ).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

test.each([
  { tier: "basic", source: "stripe", billingSource: "stripe" },
  { tier: "pro", source: "stripe", billingSource: "stripe" },
  { tier: "basic", source: "manual_comp", billingSource: "manual_comp" },
  { tier: "free", source: "forced", billingSource: "forced" },
] as const)(
  "skips paid, complimentary and forced access: %j",
  async (subscription) => {
    resolve.mockResolvedValue({
      ...(await resolve("123456789")),
      ...subscription,
    });
    expect(await claimSummaryUpgradeUrl(meeting())).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  },
);

test.each(["stripeSubscriptionId", "stripeCustomerId"])(
  "skips existing %s while subscription transitions remain guarded",
  async (pointer) => {
    mockGetSubscription.mockResolvedValue({ [pointer]: "existing" });
    expect(await claimSummaryUpgradeUrl(meeting())).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  },
);

test("skips disabled billing and fails quietly when persistence is unavailable", async () => {
  config.subscription.stripeMode = "disabled";
  expect(await claimSummaryUpgradeUrl(meeting())).toBeUndefined();
  expect(claim).not.toHaveBeenCalled();
  config.subscription.stripeMode = "test";
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  claim.mockRejectedValueOnce(new Error("unavailable"));
  expect(await claimSummaryUpgradeUrl(meeting())).toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
