/** @jest-environment node */
import type { MeetingHistory } from "../../types/db";
import type { MeetingSearchProjectionState } from "../../types/meetingSearchProjection";
import {
  buildMeetingSearchDocuments,
  createMeetingSearchProjector,
  meetingSearchSourceRevision,
} from "../meetingSearchProjectionService";

const history = {
  guildId: "server",
  channelId_timestamp: "voice#2026-01-01T00:00:00.000Z",
  meetingId: "meeting",
  channelId: "voice",
  textChannelId: "text",
  timestamp: "2026-01-01T00:00:00.000Z",
  notes: "complete notes",
  meetingName: "Title",
  summarySentence: "summary-only-needle",
  summaryLabel: "Summary",
  tags: ["tag"],
  participants: [],
  duration: 20,
  transcribeMeeting: true,
  generateNotes: true,
} satisfies MeetingHistory;

function fixture() {
  let current: MeetingHistory | undefined = { ...history };
  let transcript = "first transcript";
  const rows = new Map<string, MeetingSearchProjectionState>();
  const vectors = new Map<string, number[]>();
  const state = {
    get: jest.fn(async (id: string) =>
      rows.has(id) ? structuredClone(rows.get(id)!) : undefined,
    ),
    put: jest.fn(async (row: MeetingSearchProjectionState) => {
      rows.set(row.projectionId, structuredClone(row));
    }),
    list: jest.fn(async () => [...rows.values()]),
    scan: jest.fn(async () => ({ items: [...rows.values()] })),
  };
  const source = {
    get: jest.fn(async () => current),
    transcript: jest.fn(async () => transcript),
  };
  const index = {
    put: jest.fn(async (documents: { key: string; vector: number[] }[]) => {
      documents.forEach((document) =>
        vectors.set(document.key, document.vector),
      );
    }),
    remove: jest.fn(async (_dataset: string, keys: string[]) => {
      keys.forEach((key) => vectors.delete(key));
    }),
    get: jest.fn(async (_dataset: string, key: string) => vectors.get(key)),
  };
  const embed = jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
  const project = createMeetingSearchProjector({
    generation: "v1",
    state,
    source,
    index,
    embed,
    now: () => 1000,
  });
  return {
    project,
    state,
    source,
    index,
    embed,
    rows,
    vectors,
    setCurrent: (value: MeetingHistory | undefined) => {
      current = value;
    },
    setTranscript: (value: string) => {
      transcript = value;
    },
  };
}

function expectReadyProjection(
  f: ReturnType<typeof fixture>,
  current: MeetingSearchProjectionState[],
) {
  for (const row of current) {
    expect(f.rows.get(row.projectionId)?.status).toBe("ready");
    for (const document of row.documents)
      expect(f.vectors.has(document.key)).toBe(true);
  }
}

test("meeting record contains full notes and searchable summary, transcript offsets retain original coordinates", () => {
  const documents = buildMeetingSearchDocuments(
    history,
    "x".repeat(6500),
    "v1",
    "attempt",
  );
  expect(documents[0].text).toContain("summary-only-needle");
  expect(documents[0].text).toContain(history.notes);
  expect(documents.filter((d) => d.dataset === "meetings")).toHaveLength(1);
  const passages = documents.filter((d) => d.dataset === "transcripts");
  expect(passages[1].metadata.start).toBeLessThan(
    passages[0].metadata.end as number,
  );
  expect(passages[0].metadata.meeting_ref).toBe(
    JSON.stringify([history.guildId, history.channelId_timestamp]),
  );
});

test("serialized UTF-8 metadata size is checked without truncating notes", () => {
  expect(() =>
    buildMeetingSearchDocuments(
      { ...history, notes: "💥".repeat(12000) },
      "",
      "v1",
      "a",
    ),
  ).toThrow(/metadata/);
  expect(() =>
    buildMeetingSearchDocuments(
      { ...history, tags: ["x".repeat(2200)] },
      "",
      "v1",
      "a",
    ),
  ).toThrow(/filterable/);
});

test("intent is durable before embedding; embedding failure stays pending for retry", async () => {
  const f = fixture();
  f.embed.mockImplementation(async () => {
    expect(f.rows.size).toBe(1);
    throw Error("provider");
  });
  await expect(f.project(history)).rejects.toThrow("provider");
  expect([...f.rows.values()][0]).toMatchObject({
    status: "pending",
    failure: "embedding",
    attempts: 1,
  });
  expect(f.index.put).not.toHaveBeenCalled();
});

