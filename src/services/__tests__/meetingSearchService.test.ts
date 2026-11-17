import { config } from "../configService";
/** @jest-environment node */
import {
  searchTranscriptsForUser,
  searchMeetingsForUser,
  readMeetingNotesForUser,
  readTranscriptPassageForUser,
} from "../meetingSearchService";
import {
  listMcpMyMeetings,
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
} from "../mcpMeetingService";
import { getMeetingHistoryRepository } from "../../repositories/meetingHistoryRepository";
import { ensureMcpMeetingAccess } from "../mcpMeetingAccess";
import { queryMeetingSearchCandidates } from "../../repositories/meetingSearchRepository";
import { embedSearchText } from "../searchEmbeddingService";
import { resolveMeetingArtifactAccess } from "../meetingArtifactAccessService";
import { McpMeetingAccessError } from "../mcpMeetingErrors";

jest.mock("../configService", () => ({
  config: {
    search: { enabled: true },
    server: { sessionSecret: "synthetic-signing-key" },
  },
}));
jest.mock("../../repositories/meetingHistoryRepository", () => ({
  getMeetingHistoryRepository: jest.fn(),
}));
jest.mock("../mcpMeetingService", () => ({
  listMcpMyMeetings: jest.fn(),
  getMcpMeetingSummary: jest.fn(),
  getMcpMeetingTranscript: jest.fn(),
}));
jest.mock("../mcpMeetingAccess", () => ({ ensureMcpMeetingAccess: jest.fn() }));
jest.mock("../meetingArtifactAccessService", () => ({
  resolveMeetingArtifactAccess: jest.fn(),
}));
jest.mock("../meetingMentionService", () => ({
  createMeetingMentionReplacer: jest.fn(async () => ({
    toText: (text: string) => text,
  })),
}));
jest.mock("../storageService", () => ({ fetchJsonFromS3: jest.fn() }));
jest.mock("../meetingSearchProjectionService", () => ({
  meetingSearchSourceRevision: () => "rev",
}));
jest.mock("../searchEmbeddingService", () => ({ embedSearchText: jest.fn() }));
jest.mock("../../repositories/meetingSearchRepository", () => ({
  queryMeetingSearchCandidates: jest.fn(),
}));
const principal = { userId: "actor", serverIds: ["server"] };
const ref = { serverId: "server", id: "voice#2001-01-01T00:00:00.000Z" };
const record = {
  guildId: ref.serverId,
  channelId_timestamp: ref.id,
  channelId: "voice",
  notesChannelId: "text",
  timestamp: "2001-01-01T00:00:00.000Z",
  tags: ["Example"],
  notes: "Complete ".repeat(1000),
  transcript: "A synthetic transcript.",
};
const getStrong = jest.fn();
function mockPersonalMeeting() {
  const personalRef = { serverId: "personal:owner", id: ref.id };
  getStrong.mockResolvedValue({
    ...record,
    guildId: personalRef.serverId,
    ownershipScope: "personal",
    ownerUserId: "owner",
  });
  return personalRef;
}
beforeEach(() => {
  jest.clearAllMocks();
  config.search.enabled = true;
  jest
    .mocked(getMeetingHistoryRepository)
    .mockReturnValue({ getStrong } as unknown as ReturnType<
      typeof getMeetingHistoryRepository
    >);
  getStrong.mockResolvedValue(record);
  jest.mocked(ensureMcpMeetingAccess).mockResolvedValue(undefined);
  jest.mocked(resolveMeetingArtifactAccess).mockResolvedValue({
    transcriptAccessEnabled: true,
    audioAccessEnabled: true,
  });
  jest.mocked(listMcpMyMeetings).mockResolvedValue({
    meetings: [{ ...ref }],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof listMcpMyMeetings>>);
  jest.mocked(getMcpMeetingSummary).mockResolvedValue({
    meeting: { notes: record.notes, transcriptAvailable: true },
  } as unknown as Awaited<ReturnType<typeof getMcpMeetingSummary>>);
  jest.mocked(embedSearchText).mockResolvedValue([1, 2]);
  jest.mocked(queryMeetingSearchCandidates).mockResolvedValue({
    candidates: [{ key: "key", meeting: ref, sourceRevision: "rev" }],
    windowLimited: false,
    nextToken: undefined,
  });
});
test("rejects empty transcript selection at the shared boundary", async () => {
  await expect(
    searchTranscriptsForUser(principal, { query: "test", meetingIds: [] }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
test("rejects explicit empty filters and invalid date intersections", async () => {
  for (const filters of [
    { serverIds: [] },
    { meetingIds: [] },
    { from: "2026-01-02T00:00:00.000Z", before: "2026-01-01T00:00:00.000Z" },
  ])
    await expect(
      searchMeetingsForUser(principal, { query: "test", filters }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
});
test("returns complete canonical old notes without tier or age truncation", async () => {
  const result = await searchMeetingsForUser(principal, { query: "test" });
  expect(result.hits[0].notes).toBe(record.notes);
  expect(listMcpMyMeetings).toHaveBeenCalledWith(
    expect.objectContaining({ range: "all", mode: "accessible" }),
  );
  expect(queryMeetingSearchCandidates).toHaveBeenCalledWith(
    expect.objectContaining({ meetingIds: [ref] }),
  );
  expect(result.coverage.status).toBe("partial");
});
test("query embedding outage preserves BM25 retrieval", async () => {
  jest.mocked(embedSearchText).mockRejectedValue(Error("synthetic outage"));
  const result = await searchMeetingsForUser(principal, { query: "test" });
  expect(result.hits).toHaveLength(1);
  expect(result.coverage.semanticStatus).toBe("unavailable");
  expect(queryMeetingSearchCandidates).toHaveBeenCalledWith(
    expect.objectContaining({ queryVector: undefined }),
  );
});
test("authorized server AND voice-or-text AND all tags AND dates apply before ranking", async () => {
  const result = await searchMeetingsForUser(principal, {
    query: "test",
    filters: {
      serverIds: ["server"],
      channelId: "text",
      tags: ["example"],
      from: "2000-01-01T00:00:00.000Z",
      before: "2002-01-01T00:00:00.000Z",
    },
  });
  expect(result.hits).toHaveLength(1);
  await searchMeetingsForUser(principal, {
    query: "test",
    filters: { channelId: "wrong" },
  });
  expect(queryMeetingSearchCandidates).toHaveBeenCalledTimes(1);
});
test("denied candidates never reach ranking", async () => {
  jest
    .mocked(ensureMcpMeetingAccess)
    .mockRejectedValue(new McpMeetingAccessError("Denied", "forbidden"));
  expect(
    (await searchMeetingsForUser(principal, { query: "test" })).hits,
  ).toEqual([]);
  expect(queryMeetingSearchCandidates).not.toHaveBeenCalled();
});
test("stale source candidates are discarded before text delivery", async () => {
  jest.mocked(queryMeetingSearchCandidates).mockResolvedValue({
    candidates: [{ key: "old", meeting: ref, sourceRevision: "old" }],
    windowLimited: false,
    nextToken: undefined,
  });
  expect(
    (await searchMeetingsForUser(principal, { query: "test" })).hits,
  ).toEqual([]);
  expect(getMcpMeetingSummary).not.toHaveBeenCalled();
});
test("cursor binds user, filters, query and stable pending candidates", async () => {
  jest.mocked(queryMeetingSearchCandidates).mockResolvedValue({
    candidates: [
      { key: "a", meeting: ref, sourceRevision: "rev" },
      { key: "b", meeting: ref, sourceRevision: "rev" },
    ],
    windowLimited: false,
    nextToken: undefined,
  });
  const first = await searchMeetingsForUser(principal, {
    query: "test",
    pageSize: 1,
  });
  expect(first.nextCursor).toBeTruthy();
  await expect(
    searchMeetingsForUser(principal, {
      query: "changed",
      pageSize: 1,
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  const next = await searchMeetingsForUser(principal, {
    query: "test",
    pageSize: 1,
    cursor: first.nextCursor!,
  });
  expect(next.hits).toHaveLength(1);
  expect(queryMeetingSearchCandidates).toHaveBeenCalledTimes(1);
});
test("current artifact policy prevents transcript ranking", async () => {
  jest.mocked(resolveMeetingArtifactAccess).mockResolvedValue({
    transcriptAccessEnabled: false,
    audioAccessEnabled: true,
  });
  await expect(
    searchTranscriptsForUser(principal, { query: "test", meetingIds: [ref] }),
  ).rejects.toMatchObject({ code: "source_unavailable" });
  expect(queryMeetingSearchCandidates).not.toHaveBeenCalled();
});
test("bound channel scope also protects direct reads", async () => {
  await expect(
    readMeetingNotesForUser(
      { ...principal, channelId: "private" },
      { meeting: ref },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
  expect(getMcpMeetingSummary).not.toHaveBeenCalled();
});
test("transcript locator cannot be forged or moved to another meeting", async () => {
  await expect(
    readTranscriptPassageForUser(principal, {
      meeting: ref,
      passageRef: "forged",
    }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(getMcpMeetingTranscript).not.toHaveBeenCalled();
});

test("hydrates strong notes instead of stale eventual MCP contents", async () => {
  jest.mocked(getMcpMeetingSummary).mockResolvedValue({
    meeting: {
      notes: "revoked old notes",
      meetingName: "old title",
      transcriptAvailable: false,
    },
  } as unknown as Awaited<ReturnType<typeof getMcpMeetingSummary>>);
  const result = await readMeetingNotesForUser(principal, { meeting: ref });
  expect(result.notes).toBe(record.notes);
  expect(result.notes).not.toContain("revoked old notes");
  expect(getMcpMeetingSummary).not.toHaveBeenCalled();
});
test("hydrates strong inline transcript instead of stale eventual MCP contents", async () => {
  jest.mocked(getMcpMeetingTranscript).mockResolvedValue({
    transcript: "revoked old transcript",
  } as unknown as Awaited<ReturnType<typeof getMcpMeetingTranscript>>);
  const result = await readTranscriptPassageForUser(principal, {
    meeting: ref,
  });
  expect(result.text).toBe(record.transcript);
  expect(getMcpMeetingTranscript).not.toHaveBeenCalled();
});
test.each(["personal", "all"] as const)(
  "%s scope supports authorized personal/shared meeting partitions outside serverIds",
  async (kind) => {
    const personalRef = mockPersonalMeeting();
    const result = await readMeetingNotesForUser(
      { ...principal, scope: { kind } },
      { meeting: personalRef },
    );
    expect(result.meeting).toEqual(personalRef);
    expect(ensureMcpMeetingAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: principal.userId }),
    );
  },
);
test("personal scope cannot be widened to a guild record", async () => {
  await expect(
    readMeetingNotesForUser(
      { ...principal, scope: { kind: "personal" } },
      { meeting: ref },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
});
test("guild scope excludes personal records even when their partition happens to match", async () => {
  getStrong.mockResolvedValue({ ...record, ownershipScope: "personal" });
  await expect(
    readMeetingNotesForUser(
      { ...principal, scope: { kind: "guild", serverId: "server" } },
      { meeting: ref },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
});
test("restricted token uses current channel policy without attendee/authority overrides", async () => {
  await readMeetingNotesForUser(
    { ...principal, restriction: { guildId: "server", channelIds: ["voice"] } },
    { meeting: ref },
  );
  expect(ensureMcpMeetingAccess).toHaveBeenCalledWith(
    expect.objectContaining({ restricted: true }),
  );
});
test("hard token voice restrictions cannot be bypassed with a matching text channel", async () => {
  await expect(
    readMeetingNotesForUser(
      {
        ...principal,
        restriction: { guildId: "server", channelIds: ["text"] },
      },
      { meeting: ref },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
});
test("token guild restriction also applies to broad personal/all scope", async () => {
  await expect(
    readMeetingNotesForUser(
      {
        ...principal,
        scope: { kind: "all" },
        restriction: { guildId: "other" },
      },
      { meeting: ref },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
  expect(getStrong).not.toHaveBeenCalled();
});

test.each(["free", "basic", "pro"])(
  "%s uses the same authorized personal history and canonical browse scope",
  async () => {
    const personalRef = mockPersonalMeeting();
    jest.mocked(listMcpMyMeetings).mockResolvedValue({
      meetings: [personalRef],
      nextCursor: null,
    } as unknown as Awaited<ReturnType<typeof listMcpMyMeetings>>);
    jest.mocked(queryMeetingSearchCandidates).mockResolvedValue({
      candidates: [
        { key: "personal", meeting: personalRef, sourceRevision: "rev" },
      ],
      windowLimited: false,
      nextToken: undefined,
    });
    const result = await searchMeetingsForUser(
      { ...principal, serverIds: [], scope: { kind: "personal" } },
      { query: "test" },
    );
    expect(result.hits[0].meeting).toEqual(personalRef);
    expect(listMcpMyMeetings).toHaveBeenCalledWith(
      expect.objectContaining({
        browse: { scope: { kind: "personal" }, attendedOnly: false },
      }),
    );
  },
);
test("all scope still rejects an inaccessible shared personal record", async () => {
  const personalRef = mockPersonalMeeting();
  jest
    .mocked(ensureMcpMeetingAccess)
    .mockRejectedValue(new McpMeetingAccessError("Denied", "forbidden"));
  await expect(
    readMeetingNotesForUser(
      { ...principal, scope: { kind: "all" } },
      { meeting: personalRef },
    ),
  ).rejects.toMatchObject({ code: "not_available" });
});

test("disabled serving gate prevents embeddings and index reads", async () => {
  config.search.enabled = false;
  await expect(
    searchMeetingsForUser(principal, { query: "launch" }),
  ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  expect(embedSearchText).not.toHaveBeenCalled();
  expect(queryMeetingSearchCandidates).not.toHaveBeenCalled();
});
