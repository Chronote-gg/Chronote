import type { MeetingHistory } from "../../types/db";
import {
  exportMeetingToNotionAutomation,
  exportMeetingToNotion,
  getEffectiveMeetingNotionExportStatus,
  listNotionDestinationPages,
  resetNotionFetchForTests,
  saveNotionAutomationConfig,
  saveNotionConnectionFromCode,
  setNotionFetchForTests,
  syncMeetingToNotion,
} from "../notionService";
import { resetNotionIntegrationMemoryRepository } from "../../repositories/notionIntegrationRepository";

const userId = "user-1";

const meeting: MeetingHistory = {
  guildId: "guild-1",
  channelId_timestamp: "channel-1#2026-05-08T12:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "channel-1",
  timestamp: "2026-05-08T12:00:00.000Z",
  notes: "## Decisions\n\n- Ship the MVP first",
  notesVersion: 2,
  meetingName: "Planning sync",
  participants: [
    {
      id: "participant-1",
      username: "ParticipantOne",
      displayName: "Participant One",
    },
  ],
  duration: 1800,
  transcribeMeeting: true,
  generateNotes: true,
};

class JsonResponseStub {
  readonly ok: boolean;
  readonly status: number;
  private readonly payload: unknown;

  constructor(payload: unknown, status = 200) {
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.payload = payload;
  }

  json() {
    return Promise.resolve(this.payload);
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new JsonResponseStub(payload, status);
}

const tokenResponse = {
  access_token: "notion-access-token",
  refresh_token: "notion-refresh-token",
  bot_id: "bot-1",
  workspace_id: "workspace-1",
  workspace_name: "Workspace One",
  workspace_icon: null,
};

describe("notionService", () => {
  beforeEach(() => {
    resetNotionIntegrationMemoryRepository();
  });

  afterEach(() => {
    resetNotionFetchForTests();
  });

  it("exports Chronote notes to a new Notion markdown page", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      );
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    const exported = await exportMeetingToNotion({ userId, meeting });

    expect(exported).toMatchObject({
      channelId_timestamp: meeting.channelId_timestamp,
      notionPageId: "page-1",
      notionPageUrl: "https://notion.so/page-1",
      exportedNotesVersion: 2,
    });
    const createRequest = JSON.parse(
      notionFetch.mock.calls[1]?.[1]?.body?.toString() ?? "{}",
    ) as { markdown?: string };
    expect(createRequest.markdown).toContain("# Planning sync");
    expect(createRequest.markdown).toContain(
      "- Date: 2026-05-08T12:00:00.000Z",
    );
    expect(createRequest.markdown).toContain("## Notes");
    expect(createRequest.markdown).toContain("Ship the MVP first");
  });

  it("escapes Markdown brackets in Notion page text", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      );
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    await exportMeetingToNotion({
      userId,
      meeting: {
        ...meeting,
        meetingName: "Planning [sync] ]",
        participants: [
          {
            id: "participant-1",
            username: "ParticipantOne",
            displayName: "Participant ]One",
          },
        ],
      },
    });

    const createRequest = JSON.parse(
      notionFetch.mock.calls[1]?.[1]?.body?.toString() ?? "{}",
    ) as { markdown?: string };
    expect(createRequest.markdown).toContain("# Planning \\[sync\\] \\]");
    expect(createRequest.markdown).toContain(
      "- Participants: Participant \\]One",
    );
  });

  it("rejects duplicate exports so existing Notion pages are not orphaned", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      );
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    await exportMeetingToNotion({ userId, meeting });

    await expect(
      exportMeetingToNotion({ userId, meeting }),
    ).rejects.toMatchObject({
      status: 400,
      code: "already_exported",
    });
    expect(notionFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects concurrent duplicate exports before creating a second Notion page", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      );
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    const results = await Promise.allSettled([
      exportMeetingToNotion({ userId, meeting }),
      exportMeetingToNotion({ userId, meeting }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(notionFetch).toHaveBeenCalledTimes(2);
  });

  it("replaces the existing Notion page when manually syncing", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      )
      .mockResolvedValueOnce(jsonResponse({ markdown: "updated" }));
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    await exportMeetingToNotion({ userId, meeting });
    const synced = await syncMeetingToNotion({
      userId,
      meeting: { ...meeting, notesVersion: 3 },
    });

    expect(synced.exportedNotesVersion).toBe(3);
    expect(notionFetch.mock.calls[2]?.[0]?.toString()).toContain(
      "/v1/pages/page-1/markdown",
    );
    const syncRequest = JSON.parse(
      notionFetch.mock.calls[2]?.[1]?.body?.toString() ?? "{}",
    ) as { type?: string; replace_content?: { new_str?: string } };
    expect(syncRequest.type).toBe("replace_content");
    expect(syncRequest.replace_content?.new_str).toContain("# Planning sync");
  });

  it("saves automation config and exposes automated export status", async () => {
    const notionFetch = jest.fn();
    notionFetch
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              object: "page",
              id: "parent-page",
              url: "https://notion.so/parent-page",
              properties: {
                title: {
                  type: "title",
                  title: [{ plain_text: "Meeting archive" }],
                },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: "page",
          id: "parent-page",
          url: "https://notion.so/parent-page",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Meeting archive" }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "page-1", url: "https://notion.so/page-1" }),
      );
    setNotionFetchForTests(notionFetch);

    await saveNotionConnectionFromCode({ userId, code: "oauth-code" });
    await expect(
      listNotionDestinationPages({ userId, query: "archive" }),
    ).resolves.toEqual([
      {
        id: "parent-page",
        title: "Meeting archive",
        url: "https://notion.so/parent-page",
      },
    ]);
    const automationConfig = await saveNotionAutomationConfig({
      guildId: meeting.guildId,
      userId,
      destinationPageId: "parent-page",
      autoExportEnabled: true,
      channelIds: [meeting.channelId],
      tags: ["recap"],
    });
    const exported = await exportMeetingToNotionAutomation({
      userId,
      meeting,
      destinationPageId: automationConfig.destinationPageId,
      attemptCount: 1,
    });

    expect(automationConfig).toMatchObject({
      destinationPageId: "parent-page",
      destinationTitle: "Meeting archive",
      channelIds: [meeting.channelId],
      tags: ["recap"],
    });
    expect(exported).toMatchObject({
      status: "exported",
      notionPageUrl: "https://notion.so/page-1",
      exportedNotesVersion: 2,
    });
    const createRequest = JSON.parse(
      notionFetch.mock.calls[3]?.[1]?.body?.toString() ?? "{}",
    ) as { parent?: { type?: string; page_id?: string } };
    expect(createRequest.parent).toEqual({
      type: "page_id",
      page_id: "parent-page",
    });

    await expect(
      getEffectiveMeetingNotionExportStatus({
        userId: "other-user",
        guildId: meeting.guildId,
        meetingId: meeting.channelId_timestamp,
        currentNotesVersion: 2,
      }),
    ).resolves.toMatchObject({
      exported: true,
      source: "automation",
      pageUrl: "https://notion.so/page-1",
    });
  });
});