test("late embedding after edit cannot publish stale content", async () => {
  const f = fixture();
  f.embed.mockImplementation(async (texts) => {
    f.setCurrent({ ...history, notes: "edited" });
    return texts.map(() => [1]);
  });
  await f.project(history);
  expect(f.index.put).not.toHaveBeenCalled();
  expect([...f.rows.values()][0].status).toBe("tombstone");
});

test("uncertain writes remain discoverable and old keys are deleted after canonical deletion", async () => {
  const f = fixture();
  f.index.put.mockImplementationOnce(async (documents) => {
    documents.forEach((d) => f.vectors.set(d.key, d.vector));
    throw Error("lost acknowledgement");
  });
  await expect(f.project(history)).rejects.toThrow("lost acknowledgement");
  expect(f.vectors.size).toBeGreaterThan(0);
  f.setCurrent(undefined);
  await f.project(history);
  expect(f.vectors.size).toBe(0);
  const tombstone = [...f.rows.values()][0];
  expect(tombstone.status).toBe("tombstone");
  f.vectors.set(tombstone.documents[0].key, [1]);
  await f.project(history);
  expect(f.vectors.size).toBe(0);
});

test("delete/recreate and failed deletion keep durable cleanup rows", async () => {
  const f = fixture();
  await f.project(history);
  f.setCurrent(undefined);
  f.index.remove.mockRejectedValueOnce(Error("delete unavailable"));
  await expect(f.project(history)).rejects.toThrow("delete unavailable");
  expect([...f.rows.values()][0].status).toBe("tombstone");
  f.setCurrent({ ...history, meetingId: "recreated", notes: "new notes" });
  await f.project(history);
  expect([...f.rows.values()].some((r) => r.status === "ready")).toBe(true);
  expect([...f.rows.values()][0].status).toBe("tombstone");
});

test("access-only changes reuse unchanged document vectors", async () => {
  const f = fixture();
  await f.project(history);
  f.embed.mockClear();
  f.setCurrent({ ...history, archivedAt: "2026-01-02" });
  await f.project(history);
  expect(f.embed).not.toHaveBeenCalled();
  expect(f.index.get).toHaveBeenCalled();
});

test("same-key transcript replacement is detected by reconciliation", async () => {
  const f = fixture();
  await f.project(history);
  f.setTranscript("replacement transcript");
  await f.project(history);
  expect([...f.rows.values()].filter((r) => r.status === "ready")).toHaveLength(
    2,
  );
  expect(
    [...f.rows.values()].filter((r) => r.status === "tombstone"),
  ).toHaveLength(1);
});

test("source revision changes on search/filter/access fields but not delivery acknowledgements", () => {
  expect(meetingSearchSourceRevision(history)).not.toBe(
    meetingSearchSourceRevision({ ...history, notes: "changed" }),
  );
  expect(meetingSearchSourceRevision(history)).toBe(
    meetingSearchSourceRevision({ ...history, summaryMessageId: "ack" }),
  );
});

test("transcript source failure does not prevent publishing complete meeting notes", async () => {
  const f = fixture();
  f.source.transcript.mockRejectedValue(Error("S3 unavailable"));
  await expect(f.project(history)).rejects.toThrow("S3 unavailable");
  expect(f.index.put).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ dataset: "meetings" })]),
    undefined,
  );
  expect(
    [...f.rows.values()].some(
      (row) =>
        row.status === "ready" &&
        row.documents.some((d) => d.dataset === "meetings"),
    ),
  ).toBe(true);
});

test("repeated embedding outages reuse durable intents and accumulate retry attempts", async () => {
  const f = fixture();
  f.embed.mockRejectedValue(Error("embedding down"));
  await expect(f.project(history)).rejects.toThrow();
  const firstRows = f.rows.size;
  await expect(f.project(history)).rejects.toThrow();
  expect(f.rows.size).toBe(firstRows);
  expect([...f.rows.values()].every((r) => r.attempts === 2)).toBe(true);
});

test("passages prefer paragraph boundaries and keep exact original source offsets", () => {
  const transcript =
    "first paragraph ".repeat(120) + "\n\n" + "second paragraph ".repeat(200);
  const documents = buildMeetingSearchDocuments(
    history,
    transcript,
    "g1",
    "attempt",
    "transcripts",
  );
  expect(documents[0].text.endsWith("\n\n")).toBe(true);
  for (const document of documents) {
    expect(document.text).toBe(
      transcript.slice(
        document.metadata.start as number,
        document.metadata.end as number,
      ),
    );
    expect(document.text.length).toBeLessThanOrEqual(3000);
  }
});

