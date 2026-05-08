import type { MeetingHistory } from "../../types/db";
import {
  exportMeetingToNotion,
  resetNotionFetchForTests,
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

const jsonResponse = (payload: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }) as Response;

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
    const notionFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
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
    const notionFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
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
    const notionFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
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

  it("replaces the existing Notion page when manually syncing", async () => {
    const notionFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
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
});
