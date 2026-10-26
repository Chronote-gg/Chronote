/** @jest-environment node */
import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import "../deployment/coldNetworkGuard.cjs";
import { getMockUser } from "../../src/repositories/mockStore";
import {
  ensureUserInGuild,
  ensureBotInGuild,
} from "../../src/services/guildAccessService";
import { getFirstMeetingState } from "../../src/services/firstMeetingService";
import { buildCaller } from "../utils/trpcCaller";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureUserInGuild: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));
jest.mock("../../src/services/firstMeetingService", () => ({
  getFirstMeetingState: jest.fn(),
}));

describe("meetings router firstMeeting", () => {
  const serverId = "123456789012345678";
  const historyId = "345678901234567890#2026-10-19T12:00:00.000Z";
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(ensureUserInGuild).mockResolvedValue(true);
    jest.mocked(ensureBotInGuild).mockResolvedValue(true);
    jest.mocked(getFirstMeetingState).mockResolvedValue({ kind: "guide" });
  });

  test("requires_member_and_bot_presence", async () => {
    const signedOut = buildCaller(null);
    await expect(
      signedOut.meetings.firstMeeting({ serverId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    jest.mocked(ensureUserInGuild).mockResolvedValue(false);
    await expect(
      buildCaller().meetings.firstMeeting({ serverId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    jest.mocked(ensureUserInGuild).mockResolvedValue(null);
    await expect(
      buildCaller().meetings.firstMeeting({ serverId }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    jest.mocked(ensureUserInGuild).mockResolvedValue(true);
    jest.mocked(ensureBotInGuild).mockResolvedValue(false);
    await expect(
      buildCaller().meetings.firstMeeting({ serverId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    jest.mocked(ensureBotInGuild).mockResolvedValue(null);
    await expect(
      buildCaller().meetings.firstMeeting({ serverId }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(getFirstMeetingState).not.toHaveBeenCalled();
  });

  test("forwards_the_selected_history_key_and_signed_in_identity", async () => {
    expect(
      await buildCaller().meetings.firstMeeting({ serverId, historyId }),
    ).toEqual({ kind: "guide" });
    expect(getFirstMeetingState).toHaveBeenCalledWith({
      guildId: serverId,
      userId: getMockUser().id,
      historyId,
    });
    expect(ensureBotInGuild).toHaveBeenCalledWith(serverId);
  });

  test.each([
    { serverId: "personal:user" },
    { serverId, historyId: "internal-uuid" },
    { serverId, historyId: "345678901234567890#" },
  ])("rejects_invalid_progress_targets: %j", async (input) => {
    await expect(
      buildCaller().meetings.firstMeeting(input),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getFirstMeetingState).not.toHaveBeenCalled();
  });
});