test("source revision is independent of DynamoDB map property ordering", () => {
  const first = {
    ...history,
    participants: [{ id: "person", username: "name", displayName: "display" }],
  };
  const second = {
    ...history,
    participants: [{ displayName: "display", username: "name", id: "person" }],
  };
  expect(meetingSearchSourceRevision(first)).toBe(
    meetingSearchSourceRevision(second),
  );
});

test("deletion during an external write is rechecked and cleaned before ready state", async () => {
  const f = fixture();
  f.index.put.mockImplementation(async (documents) => {
    documents.forEach((document) =>
      f.vectors.set(document.key, document.vector),
    );
    f.setCurrent(undefined);
  });
  await f.project(history);
  expect(f.vectors.size).toBe(0);
  expect([...f.rows.values()].some((row) => row.status === "ready")).toBe(
    false,
  );
});

test("a stale ready worker preserves the newer canonical projection returned in its state snapshot", async () => {
  const f = fixture();
  await f.project(history);
  const older = [...f.rows.values()].map((row) => structuredClone(row));
  const newer = {
    ...history,
    notes: "newer canonical notes",
    contentRevision: 2,
  };
  f.setCurrent(newer);
  await f.project(history);
  for (const row of older) {
    f.rows.set(row.projectionId, row);
    for (const document of row.documents) f.vectors.set(document.key, [1]);
  }
  const current = [...f.rows.values()].filter(
    (row) => row.revision === meetingSearchSourceRevision(newer),
  );
  f.source.get.mockResolvedValueOnce(history);
  await f.project(history);
  expectReadyProjection(f, current);
});

test("a missing-history snapshot cannot delete a concurrently recreated canonical projection", async () => {
  const f = fixture();
  const recreated = { ...history, meetingId: "recreated" };
  f.setCurrent(recreated);
  await f.project(history);
  const current = [...f.rows.values()].map((row) => structuredClone(row));
  f.source.get.mockResolvedValueOnce(undefined);
  await f.project(history);
  expectReadyProjection(f, current);
});

test("normal publication cleanup preserves a newer canonical source published after the write check", async () => {
  const f = fixture();
  const newer = {
    ...history,
    notes: "newer canonical notes",
    contentRevision: 2,
  };
  f.setCurrent(newer);
  await f.project(history);
  const current = [...f.rows.values()].map((row) => structuredClone(row));
  f.setCurrent(history);
  const original = f.state.put.getMockImplementation()!;
  f.state.put.mockImplementation(async (row) => {
    await original(row);
    if (
      row.status === "ready" &&
      row.revision === meetingSearchSourceRevision(history)
    )
      f.setCurrent(newer);
  });
  await f.project(history);
  expectReadyProjection(f, current);
});

test("stale transcript cleanup preserves a same-key replacement using its current content hash", async () => {
  const f = fixture();
  await f.project(history);
  const older = [...f.rows.values()]
    .filter((row) => row.dataset === "transcripts")
    .map((row) => structuredClone(row));
  f.setTranscript("replacement transcript");
  await f.project(history);
  const current = [...f.rows.values()].filter(
    (row) => row.dataset === "transcripts" && row.status === "ready",
  );
  for (const row of older) f.rows.set(row.projectionId, row);
  f.source.transcript.mockResolvedValueOnce("first transcript");
  await f.project(history);
  expectReadyProjection(f, current);
});

test("cleanup never targets another index generation and fails closed when canonical reads fail", async () => {
  const f = fixture();
  await f.project(history);
  const current = [...f.rows.values()].map((row) => structuredClone(row));
  const foreign = {
    ...current[0],
    projectionId: "foreign",
    generation: "other-generation",
    documents: [{ ...current[0].documents[0], key: "foreign-vector" }],
  };
  f.rows.set(foreign.projectionId, foreign);
  f.vectors.set("foreign-vector", [1]);
  f.source.get.mockResolvedValueOnce(undefined);
  await f.project(history);
  expect(f.rows.get("foreign")?.status).toBe("ready");
  expect(f.vectors.has("foreign-vector")).toBe(true);
  f.source.get
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("canonical unavailable"));
  await expect(f.project(history)).rejects.toThrow("canonical unavailable");
  expectReadyProjection(f, current);
});
