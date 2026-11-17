import { config } from "../../services/configService";
/** @jest-environment node */
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { queryMeetingSearchCandidates } from "../meetingSearchRepository";
const send = jest.spyOn(S3VectorsClient.prototype, "send");
const ref = { serverId: "server", id: "voice#2001-01-01" };
beforeEach(() => {
  config.search.meetingIndexArn = "synthetic-index";
  config.search.enabled = true;
  send.mockReset();
});
afterAll(() => send.mockRestore());
test("uses native hybrid within the authorized meeting partition and preserves pagination", async () => {
  send.mockResolvedValue({
    vectors: [
      {
        key: "key",
        metadata: {
          server_id: "server",
          meeting_id: ref.id,
          source_revision: "rev",
        },
      },
    ],
    nextToken: "provider-continuation",
  } as never);
  const result = await queryMeetingSearchCandidates({
    kind: "meeting",
    query: "query",
    meetingIds: [ref],
    queryVector: [1, 2],
    nextToken: "previous",
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        queryTexts: [{ text: "query", metadataKey: "search_text" }],
        queryVector: { float32: [1, 2] },
        filter: {
          meeting_ref: { $in: [JSON.stringify([ref.serverId, ref.id])] },
        },
        nextToken: "previous",
      }),
    }),
    expect.anything(),
  );
  expect(result.nextToken).toBe("provider-continuation");
  expect(result.candidates[0].meeting).toEqual(ref);
});
test("keyword query omits vectors and refuses unexpected metadata refs", async () => {
  send.mockResolvedValue({
    vectors: [
      {
        key: "key",
        metadata: {
          server_id: "other",
          meeting_id: ref.id,
          source_revision: "rev",
        },
      },
    ],
  } as never);
  const result = await queryMeetingSearchCandidates({
    kind: "meeting",
    query: "query",
    meetingIds: [ref],
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.not.objectContaining({ queryVector: expect.anything() }),
    }),
    expect.anything(),
  );
  expect(result.candidates).toEqual([]);
});
test("does not claim exhaustive results when terminal topK is full", async () => {
  send.mockResolvedValue({
    vectors: Array.from({ length: 100 }, () => ({ key: "key", metadata: {} })),
  } as never);
  expect(
    (
      await queryMeetingSearchCandidates({
        kind: "meeting",
        query: "query",
        meetingIds: [ref],
      })
    ).windowLimited,
  ).toBe(true);
});
test("rejects a partition beyond the provider constraint budget rather than dropping IDs", async () => {
  await expect(
    queryMeetingSearchCandidates({
      kind: "meeting",
      query: "query",
      meetingIds: Array.from({ length: 81 }, () => ref),
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(send).not.toHaveBeenCalled();
});

test("disabled serving gate refuses direct repository access", async () => {
  config.search.enabled = false;
  await expect(
    queryMeetingSearchCandidates({
      kind: "meeting",
      query: "launch",
      meetingIds: [ref],
    }),
  ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  expect(send).not.toHaveBeenCalled();
});
