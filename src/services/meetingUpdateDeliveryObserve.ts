import type { MeetingUpdateSubmission } from "../types/meetingUpdateDelivery";
import type { MeetingDeliveryObservation } from "./meetingUpdateDeliveryTypes";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pointersFor } from "../repositories/meetingUpdateDeliveryState";
import type { MeetingUpdateProviderOperation } from "../types/meetingUpdateDelivery";
import type { DeliveryHistory } from "./meetingUpdateDeliveryTypes";
import { MeetingDeliveryStopped } from "./meetingUpdateDeliveryTypes";
import type { DeliveryContext } from "./meetingUpdateDeliveryState";
import { registeredPointers } from "./meetingUpdateDeliveryState";
import {
  meetingUpdateMessageFingerprint,
  observedMeetingUpdateCreationFingerprint,
} from "./meetingUpdateFingerprint";
import { MeetingUpdatePlanBlocked } from "./meetingUpdatePlanTypes";
import type { DiscordEditorMessage } from "./discordMessageEditor";

type Target = { channelId: string; messageId: string };
export async function observeDeliveryDestination(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  channelId: string,
  terminal = false,
) {
  const bot = await ctx.effect(
    (signal) => ctx.deps.discord.getBotIdentity(signal),
    terminal,
  );
  if (ctx.botId && bot.id !== ctx.botId)
    throw new MeetingUpdatePlanBlocked("unsupported_layout");
  const channel = await ctx.effect(
    (signal) => ctx.deps.discord.getChannel(channelId, signal),
    terminal,
  );
  if (
    channel.id !== channelId ||
    channel.guild_id !== row.guildId ||
    ![0, 5, 10, 11, 12].includes(channel.type)
  )
    throw new MeetingUpdatePlanBlocked("inaccessible_destination");
  return { bot, channel };
}
export async function observeDeliveryTarget(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  target: Target,
  terminal = false,
) {
  const { bot } = await observeDeliveryDestination(
    ctx,
    row,
    target.channelId,
    terminal,
  );
  const message = await ctx.effect(
    (signal) => ctx.deps.discord.getMessage({ ...target, signal }),
    terminal,
  );
  if (
    message &&
    (message.id !== target.messageId ||
      message.channel_id !== target.channelId ||
      message.author.id !== bot.id ||
      !message.author.bot ||
      message.webhook_id ||
      (message.flags & 32768) !== 0)
  )
    throw new MeetingUpdatePlanBlocked("unsupported_layout");
  return message;
}
export async function gatherDeliveryTargets(
  ctx: DeliveryContext,
  row: DeliveryHistory,
) {
  const bot = await ctx.effect((signal) =>
    ctx.deps.discord.getBotIdentity(signal),
  );
  const pointers = pointersFor(row);
  const targets: Target[] = pointers.notesMessageIds.map((messageId) => ({
    channelId: pointers.notesChannelId ?? "",
    messageId,
  }));
  if (row.summaryMessageId)
    targets.push({
      channelId: row.textChannelId ?? pointers.notesChannelId ?? "",
      messageId: row.summaryMessageId,
    });
  for (const candidate of [
    ...row.updateDelivery.createdCandidates,
    ...row.updateDelivery.cleanupCandidates,
  ])
    targets.push(candidate);
  const unique = targets.filter(
    (target, index) =>
      targets.findIndex(
        (other) =>
          other.channelId === target.channelId &&
          other.messageId === target.messageId,
      ) === index,
  );
  const channels = [];
  const messages = [];
  for (const channelId of [
    ...new Set(unique.map((target) => target.channelId)),
  ])
    channels.push(
      await ctx.effect((signal) =>
        ctx.deps.discord.getChannel(channelId, signal),
      ),
    );
  for (const target of unique) {
    const message = await observeDeliveryTarget(ctx, row, target);
    if (!message) throw new MeetingUpdatePlanBlocked("missing_target");
    messages.push(message);
  }
  return { botId: bot.id, channels, messages };
}
export async function verifyDeliveryOperation(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  operation: MeetingUpdateProviderOperation,
  messageId?: string,
) {
  if (operation.kind === "register") {
    if (
      !isDeepStrictEqual(
        pointersFor(row),
        registeredPointers(ctx.own(row), operation),
      )
    )
      throw new MeetingDeliveryStopped("Registration differs");
    return createHash("sha256")
      .update(JSON.stringify(registeredPointers(ctx.own(row), operation)))
      .digest("hex");
  }
  if (operation.kind === "post" && !messageId)
    throw new MeetingDeliveryStopped("POST identity is unknown");
  const target = {
    channelId: operation.channelId,
    messageId: operation.kind === "post" ? messageId! : operation.messageId,
  };
  const message = await observeDeliveryTarget(ctx, row, target, true);
  if (operation.kind === "delete") {
    if (message)
      throw new MeetingDeliveryStopped("Deleted message is still present");
    return operation.beforeFingerprint;
  }
  if (!message) throw new MeetingDeliveryStopped("Result is missing");
  const fingerprint =
    operation.kind === "post"
      ? observedMeetingUpdateCreationFingerprint(message)
      : meetingUpdateMessageFingerprint(message);
  if (fingerprint !== operation.desiredFingerprint)
    throw new MeetingDeliveryStopped("Result differs from submitted intent");
  return fingerprint;
}
export async function verifyDeliveryObservations(
  ctx: DeliveryContext,
  row: DeliveryHistory,
) {
  const progress = ctx.own(row);
  for (const observation of progress.attempt.observations) {
    if (
      progress.attempt.operations.some(
        (op) =>
          (op.kind === "patch" || op.kind === "delete") &&
          op.messageId === observation.messageId &&
          op.channelId === observation.channelId,
      )
    )
      continue;
    const message = await observeDeliveryTarget(ctx, row, observation, true);
    if (
      !message ||
      meetingUpdateMessageFingerprint(message) !== observation.fingerprint
    )
      throw new MeetingDeliveryStopped("Observation changed");
  }
}
export function assertDeliveryWriteResponse(
  message: DiscordEditorMessage,
  operation: Extract<
    MeetingUpdateProviderOperation,
    { kind: "patch" | "post" }
  >,
) {
  if (
    message.channel_id !== operation.channelId ||
    !message.author.bot ||
    message.webhook_id ||
    (operation.kind === "patch" && message.id !== operation.messageId)
  )
    throw new MeetingDeliveryStopped("Response identity differs");
}

