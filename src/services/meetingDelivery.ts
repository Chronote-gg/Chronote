import { z } from "zod";
import {
  buildMeetingResultMessages,
  presentationFromHistory,
  type MeetingMessagePayload,
  type SummaryUpgradeOffer,
} from "../embed";
import { recordNotesAcknowledgement } from "../observability/meetingNotesLatency";
import type { MeetingHistory } from "../types/db";
import type { NotesDeliveryTiming } from "../types/meetingNotesTiming";
import type { DeliveryResult, MeetingDelivery } from "../types/meetingDelivery";
import type { RecordingRecoveryState } from "../types/meetingLifecycle";
import { config } from "./configService";
import {
  createDiscordMessageTransport,
  DiscordMessageHttpError,
  discordBotIdentitySchema,
  discordEditorMessageSchema,
  type DiscordEditorMessage,
} from "./discordMessageEditor";

export type RestMessage = {
  embeds: Record<string, unknown>[];
  components?: Record<string, unknown>[];
  content?: string;
  allowed_mentions: { parse: [] };
};

export type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "temporary"; error: unknown }
  | { kind: "permanent"; error: unknown }
  | { kind: "not_applicable" };

export type DeliveryTransport = Pick<
  ReturnType<typeof createDiscordMessageTransport>,
  "getBotIdentity" | "updateMessage" | "createMessage" | "listMessages"
>;

type DeliveryPatch = Pick<
  MeetingHistory,
  | "summaryMessageId"
  | "notesMessageIds"
  | "notesChannelId"
  | "delivery"
  | "notesDeliveryTiming"
  | "recovery"
>;

/** Discord returns at most this many messages per channel read. */
const NOTES_READBACK_PAGE_SIZE = 100;
/** Pages of recent history searched when the row recorded no notes ids. */
const NOTES_READBACK_MAX_PAGES = 3;
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const UNKNOWN_MESSAGE_CODE = 10008;

/**
 * The value today's normal completion writes. Notes correction, meeting update
 * delivery and portal retry read it through `originalPublicationSettled`.
 */
export const DELIVERY_DONE: RecordingRecoveryState = {
  disposition: "done",
  outcome: "completed",
  stage: "delivery",
  attempt: 0,
  executionVersion: 1,
  retry: { maxAttempts: 3, nextAttemptAt: null },
};

const createdMessageSchema = discordEditorMessageSchema.pick({ id: true });
const channelMessagesSchema = z.array(discordEditorMessageSchema);

class DeliveryClaimLost extends Error {
  constructor() {
    super("Meeting delivery claim was lost");
    this.name = "DeliveryClaimLost";
  }
}

function toRest(payload: MeetingMessagePayload): RestMessage {
  return {
    embeds: payload.embeds.map((embed) => ({ ...embed.toJSON() })),
    components: payload.components?.map((row) => ({ ...row.toJSON() })),
    allowed_mentions: { parse: [] },
  };
}

export function renderMeetingDelivery(
  history: MeetingHistory,
  extras?: { upgrade?: SummaryUpgradeOffer },
): { summary: RestMessage; notes: RestMessage[] } {
  const messages = buildMeetingResultMessages(
    presentationFromHistory(history),
    extras?.upgrade,
  );
  return {
    summary: toRest(messages.summary),
    notes: messages.notes.map(toRest),
  };
}

function firstEmbed(message: { embeds: Record<string, unknown>[] }) {
  return message.embeds.at(0) ?? {};
}

function postedNotes(
  messages: DiscordEditorMessage[],
  history: MeetingHistory,
  botId: string,
  firstChunk = 0,
): DiscordEditorMessage[] {
  const start = Date.parse(history.timestamp);
  const marked = messages
    .filter(
      (message) =>
        message.author.id === botId &&
        // A missing timestamp parses to NaN, which equals nothing.
        Date.parse(String(firstEmbed(message).timestamp)) === start,
    )
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const expected = renderMeetingDelivery(history).notes.slice(firstChunk);
  const leading: DiscordEditorMessage[] = [];
  // Chunk titles carry their part number, so a missing chunk ends the run.
  // Known limit: if a correction changes the chunk count between runs, no title
  // matches and the remaining chunks are posted again.
  for (const [index, message] of marked.entries()) {
    if (
      index >= expected.length ||
      firstEmbed(message).title !== firstEmbed(expected[index]).title
    )
      break;
    leading.push(message);
  }
  return leading;
}

