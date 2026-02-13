import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { renderChatEntryLine } from "../../src/utils/chatLog";

describe("renderChatEntryLine", () => {
  const dateSpy = jest
    .spyOn(Date.prototype, "toLocaleString")
    .mockReturnValue("Jan 1, 2024");

  afterEach(() => {
    dateSpy.mockClear();
  });

  test("formats chat messages", () => {
    const line = renderChatEntryLine({
      type: "message",
      user: { id: "1", username: "alpha", tag: "alpha#0001" },
      channelId: "chan",
      content: "Hello!",
      timestamp: new Date("2024-01-01T00:00:00Z").toISOString(),
    });
    expect(line).toBe("[alpha @ Jan 1, 2024]: Hello!");
  });

  test("formats chat attachments", () => {
    const baseEntry = {
      type: "message" as const,
      user: { id: "1", username: "alpha", tag: "alpha#0001" },
      channelId: "chan",
      timestamp: new Date("2024-01-01T00:00:00Z").toISOString(),
      attachments: [
        {
          id: "a1",
          name: "diagram.png",
          size: 1024,
          url: "https://example.com/diagram.png",
        },
      ],
    };

    expect(renderChatEntryLine({ ...baseEntry, content: "" })).toBe(
      "[alpha @ Jan 1, 2024]: (attachments: diagram.png (1.0 KB))",
    );

    expect(renderChatEntryLine({ ...baseEntry, content: "See this" })).toBe(
      "[alpha @ Jan 1, 2024]: See this (attachments: diagram.png (1.0 KB))",
    );

    expect(
      renderChatEntryLine(
        { ...baseEntry, content: "" },
        {
          includeAttachmentUrls: true,
        },
      ),
    ).toBe(
      "[alpha @ Jan 1, 2024]: (attachments: diagram.png (1.0 KB) https://example.com/diagram.png)",
    );
  });

  test("formats join/leave events", () => {
    const joinLine = renderChatEntryLine({
      type: "join",
      user: { id: "1", username: "alpha", tag: "alpha#0001" },
      channelId: "chan",
      timestamp: new Date("2024-01-01T00:00:00Z").toISOString(),
    });
    expect(joinLine).toBe("[alpha] joined the channel at Jan 1, 2024");

    const leaveLine = renderChatEntryLine({
      type: "leave",
      user: { id: "1", username: "alpha", tag: "alpha#0001" },
      channelId: "chan",
      timestamp: new Date("2024-01-01T00:00:00Z").toISOString(),
    });
    expect(leaveLine).toBe("[alpha] left the channel at Jan 1, 2024");
  });
});
