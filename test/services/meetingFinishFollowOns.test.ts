/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/meetingUserIndexService", () => ({}));
jest.mock("../../src/services/recordingLimitService", () => ({}));
jest.mock("../../src/services/uploadService", () => ({}));
jest.mock("../../src/observability/meetingCompletionAnalytics", () => ({}));
jest.mock("../../src/metrics", () => ({}));

import { maybeAutoExportCompletedMeeting } from "../../src/services/notionAutomationService";
import { defaultFinishFollowOns } from "../../src/services/meetingFinishFollowOns";
import type { DeliveryTransport } from "../../src/services/meetingDelivery";
import type { MeetingHistory } from "../../src/types/db";

test("the finish pipeline's Notion export tells the eligibility check it runs past the terminal save", async () => {
  const transport: DeliveryTransport = {
    getBotIdentity: jest.fn<DeliveryTransport["getBotIdentity"]>(),
    updateMessage: jest.fn<DeliveryTransport["updateMessage"]>(),
    createMessage: jest.fn<DeliveryTransport["createMessage"]>(),
    listMessages: jest.fn<DeliveryTransport["listMessages"]>(),
  };
  const row: MeetingHistory = {
    guildId: "guild-1",
    channelId_timestamp: "channel-1#2026-05-08T12:00:00.000Z",
    meetingId: "meeting-1",
    channelId: "channel-1",
    timestamp: "2026-05-08T12:00:00.000Z",
    participants: [],
    duration: 600,
    transcribeMeeting: true,
    generateNotes: true,
  };
  const followOns = defaultFinishFollowOns(transport);

  await followOns.exportToNotion(row, new AbortController().signal);

  expect(maybeAutoExportCompletedMeeting).toHaveBeenCalledWith(
    row,
    expect.any(AbortSignal),
    true,
  );
});
