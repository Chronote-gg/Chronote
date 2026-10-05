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
jest.mock("../../src/services/meetingHistoryService", () => ({
  listAllMeetingsForGuildService: jest.fn(),
}));

import { tryCreateInteractionReceipt } from "../../src/db";
import { config } from "../../src/services/configService";
import { resolveGuildSubscription } from "../../src/services/subscriptionService";
import { claimSummaryUpgrade } from "../../src/services/summaryUpgradeService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import { listAllMeetingsForGuildService } from "../../src/services/meetingHistoryService";
import { buildSummaryUpgradeBody } from "../../src/utils/summaryUpgrade";

const mockGetSubscription = jest.fn();
const claim = jest.mocked(tryCreateInteractionReceipt);
const resolve = jest.mocked(resolveGuildSubscription);
const history = jest.mocked(listAllMeetingsForGuildService);
const meeting = () =>
  ({
    guildId: "123456789",
    meetingId: "current",
    startTime: new Date("2026-10-05T12:00:00Z"),
    endTime: new Date("2026-10-05T12:30:00Z"),
    transcribeMeeting: true,
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
  history.mockResolvedValue([]);
});

test("preserves the server and Basic plan with a durable seven-day claim", async () => {
  const now = Date.now();
  jest.spyOn(Date, "now").mockReturnValue(now);
  expect(await claimSummaryUpgrade(meeting())).toEqual({
    url: "https://chronote.test/upgrade/select-server?serverId=123456789&plan=basic",
    recordedSeconds: 1800,
  });
  expect(claim).toHaveBeenCalledWith({
    interactionId: "summary-upgrade:123456789",
    interactionKind: "summary_upgrade",
    guildId: "123456789",
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + 7 * 24 * 60 * 60,
  });
  claim.mockResolvedValue(false);
  expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
  expect(history).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});

test.each([
  { cancelled: true },
  { transcribeMeeting: false },
  { generateNotes: false },
  { notesText: " " },
  { processing: { transcription: "empty", notes: "skipped" } },
  { processing: { transcription: "partial", notes: "generated" } },
  { processing: { transcription: "ready", notes: "failed" } },
  { processing: undefined },
  { endTime: undefined },
])("skips canceled or unsuccessful meetings: %j", async (override) => {
  expect(
    await claimSummaryUpgrade({ ...meeting(), ...override } as MeetingData),
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
    expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  },
);

test.each(["stripeSubscriptionId", "stripeCustomerId"])(
  "skips existing %s while subscription transitions remain guarded",
  async (pointer) => {
    mockGetSubscription.mockResolvedValue({ [pointer]: "existing" });
    expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  },
);

test("skips disabled billing and fails quietly when persistence is unavailable", async () => {
  config.subscription.stripeMode = "disabled";
  expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
  expect(claim).not.toHaveBeenCalled();
  config.subscription.stripeMode = "test";
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  claim.mockRejectedValueOnce(new Error("unavailable"));
  expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("totals retained recorded meetings and includes the current meeting exactly once", async () => {
  history.mockResolvedValue([
    { meetingId: "older", transcribeMeeting: true, duration: 3600 },
    {
      meetingId: "archived",
      transcribeMeeting: true,
      duration: 1800,
      archivedAt: "2026-10-04",
    },
    { meetingId: "current", transcribeMeeting: true, duration: 60 },
    { meetingId: "chat-only", transcribeMeeting: false, duration: 3600 },
    { meetingId: "invalid", transcribeMeeting: true, duration: NaN },
    { meetingId: "negative", transcribeMeeting: true, duration: -60 },
  ] as MeetingHistory[]);
  expect(await claimSummaryUpgrade(meeting())).toEqual({
    url: expect.any(String),
    recordedSeconds: 7200,
  });
  expect(history).toHaveBeenCalledWith("123456789");
});

test("history failures omit the optional offer without failing meeting delivery", async () => {
  history.mockRejectedValueOnce(new Error("unavailable"));
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  expect(await claimSummaryUpgrade(meeting())).toBeUndefined();
  warn.mockRestore();
});

test.each([
  [30, "less than a minute"],
  [60, "1 minute"],
  [3599, "59 minutes"],
  [3600, "60 minutes"],
  [3601, "1 hour"],
  [5400, "1.5 hours"],
  [7200, "2 hours"],
])(
  "formats %s seconds without minutes after the first hour",
  (seconds, duration) => {
    expect(buildSummaryUpgradeBody(seconds as number)).toBe(
      `Your server has recorded ${duration} across its saved meetings. Upgrade for more recording time and answers from more past meetings. Your subscription also helps keep Chronote running.`,
    );
  },
);