export function countPostedNotes(
  messages: DiscordEditorMessage[],
  history: MeetingHistory,
  botId: string,
): number {
  return postedNotes(messages, history, botId).length;
}

/**
 * Message routes swallow 404 (a missing summary is re-posted), so a 404 that
 * reaches here came from a channel route: the channel or the bot's access is gone.
 */
export function classifyDeliveryError(
  error: unknown,
): "temporary" | "permanent" {
  return error instanceof DiscordMessageHttpError &&
    (error.status === HTTP_FORBIDDEN || error.status === HTTP_NOT_FOUND)
    ? "permanent"
    : "temporary";
}

function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + DISCORD_EPOCH_MS);
}

/**
 * Finds chunks that were posted but whose ids were never saved. Recorded ids are
 * a floor, so with any recorded the search reads forward from the last one;
 * otherwise it reads recent history newest first, back to the capture end.
 */
async function readUnrecordedNotes(input: {
  transport: DeliveryTransport;
  channelId: string;
  history: MeetingHistory;
  summaryMessageId: string;
  recorded: string[];
  signal: AbortSignal;
}): Promise<string[]> {
  const { transport, channelId, history, recorded, signal } = input;
  const botId = discordBotIdentitySchema.parse(
    await transport.getBotIdentity(signal),
  ).id;
  const list = async (page: { after?: string; before?: string }) =>
    channelMessagesSchema.parse(
      await transport.listMessages({
        channelId,
        ...page,
        limit: NOTES_READBACK_PAGE_SIZE,
        signal,
      }),
    );
  const found: DiscordEditorMessage[] = [];
  const last = recorded.at(-1);
  if (last) found.push(...(await list({ after: last })));
  else {
    const presentation = presentationFromHistory(history);
    const captureEnd = (
      presentation.endTime ?? presentation.startTime
    ).getTime();
    let before: string | undefined;
    for (let page = 0; page < NOTES_READBACK_MAX_PAGES; page++) {
      const messages = await list({ before });
      found.push(...messages);
      const oldest = messages
        .map((message) => message.id)
        .reduce<string | undefined>(
          (min, id) =>
            min === undefined || BigInt(id) < BigInt(min) ? id : min,
          undefined,
        );
      if (
        !oldest ||
        messages.length < NOTES_READBACK_PAGE_SIZE ||
        snowflakeTime(oldest) < captureEnd
      )
        break;
      before = oldest;
    }
  }
  // The summary carries the same marker, so it must not be read as a chunk.
  const candidates = found.filter(
    (message) => message.id !== input.summaryMessageId,
  );
  return postedNotes(candidates, history, botId, recorded.length).map(
    (message) => message.id,
  );
}

function defaultTransport(): DeliveryTransport {
  return createDiscordMessageTransport({ token: config.discord.botToken });
}

async function placeSummary(
  transport: DeliveryTransport,
  channelId: string,
  history: MeetingHistory,
  summary: RestMessage,
  signal: AbortSignal,
): Promise<{ id: string; result: DeliveryResult }> {
  // A recorded summary wins over the start message: after a re-post the start message is gone.
  const existing = history.summaryMessageId ?? history.startMessageId;
  if (
    existing &&
    (await transport.updateMessage({
      channelId,
      messageId: existing,
      payload: summary,
      signal,
    }))
  )
    return {
      id: existing,
      result: { outcome: "edited_existing", intended: 1, sent: 1, errors: [] },
    };
  const created = createdMessageSchema.parse(
    await transport.createMessage({ channelId, payload: summary, signal }),
  );
  return {
    id: created.id,
    result: {
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors: [],
      ...(existing
        ? {
            recoveredMissingMessage: {
              code: UNKNOWN_MESSAGE_CODE,
              status: HTTP_NOT_FOUND,
            },
          }
        : {}),
    },
  };
}

