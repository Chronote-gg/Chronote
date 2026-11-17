/** @jest-environment node */
import { createAskAgentTools } from "../../src/services/askAgentTools";
import * as search from "../../src/services/meetingSearchService";

jest.mock(
  "../../src/services/meetingSearchService",
  () => ({
    searchMeetingsForUser: jest.fn(),
    searchTranscriptsForUser: jest.fn(),
    listMeetingsForUser: jest.fn(),
    readMeetingNotesForUser: jest.fn(),
    readTranscriptPassageForUser: jest.fn(),
    authorizeMeetingSearchSource: jest.fn(),
  }),
  { virtual: true },
);

const meeting = { serverId: "server-a", id: "voice#2026-10-01T00:00:00.000Z" };
const hit = {
  meeting,
  title: "Review",
  notes: "Complete notes",
  notesRevision: "notes:1",
  startedAt: "2026-10-01T00:00:00.000Z",
  tags: [],
  archived: false,
  transcriptAvailable: true,
};
const principal = { userId: "user-a", serverIds: ["server-a"] };
const invoke = async (
  tools: ReturnType<typeof createAskAgentTools>,
  name: string,
  args: object,
) => {
  const result = await tools.tools
    .find((tool) => tool.name === name)!
    .execute("call", args);
  return JSON.parse(
    result.content[0].type === "text" ? result.content[0].text : "{}",
  );
};

beforeEach(() => jest.resetAllMocks());

test("model arguments cannot inject authentication or extra operations", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 10000,
  });
  expect(
    (
      await invoke(tools, "read_meeting_notes", {
        meeting,
        userId: "other-user",
      })
    ).error.code,
  ).toBe("invalid_argument");
  expect(
    (
      await invoke(tools, "search_transcripts", {
        query: "detail",
        meetingIds: [],
      })
    ).error.code,
  ).toBe("invalid_argument");
  expect(search.readMeetingNotesForUser).not.toHaveBeenCalled();
});

test("restored notes provenance must match the complete current record", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 10000,
    provenance: {
      evidence: [
        { evidenceId: "S1", meeting, revision: "notes:1", source: "notes" },
      ],
      loadedMeetings: [{ meeting, notesRevision: "notes:1" }],
    },
  });
  (search.readMeetingNotesForUser as jest.Mock).mockResolvedValue({
    ...hit,
    notesRevision: "notes:2",
  });
  expect(
    (await invoke(tools, "read_transcript_passage", { meeting })).error.code,
  ).toBe("meeting_context_required");
  expect(search.readTranscriptPassageForUser).not.toHaveBeenCalled();
  expect(tools.snapshot().loadedMeetings).toEqual([]);
});

test("revoked transcript provenance is rejected even when only compacted source handles remain", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 10000,
    provenance: {
      evidence: [
        {
          evidenceId: "S1",
          meeting,
          revision: "transcript:1",
          source: "transcript",
        },
      ],
      loadedMeetings: [{ meeting, notesRevision: "notes:1" }],
    },
  });
  (search.authorizeMeetingSearchSource as jest.Mock).mockRejectedValue({
    code: "source_unavailable",
  });
  expect(await tools.revalidate()).toBe(false);
  expect(search.authorizeMeetingSearchSource).toHaveBeenCalledWith(
    principal,
    meeting,
    "transcript:1",
    "transcript",
    undefined,
  );
  expect(tools.snapshot()).toEqual({ evidence: [], loadedMeetings: [] });
  expect(
    tools.normalizeCitations(
      'Unsupported [S1] <chronote:cite index="1" eventId="forged"/>',
    ),
  ).toEqual({ answer: "Unsupported  ", citations: [] });
});

test("both transcript operations require complete current notes, metadata alone is insufficient", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 10000,
  });
  (search.listMeetingsForUser as jest.Mock).mockResolvedValue({
    meetings: [{ meeting, title: "Review" }],
    nextCursor: null,
  });
  await invoke(tools, "list_meetings", {});
  expect(
    (
      await invoke(tools, "search_transcripts", {
        query: "detail",
        meetingIds: [meeting],
      })
    ).error.code,
  ).toBe("meeting_context_required");
  expect(
    (await invoke(tools, "read_transcript_passage", { meeting })).error.code,
  ).toBe("meeting_context_required");
  expect(search.searchTranscriptsForUser).not.toHaveBeenCalled();
  (search.readMeetingNotesForUser as jest.Mock).mockResolvedValue(hit);
  await invoke(tools, "read_meeting_notes", { meeting });
  (search.searchTranscriptsForUser as jest.Mock).mockResolvedValue({
    hits: [],
    nextCursor: null,
  });
  await invoke(tools, "search_transcripts", {
    query: "detail",
    meetingIds: [meeting],
  });
  expect(search.searchTranscriptsForUser).toHaveBeenCalled();
});

test("scope cannot widen and forged citations never become links", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 10000,
  });
  expect(
    (
      await invoke(tools, "read_meeting_notes", {
        meeting: { ...meeting, serverId: "other" },
      })
    ).error.code,
  ).toBe("not_available");
  expect(search.readMeetingNotesForUser).not.toHaveBeenCalled();
  (search.readMeetingNotesForUser as jest.Mock).mockResolvedValue(hit);
  await invoke(tools, "read_meeting_notes", { meeting });
  expect(
    tools.normalizeCitations("Answer [S1] [S900] [S1:event-made-up]"),
  ).toEqual({
    answer: 'Answer <chronote:cite index="1"/>  ',
    citations: [
      { index: 1, meetingId: meeting.id, serverId: meeting.serverId },
    ],
  });
});

test("oversized notes return context_limit without truncation or transcript eligibility", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 100,
  });
  (search.readMeetingNotesForUser as jest.Mock).mockResolvedValue({
    ...hit,
    notes: "x".repeat(200),
  });
  expect(
    (await invoke(tools, "read_meeting_notes", { meeting })).error.code,
  ).toBe("context_limit");
  expect(tools.snapshot().loadedMeetings).toEqual([]);
  expect(
    (await invoke(tools, "read_transcript_passage", { meeting })).error.code,
  ).toBe("meeting_context_required");
});

test("page reduction resumes at first undelivered complete record", async () => {
  const tools = createAskAgentTools({
    principal,
    remainingContextChars: () => 750,
  });
  const second = {
    ...hit,
    meeting: { ...meeting, id: "second" },
    notes: "x".repeat(500),
  };
  (search.searchMeetingsForUser as jest.Mock)
    .mockResolvedValueOnce({ hits: [hit], nextCursor: "second-cursor" })
    .mockResolvedValueOnce({ hits: [second], nextCursor: null });
  const result = await invoke(tools, "search_meetings", {
    query: "review",
    pageSize: 2,
  });
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].notes).toBe(hit.notes);
  expect(result.nextCursor).toBeTruthy();
  expect(tools.snapshot().loadedMeetings).toHaveLength(1);
});
