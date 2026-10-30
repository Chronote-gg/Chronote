import { z } from "zod";
import type { MeetingSummaryRow } from "../pages/library/types";

export const unifiedUser = {
  id: "fixture-user",
  username: "Alex",
  avatar: null,
};
export const unifiedGuilds = [
  { id: "engineering", name: "Engineering HQ", canManage: true },
  { id: "community", name: "Community Studio", canManage: false },
];
export type UnifiedScenario = "mixed" | "empty" | "long" | "loading" | "error";
export function unifiedRows(): MeetingSummaryRow[] {
  return [
    ["engineering", "Engineering HQ", "Engineering planning"],
    ["community", "Community Studio", "Community workshop"],
    ["personal:fixture-user", "Personal recordings", "Personal interview"],
    ["personal:colleague", "Personal recordings", "Shared interview"],
    ["previous", "Previous collaboration", "Retained project review"],
  ].map(([serverId, serverName, meetingName], index) => ({
    id: `record-${index}`,
    meetingId: `session-${index}`,
    serverId,
    serverName,
    channelId: `channel-${index}`,
    channelName: "Planning",
    meetingName,
    timestamp: "2024-12-31T12:00:00.000Z",
    duration: 1800,
    tags: ["Planning"],
    notes: "",
    summarySentence: "Decisions and next steps from the conversation.",
    audioAvailable: false,
    transcriptAvailable: true,
  }));
}
const inputSchema = z.object({
  cursor: z.string().nullish(),
  meetingId: z.string().optional(),
  browse: z
    .object({
      scope: z.object({ kind: z.string(), serverId: z.string().optional() }),
      attendedOnly: z.boolean().optional(),
    })
    .optional(),
});
export function unifiedInput(url: URL, path: string) {
  const paths = decodeURIComponent(url.pathname.split("/trpc/")[1] ?? "").split(
    ",",
  );
  const body: unknown = JSON.parse(url.searchParams.get("input") ?? "{}");
  const slots = z.record(z.string(), z.unknown()).parse(body);
  const value =
    url.searchParams.get("batch") === "1"
      ? slots[String(paths.indexOf(path))]
      : body;
  return inputSchema.parse(value ?? {});
}
function scenarioRows(scenario: UnifiedScenario) {
  let rows = scenario === "empty" ? [] : unifiedRows();
  if (scenario === "long")
    rows = Array.from({ length: 40 }, (_, index) => ({
      ...unifiedRows()[0],
      id: `long-${index}`,
      meetingId: `long-session-${index}`,
      meetingName: `Planning session ${index + 1}`,
    }));
  return rows;
}
function filteredRows(
  input: ReturnType<typeof unifiedInput>,
  scenario: UnifiedScenario,
) {
  let rows = scenarioRows(scenario);
  const scope = input.browse?.scope;
  if (scope?.kind === "personal")
    rows = rows.filter((row) => row.serverId?.startsWith("personal:"));
  if (scope?.kind === "guild")
    rows = rows.filter((row) => row.serverId === scope.serverId);
  // Synthetic transport fixtures represent authorized backend results. Attendance
  // policy itself is exercised by the service tests, not reimplemented here.
  if (input.browse?.attendedOnly)
    rows = rows.filter((row) =>
      ["record-1", "record-3", "record-4"].includes(row.id),
    );
  return rows;
}
export function unifiedBrowse(url: URL, scenario: UnifiedScenario = "mixed") {
  const input = unifiedInput(url, "meetings.myList");
  const rows = filteredRows(input, scenario);
  const scope = input.browse?.scope;
  const paging =
    scenario === "mixed" &&
    scope?.kind === "all" &&
    !input.browse?.attendedOnly;
  const meetings = paging
    ? input.cursor
      ? rows.slice(3)
      : rows.slice(0, 3)
    : rows;
  const hasMore = paging && !input.cursor;
  return {
    meetings,
    hasMore,
    discoveryComplete: !hasMore,
    nextCursor: hasMore ? "page-two" : null,
  };
}
export function unifiedDetail(url?: URL) {
  const id = url ? unifiedInput(url, "meetings.detail").meetingId : undefined;
  return {
    meeting: {
      ...unifiedRows()[0],
      id: id ?? "record-0",
      status: "complete",
      notesVersion: 1,
      notes: Array.from(
        { length: 50 },
        (_, index) =>
          `- Decision ${index + 1}: confirm the owner and next step.`,
      ).join("\n"),
      attendees: ["Alex", "Jordan"],
      events: [],
      audioAccessEnabled: false,
      transcriptAccessEnabled: true,
    },
  };
}
