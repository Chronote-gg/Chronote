/** @jest-environment node */
import { describe, test, expect, jest } from "@jest/globals";
import { buildCaller } from "../utils/trpcCaller";
import { getMockUser } from "../../src/repositories/mockStore";
import * as mcpMeetings from "../../src/services/mcpMeetingService";

describe("unified meeting browse input", () => {
  test("rejects incompatible mode and server filters before discovery", async () => {
    const discovery = jest
      .spyOn(mcpMeetings, "listMcpMyMeetings")
      .mockResolvedValue({
        meetings: [],
        hasMore: false,
        nextCursor: null,
        discoveryComplete: true,
      });
    try {
      await expect(
        buildCaller().meetings.myList({
          mode: "attended",
          browse: { scope: { kind: "all" }, attendedOnly: false },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        buildCaller().meetings.myList({
          mode: "accessible",
          serverIds: ["guild"],
          browse: { scope: { kind: "personal" }, attendedOnly: false },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      discovery.mockRestore();
    }
  });
  test("takes actor identity from context and forwards portal browse filters", async () => {
    const discovery = jest
      .spyOn(mcpMeetings, "listMcpMyMeetings")
      .mockResolvedValue({
        meetings: [],
        hasMore: false,
        nextCursor: null,
        discoveryComplete: true,
      });
    try {
      const input = {
        mode: "accessible" as const,
        range: "all" as const,
        limit: 25,
        userId: "forged",
        browse: { scope: { kind: "all" as const }, attendedOnly: false },
      };
      expect(await buildCaller().meetings.myList(input)).toMatchObject({
        discoveryComplete: true,
      });
      expect(discovery).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: getMockUser().id,
          browse: input.browse,
          mode: "accessible",
          range: "all",
          limit: 25,
        }),
      );
    } finally {
      discovery.mockRestore();
    }
  });
});
