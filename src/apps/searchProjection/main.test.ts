/** @jest-environment node */
jest.mock("../../services/searchEmbeddingService", () => ({
  embedSearchText: jest.fn(),
}));
import {
  createSearchProjectionHandler,
  createSearchProjectionReconciler,
} from "./main";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  MeetingSearchProjectionState,
  SearchProjectionKey,
} from "../../types/meetingSearchProjection";

test("returns sequence number for only failed stream records and reads canonical keys", async () => {
  const project = jest
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("retry"));
  const reconcile = jest.fn();
  const handler = createSearchProjectionHandler({ project, reconcile });
  const result = await handler({
    Records: [
      {
        eventID: "event1",
        dynamodb: {
          SequenceNumber: "1",
          Keys: marshall({ guildId: "g", channelId_timestamp: "one" }),
        },
      },
      {
        eventID: "event2",
        dynamodb: {
          SequenceNumber: "2",
          Keys: marshall({ guildId: "g", channelId_timestamp: "two" }),
        },
      },
    ],
  });
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "2" }] });
  expect(project).toHaveBeenNthCalledWith(
    1,
    {
      guildId: "g",
      channelId_timestamp: "one",
    },
    expect.any(AbortSignal),
  );
  expect(reconcile).not.toHaveBeenCalled();
});
test("scheduled event resumes reconciliation", async () => {
  const reconcile = jest.fn();
  await createSearchProjectionHandler({ project: jest.fn(), reconcile })({});
  expect(reconcile).toHaveBeenCalledTimes(1);
});

test("deadline cancels work with time left for durable failure handling", async () => {
  jest.useFakeTimers();
  try {
    const project = jest.fn(
      async (_key, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(Error("deadline")), {
            once: true,
          });
        }),
    );
    const handler = createSearchProjectionHandler({
      project,
      reconcile: jest.fn(),
    });
    const result = handler(
      {
        Records: [
          {
            dynamodb: {
              SequenceNumber: "3",
              Keys: marshall({ guildId: "g", channelId_timestamp: "three" }),
            },
          },
        ],
      },
      { getRemainingTimeInMillis: () => 40_000 },
    );
    await jest.advanceTimersByTimeAsync(10_001);
    expect(await result).toEqual({
      batchItemFailures: [{ itemIdentifier: "3" }],
    });
    expect(project.mock.calls[0][1]?.aborted).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

function reconciliationFixture() {
  let checkpoint: { historyCursor?: string; stateCursor?: string } = {
    historyCursor: "history-one",
    stateCursor: "state-one",
  };
  const row = (
    id: string,
    extra: Partial<MeetingSearchProjectionState> = {},
  ): MeetingSearchProjectionState => ({
    projectionId: id,
    generation: "g1",
    dataset: "meetings",
    meeting: { guildId: "server", channelId_timestamp: id },
    revision: "rev",
    transcriptHash: "",
    model: "text-embedding-3-small",
    dimensions: 1536,
    status: "tombstone",
    documents: [],
    attempts: 1,
    retryAt: 0,
    createdAt: 0,
    ...extra,
  });
  const state = {
    checkpoint: jest.fn(async () => ({ ...checkpoint })),
    saveCheckpoint: jest.fn(
      async (_generation: string, next: typeof checkpoint) => {
        checkpoint = { ...next };
      },
    ),
    scan: jest.fn(
      async (): Promise<{
        items: MeetingSearchProjectionState[];
        cursor?: string;
      }> => ({ items: [row("deleted")], cursor: "state-two" }),
    ),
  };
  const sourcePage = jest.fn(
    async (): Promise<{ items: SearchProjectionKey[]; cursor?: string }> => ({
      items: [{ guildId: "server", channelId_timestamp: "existing" }],
      cursor: "history-two",
    }),
  );
  const project = jest.fn(async () => {});
  const reconcile = createSearchProjectionReconciler({
    generation: "g1",
    state,
    sourcePage,
    project,
    now: () => 1000,
  });
  return { state, sourcePage, project, reconcile, row };
}

test("reconciliation resumes both durable scan cursors and visits deleted sources from tombstones", async () => {
  const f = reconciliationFixture();
  await f.reconcile();
  expect(f.sourcePage).toHaveBeenCalledWith("history-one");
  expect(f.state.scan).toHaveBeenCalledWith("state-one");
  expect(f.project).toHaveBeenCalledWith(
    { guildId: "server", channelId_timestamp: "deleted" },
    undefined,
  );
  await f.reconcile();
  expect(f.sourcePage).toHaveBeenLastCalledWith("history-two");
  expect(f.state.scan).toHaveBeenLastCalledWith("state-two");
});

test("failed source does not pin backfill; checkpoint advances before reporting failure", async () => {
  const f = reconciliationFixture();
  f.project.mockRejectedValueOnce(Error("provider unavailable"));
  await expect(f.reconcile()).rejects.toThrow("failed for 1 sources");
  expect(f.state.saveCheckpoint).toHaveBeenCalledWith("g1", {
    historyCursor: "history-two",
    stateCursor: "state-two",
  });
  expect(f.project).toHaveBeenCalledTimes(2);
});

test("reconciliation deduplicates a page and skips other generations and future retries", async () => {
  const f = reconciliationFixture();
  f.state.scan.mockResolvedValue({
    items: [
      f.row("existing"),
      f.row("future", { retryAt: 2000 }),
      f.row("other", { generation: "g2" }),
    ],
  });
  await f.reconcile();
  expect(f.project).toHaveBeenCalledTimes(1);
});

test("source scan failure does not advance a checkpoint; exhausted scans wrap for future missed changes", async () => {
  const f = reconciliationFixture();
  f.sourcePage.mockRejectedValueOnce(Error("Dynamo unavailable"));
  await expect(f.reconcile()).rejects.toThrow("Dynamo unavailable");
  expect(f.state.saveCheckpoint).not.toHaveBeenCalled();
  f.sourcePage.mockResolvedValue({ items: [] });
  f.state.scan.mockResolvedValue({ items: [] });
  await f.reconcile();
  await f.reconcile();
  expect(f.sourcePage).toHaveBeenLastCalledWith(undefined);
  expect(f.state.scan).toHaveBeenLastCalledWith(undefined);
});