type ObservedOperation = Exclude<
  MeetingUpdateProviderOperation,
  { kind: "register" }
>;
function observedMessageId(
  operation: ObservedOperation,
  submission: MeetingUpdateSubmission,
) {
  if (operation.kind !== "post") return operation.messageId;
  if (submission.kind === "returned") return submission.messageId;
  if (submission.kind === "verified" && submission.receipt.kind === "message")
    return submission.receipt.messageId;
  return undefined;
}
function compareUncertainMessage(
  operation: ObservedOperation,
  message: DiscordEditorMessage | null,
): MeetingDeliveryObservation["kind"] {
  if (!message) return operation.kind === "delete" ? "desired" : "missing";
  const fingerprint =
    operation.kind === "post"
      ? observedMeetingUpdateCreationFingerprint(message)
      : meetingUpdateMessageFingerprint(message);
  if (operation.kind === "delete")
    return fingerprint === operation.beforeFingerprint ? "before" : "different";
  if (fingerprint === operation.desiredFingerprint) return "desired";
  return operation.kind === "patch" &&
    fingerprint === operation.beforeFingerprint
    ? "before"
    : "different";
}
async function observeUncertainOperation(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  operation: ObservedOperation,
  submission: MeetingUpdateSubmission,
): Promise<MeetingDeliveryObservation | null> {
  const messageId = observedMessageId(operation, submission);
  if (!messageId) return null;
  try {
    const message = await observeDeliveryTarget(ctx, row, {
      channelId: operation.channelId,
      messageId,
    });
    return {
      operationId: operation.operationId,
      kind: compareUncertainMessage(operation, message),
    };
  } catch {
    return { operationId: operation.operationId, kind: "unavailable" };
  }
}
export async function observeUncertainDelivery(
  ctx: DeliveryContext,
  row: DeliveryHistory,
): Promise<MeetingDeliveryObservation[]> {
  const progress = row.updateDelivery.progress;
  if (!("attempt" in progress)) return [];
  const observations: MeetingDeliveryObservation[] = [];
  for (const [index, operation] of progress.attempt.operations.entries()) {
    if (ctx.input.work.signal.aborted || ctx.input.signal?.aborted) break;
    const submission = progress.operations[index].submission;
    if (submission.kind === "prepared" || operation.kind === "register")
      continue;
    const observation = await observeUncertainOperation(
      ctx,
      row,
      operation,
      submission,
    );
    if (observation) observations.push(observation);
  }
  return observations;
}