export async function deliverMeeting(input: {
  history: MeetingHistory;
  save(patch: DeliveryPatch): Promise<MeetingHistory | undefined>;
  transport?: DeliveryTransport;
  signal: AbortSignal;
  /** Which finisher loader produced the input, for notes latency. */
  path: NotesDeliveryTiming["path"];
  extras?: { upgrade?: SummaryUpgradeOffer };
}): Promise<DeliveryOutcome> {
  const { history, signal } = input;
  const channelId = history.textChannelId;
  if (!channelId) return { kind: "not_applicable" };
  const transport = input.transport ?? defaultTransport();
  const save = async (patch: DeliveryPatch) => {
    signal.throwIfAborted();
    if (!(await input.save(patch))) throw new DeliveryClaimLost();
  };
  const { summary, notes } = renderMeetingDelivery(history, input.extras);
  try {
    const placed = await placeSummary(
      transport,
      channelId,
      history,
      summary,
      signal,
    );
    let delivery: MeetingDelivery = {
      ...history.delivery,
      summary: placed.result,
    };
    await save({ summaryMessageId: placed.id, delivery });

    const notesMessageIds = [...(history.notesMessageIds ?? [])];
    let timing = history.notesDeliveryTiming;
    const acknowledge = (complete: boolean) => {
      if (history.notes?.trim())
        timing = recordNotesAcknowledgement(timing, {
          acknowledgedAt: new Date().toISOString(),
          complete,
          path: input.path,
        });
    };
    if (notesMessageIds.length < notes.length) {
      const adopted = await readUnrecordedNotes({
        transport,
        channelId,
        history,
        summaryMessageId: placed.id,
        recorded: notesMessageIds,
        signal,
      });
      if (adopted.length) {
        notesMessageIds.push(...adopted);
        await save({
          notesMessageIds: [...notesMessageIds],
          notesChannelId: channelId,
        });
      }
    }
    for (const chunk of notes.slice(notesMessageIds.length)) {
      signal.throwIfAborted();
      const created = createdMessageSchema.parse(
        await transport.createMessage({ channelId, payload: chunk, signal }),
      );
      notesMessageIds.push(created.id);
      acknowledge(notesMessageIds.length === notes.length);
      await save({
        notesMessageIds: [...notesMessageIds],
        notesChannelId: channelId,
        notesDeliveryTiming: timing,
      });
    }
    // A resume that adopted every chunk posted nothing, so completion is acknowledged here.
    if (notes.length) acknowledge(true);

    delivery = {
      ...delivery,
      notes: {
        outcome: notes.length ? "complete" : "not_applicable",
        intended: notes.length,
        sent: notes.length,
        errors: [],
      },
    };
    await save({
      delivery,
      notesDeliveryTiming: timing,
      recovery: DELIVERY_DONE,
    });
    return { kind: "delivered" };
  } catch (error) {
    if (error instanceof DeliveryClaimLost || signal.aborted)
      return { kind: "temporary", error };
    return { kind: classifyDeliveryError(error), error };
  }
}

/** The no-speech and processing-failed notices: plain content that never pings. */
export async function deliverNotice(
  history: MeetingHistory,
  text: string,
  signal: AbortSignal,
  transport: DeliveryTransport = defaultTransport(),
): Promise<void> {
  const channelId = history.textChannelId;
  if (!channelId) return;
  const payload = {
    content: text,
    embeds: [],
    components: [],
    allowed_mentions: { parse: [] },
  };
  if (
    history.startMessageId &&
    (await transport.updateMessage({
      channelId,
      messageId: history.startMessageId,
      payload,
      signal,
    }))
  )
    return;
  await transport.createMessage({ channelId, payload, signal });
}
