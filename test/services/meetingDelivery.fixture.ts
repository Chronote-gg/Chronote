import {
  createDiscordMessageTransport,
  type DiscordEditorMessage,
} from "../../src/services/discordMessageEditor";
import type { RestMessage } from "../../src/services/meetingDelivery";
import type { MeetingHistory } from "../../src/types/db";

/** A synthetic meeting row and a fetch-level Discord fake shared by delivery and finish tests. */
export const BOT_ID = "100";
export const USER_ID = "600";
export const TEXT_CHANNEL_ID = "200";
export const VOICE_CHANNEL_ID = "300";
export const DISCORD_EPOCH_MS = 1420070400000n;
export const snowflake = (ms: number) =>
  String((BigInt(ms) - DISCORD_EPOCH_MS) << 22n);
export const GUILD_ID = "700";
export const START = "2026-01-01T00:00:00.000Z";
export const MEETING_SECONDS = 3600;
export const START_MESSAGE_ID = snowflake(Date.parse(START));
/** Notes are posted a minute after capture ends. */
export const POSTING_STARTS_AT =
  Date.parse(START) + (MEETING_SECONDS + 60) * 1000;
export const NOTES = Array.from(
  { length: 200 },
  (_, line) => `- Synthetic note line ${line} about a placeholder topic.`,
).join("\n");
export const UPGRADE = {
  url: "https://chronote.test/upgrade/select-server?serverId=700&plan=basic&source=discord_summary",
  recordedSeconds: 7200,
};
export const DONE_MARKER = {
  disposition: "done",
  outcome: "completed",
  stage: "delivery",
  attempt: 0,
  executionVersion: 1,
  retry: { maxAttempts: 3, nextAttemptAt: null },
};

export function history(
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory {
  return {
    lifecycleVersion: 2,
    guildId: GUILD_ID,
    channelId_timestamp: `${VOICE_CHANNEL_ID}#${START}`,
    meetingId: "meeting-synthetic",
    channelId: VOICE_CHANNEL_ID,
    textChannelId: TEXT_CHANNEL_ID,
    timestamp: START,
    startMessageId: START_MESSAGE_ID,
    participants: [{ id: "500", username: "synthetic-user" }],
    duration: MEETING_SECONDS,
    transcribeMeeting: true,
    generateNotes: true,
    notes: NOTES,
    summarySentence: "Synthetic summary.",
    tags: ["alpha"],
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    status: "complete",
    ownerInstanceId: "instance-synthetic",
    executionVersion: 1,
    ...overrides,
  };
}

export function discordMessage(
  id: string,
  body: Partial<RestMessage>,
  authorId = BOT_ID,
): DiscordEditorMessage {
  return {
    id,
    channel_id: TEXT_CHANNEL_ID,
    author: { id: authorId, bot: authorId === BOT_ID },
    content: body.content ?? "",
    embeds: body.embeds ?? [],
    components: body.components ?? [],
    attachments: [],
    flags: 0,
  };
}

export type RecordedRequest = {
  method: string;
  path: string;
  body?: RestMessage;
};

/** A fetch-level Discord with one text channel that keeps the messages it is sent. */
export function fakeDiscord() {
  const messages: DiscordEditorMessage[] = [
    discordMessage(START_MESSAGE_ID, { embeds: [{ title: "Processing" }] }),
  ];
  const requests: RecordedRequest[] = [];
  let clock = POSTING_STARTS_AT;
  const nextId = () => snowflake((clock += 1000));
  const byAge = (a: DiscordEditorMessage, b: DiscordEditorMessage) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : 1;
  const state = {
    messages,
    requests,
    /** User messages posted during the meeting, one per second after the start. */
    chat(count: number) {
      for (let second = 1; second <= count; second++)
        messages.push(
          discordMessage(
            snowflake(Date.parse(START) + second * 1000),
            { content: "synthetic chatter" },
            USER_ID,
          ),
        );
    },
    fail: undefined as
      | ((request: RecordedRequest, posts: number) => Response | undefined)
      | undefined,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: path + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const posts = requests.filter((r) => r.method === "POST").length;
    const injected = state.fail?.(request, posts);
    if (injected) return injected;
    if (path === "/users/@me") return json({ id: BOT_ID, bot: true });
    const match = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
    if (!match || match[1] !== TEXT_CHANNEL_ID)
      return new Response("{}", { status: 404 });
    if (request.method === "GET") {
      const limit = Number(url.searchParams.get("limit"));
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      const sorted = [...messages].sort(byAge);
      const page = after
        ? sorted.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit)
        : sorted
            .filter((m) => !before || BigInt(m.id) < BigInt(before))
            .slice(-limit);
      return json(page.reverse());
    }
    if (request.method === "POST") {
      const created = discordMessage(nextId(), request.body ?? {});
      messages.push(created);
      return json(created);
    }
    const index = messages.findIndex((message) => message.id === match[2]);
    if (index < 0) return new Response("{}", { status: 404 });
    if (request.method === "DELETE") {
      messages.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    messages[index] = { ...messages[index], ...request.body };
    return json(messages[index]);
  };
  return {
    ...state,
    state,
    fetchImpl,
    transport: createDiscordMessageTransport({
      token: "synthetic-token",
      fetchImpl,
    }),
  };
}

export function savingRow(initial: MeetingHistory) {
  let row = initial;
  const save = jest.fn(async (patch: Partial<MeetingHistory>) => {
    row = { ...row, ...patch };
    return row;
  });
  return { save, current: () => row };
}

export const signal = () => new AbortController().signal;
