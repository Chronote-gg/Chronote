import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { claimInteractionReceipt } from "../../src/services/interactionIdempotencyService";
import { tryCreateInteractionReceipt } from "../../src/db";

jest.mock("../../src/db", () => ({
  tryCreateInteractionReceipt: jest.fn(),
}));

describe("interactionIdempotencyService", () => {
  const mockedTryCreateInteractionReceipt = jest.mocked(
    tryCreateInteractionReceipt,
  );
  const fixedNowMs = Date.parse("2026-02-14T20:00:00.000Z");

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("creates a receipt with a one-hour TTL", async () => {
    mockedTryCreateInteractionReceipt.mockResolvedValue(true);

    const claimed = await claimInteractionReceipt({
      interactionId: "123456789",
      interactionKind: "chat-input:startmeeting",
      guildId: "guild-1",
    });

    expect(claimed).toBe(true);
    expect(mockedTryCreateInteractionReceipt).toHaveBeenCalledWith({
      interactionId: "123456789",
      interactionKind: "chat-input:startmeeting",
      guildId: "guild-1",
      createdAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771102800,
    });
  });

  test("returns false when the interaction was already claimed", async () => {
    mockedTryCreateInteractionReceipt.mockResolvedValue(false);

    const claimed = await claimInteractionReceipt({
      interactionId: "123456789",
      interactionKind: "button:end_meeting",
    });

    expect(claimed).toBe(false);
  });
});
