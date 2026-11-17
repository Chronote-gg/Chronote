import type { MeetingHistory } from "./db";

export type SearchProjectionKey = {
  guildId: string;
  channelId_timestamp: string;
};
export type SearchProjectionDocument = {
  key: string;
  dataset: "meetings" | "transcripts";
  inputHash: string;
  text: string;
  metadata: Record<string, string | number | boolean | string[]>;
};
export type MeetingSearchProjectionState = {
  projectionId: string;
  generation: string;
  dataset: "meetings" | "transcripts";
  meeting: SearchProjectionKey;
  revision: string;
  transcriptHash: string;
  model: "text-embedding-3-small";
  dimensions: 1536;
  status: "pending" | "ready" | "tombstone";
  documents: Pick<SearchProjectionDocument, "key" | "dataset" | "inputHash">[];
  attempts: number;
  retryAt: number;
  createdAt: number;
  failure?: "embedding" | "source" | "index" | "limits";
};
export interface MeetingSearchStateRepository {
  get(projectionId: string): Promise<MeetingSearchProjectionState | undefined>;
  put(state: MeetingSearchProjectionState): Promise<void>;
  list(
    meeting: SearchProjectionKey,
    generation: string,
  ): Promise<MeetingSearchProjectionState[]>;
  scan(
    cursor?: string,
  ): Promise<{ items: MeetingSearchProjectionState[]; cursor?: string }>;
}
export interface SearchProjectionSource {
  get(
    key: SearchProjectionKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>;
  transcript(history: MeetingHistory, signal?: AbortSignal): Promise<string>;
}
