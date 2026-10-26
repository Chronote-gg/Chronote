import type { MeetingHistory } from "./db";
export type PersonalHistoryWriteResult =
  { kind: "committed"; history: MeetingHistory } | { kind: "stale" };
