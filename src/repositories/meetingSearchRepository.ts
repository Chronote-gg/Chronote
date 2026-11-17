import { config } from "../services/configService";
import {
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { z } from "zod";
import type {
  MeetingRef,
  MeetingSearchCandidate,
} from "../types/meetingSearch";
import { MeetingSearchError } from "../types/meetingSearch";

const metadataSchema = z.object({
  server_id: z.string(),
  meeting_id: z.string(),
  source_revision: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  transcript_hash: z.string().optional(),
});
const client = new S3VectorsClient({});
export async function queryMeetingSearchCandidates(input: {
  kind: "meeting" | "transcript";
  query: string;
  meetingIds: MeetingRef[];
  queryVector?: number[];
  signal?: AbortSignal;
  nextToken?: string;
}) {
  if (!config.search.enabled)
    throw new MeetingSearchError(
      "temporarily_unavailable",
      "Meeting search is not enabled.",
      true,
    );
  if (!input.meetingIds.length || input.meetingIds.length > 80)
    throw new MeetingSearchError(
      "invalid_argument",
      "Search partitions require 1 to 80 meetings.",
    );
  const indexArn =
    input.kind === "meeting"
      ? config.search.meetingIndexArn
      : config.search.transcriptIndexArn;
  if (!indexArn)
    throw new MeetingSearchError(
      "temporarily_unavailable",
      "Search is not configured.",
      true,
    );
  const result = await client.send(
    new QueryVectorsCommand({
      indexArn,
      topK: 100,
      queryTexts: [{ text: input.query, metadataKey: "search_text" }],
      queryMode: "ENHANCED",
      nextToken: input.nextToken,
      ...(input.queryVector
        ? { queryVector: { float32: input.queryVector } }
        : {}),
      filter: {
        meeting_ref: {
          $in: input.meetingIds.map((ref) =>
            JSON.stringify([ref.serverId, ref.id]),
          ),
        },
      },
      returnMetadata: true,
    }),
    { abortSignal: input.signal },
  );
  const candidates: MeetingSearchCandidate[] = [];
  for (const vector of result.vectors ?? []) {
    const parsed = metadataSchema.safeParse(vector.metadata);
    if (!parsed.success) continue;
    const data = parsed.data;
    if (
      !input.meetingIds.some(
        (ref) => ref.serverId === data.server_id && ref.id === data.meeting_id,
      )
    )
      continue;
    candidates.push({
      key: vector.key ?? "",
      meeting: { serverId: data.server_id, id: data.meeting_id },
      sourceRevision: data.source_revision,
      start: data.start,
      end: data.end,
      transcriptHash: data.transcript_hash,
    });
  }
  // A terminal topK-sized window does not prove corpus-wide exhaustion.
  return {
    candidates,
    nextToken: result.nextToken,
    windowLimited: !result.nextToken && (result.vectors?.length ?? 0) === 100,
  };
}
