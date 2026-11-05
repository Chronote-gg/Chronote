import { escapeMarkdown } from "@discordjs/formatters";
import { DiscordMessageHttpError } from "../discordMessageEditor";
import type { AnnouncementDiscordClient } from "./announcementDiscordClient";
import {
  emptyCounts,
  type Result,
  type SendCounts,
  type SkipReason,
  tally,
} from "./announcementCounts";
import type { AnnouncementPreview, RunnerDeps } from "./announcementRunner";
import {
  missingPermissions,
  POSTABLE_CHANNEL_TYPES,
} from "./announcementTargets";
import type {
  ChannelSource,
  GuildSnapshot,
  RequiredPermissionName,
  TargetDecision,
} from "./announcementTypes";

export const POST_INTERVAL_MS = 1000;

const PERMISSION_DISPLAY_NAMES: Record<RequiredPermissionName, string> = {
  ViewChannel: "View Channel",
  SendMessages: "Send Messages",
  EmbedLinks: "Embed Links",
};

/** The one line of message content an owner DM carries above the embed. */
export const ownerDmContent = (
  serverName: string,
  missing: RequiredPermissionName[],
) =>
  `Chronote could not post this notice in the community updates channel of ${escapeMarkdown(serverName)} because it is missing: ${missing.map((name) => PERMISSION_DISPLAY_NAMES[name]).join(", ")}. Grant these to Chronote in that channel to receive future notices there.`;

export const readFailure = (error: unknown) =>
  error instanceof DiscordMessageHttpError
    ? `status ${error.status}`
    : error instanceof Error
      ? error.name
      : "unknown error";

export const fetchSnapshot = async (
  discord: AnnouncementDiscordClient,
  guildId: string,
  botUserId: string,
  notesChannelId: string | null,
): Promise<GuildSnapshot> => {
  const [guild, channels, botRoleIds] = await Promise.all([
    discord.getGuild(guildId),
    discord.listGuildChannels(guildId),
    discord.getMemberRoleIds(guildId, botUserId),
  ]);
  return {
    guildId,
    guildName: guild.name,
    ownerId: guild.ownerId,
    roles: guild.roles,
    botRoleIds,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    systemChannelId: guild.systemChannelId,
    notesChannelId,
    channels,
  };
};

type Outcome = { result: Result; line: string; posted: boolean };

type SendContext = {
  deps: RunnerDeps;
  preview: AnnouncementPreview;
};
type Destination = {
  channelId: string;
  channelSource: ChannelSource;
  content?: string;
};

const skip = (reason: SkipReason, detail?: string): Outcome => ({
  result: reason,
  posted: false,
  line: `skipped ${reason}${detail ? `: ${detail}` : ""}`,
});

const isClosedDm = (error: DiscordMessageHttpError) =>
  error.status === 403 || error.discordCode === 50007;

const isDefiniteRejection = (
  error: unknown,
): error is DiscordMessageHttpError =>
  error instanceof DiscordMessageHttpError &&
  error.status >= 400 &&
  error.status < 500;

/** Record updates after a post must not hide that the post happened. */
const recordNote = async (update: () => Promise<void>) => {
  try {
    await update();
    return "";
  } catch (error) {
    return `; delivery record update failed (${readFailure(error)}), record left pending`;
  }
};

const claim = (
  { deps, preview }: SendContext,
  guildId: string,
  destination: Destination,
) =>
  deps.store.claimPending(
    {
      announcementId: preview.announcement.id,
      guildId,
      channelId: destination.channelId,
      channelSource: destination.channelSource,
      previewSha256: preview.sha256,
      createdAt: deps.now().toISOString(),
    },
    { replaceFailed: preview.retryFailed },
  );

const markFailed = (
  { deps, preview }: SendContext,
  guildId: string,
  reason: string,
) =>
  recordNote(() =>
    deps.store.markFailed(preview.announcement.id, guildId, reason, deps.now()),
  );

const post = async (
  context: SendContext,
  guildId: string,
  destination: Destination,
): Promise<Outcome> => {
  const { deps, preview } = context;
  if ((await claim(context, guildId, destination)) === "exists")
    return skip("already_sent", "a delivery record already exists");
  const isDm = destination.channelSource === "owner_dm";
  const where = isDm
    ? `owner DM channel ${destination.channelId}`
    : `${destination.channelSource} channel ${destination.channelId}`;
  let messageId: string;
  try {
    ({ id: messageId } = await deps.discord.createMessage(
      destination.channelId,
      preview.embed,
      { content: destination.content },
    ));
  } catch (error) {
    if (!isDefiniteRejection(error))
      return {
        result: "unknown",
        posted: true,
        line: `unknown outcome posting to ${where} (${readFailure(error)}); record left pending, check by hand`,
      };
    const reason =
      isDm && isClosedDm(error)
        ? "owner_dms_closed"
        : `discord_${error.status}`;
    const note = await markFailed(context, guildId, reason);
    return {
      result: reason === "owner_dms_closed" ? reason : "failed",
      posted: true,
      line: `failed ${reason} posting to ${where}${note}`,
    };
  }
  const note = await recordNote(() =>
    deps.store.markSent(
      preview.announcement.id,
      guildId,
      messageId,
      deps.now(),
    ),
  );
  return {
    result: isDm ? "owner_dm" : "sent",
    posted: true,
    line: `sent to ${where} as message ${messageId}${note}`,
  };
};

/** The previewed channel only: a changed server is skipped, never redirected. */
const sendToChannel = async (
  context: SendContext,
  guildId: string,
  decision: Extract<TargetDecision, { kind: "target" }>,
): Promise<Outcome> => {
  const { deps, preview } = context;
  const settings = await deps.settings.read(guildId);
  if (settings.optedOut) return skip("opted_out");
  let snapshot: GuildSnapshot;
  try {
    snapshot = await fetchSnapshot(
      deps.discord,
      guildId,
      preview.botUserId,
      settings.notesChannelId,
    );
  } catch (error) {
    return skip("discord_error", readFailure(error));
  }
  const channel = snapshot.channels.find(
    (entry) => entry.id === decision.channelId,
  );
  if (!channel || !POSTABLE_CHANNEL_TYPES.has(channel.type))
    return skip("no_channel", "the previewed channel is gone or not text");
  const missing = missingPermissions(snapshot, preview.botUserId, channel);
  if (missing.length > 0)
    return skip("missing_permissions", missing.join(", "));
  return post(context, guildId, decision);
};

const sendOwnerDm = async (
  context: SendContext,
  guildId: string,
  decision: Extract<TargetDecision, { kind: "owner_dm" }>,
): Promise<Outcome> => {
  const { deps } = context;
  const settings = await deps.settings.read(guildId);
  if (settings.optedOut) return skip("opted_out");
  let ownerId: string;
  try {
    ({ ownerId } = await deps.discord.getGuild(guildId));
  } catch (error) {
    return skip("discord_error", readFailure(error));
  }
  // Only the owner the operator approved, and only while they still own it.
  if (ownerId !== decision.ownerId)
    return skip("discord_error", "the server owner changed since preview");
  let dmChannelId: string;
  try {
    dmChannelId = await deps.discord.openDmChannel(decision.ownerId);
  } catch (error) {
    if (!(error instanceof DiscordMessageHttpError && isClosedDm(error)))
      return skip("discord_error", `DM open failed: ${readFailure(error)}`);
    // No DM channel exists, so the record holds a marker, not a user id.
    const destination = {
      channelId: "dm_not_opened",
      channelSource: "owner_dm" as const,
    };
    if ((await claim(context, guildId, destination)) === "exists")
      return skip("already_sent", "a delivery record already exists");
    const note = await markFailed(context, guildId, "owner_dms_closed");
    return {
      result: "owner_dms_closed",
      posted: false,
      line: `skipped owner_dms_closed: DM could not be opened${note}`,
    };
  }
  return post(context, guildId, {
    channelId: dmChannelId,
    channelSource: "owner_dm",
    content: ownerDmContent(decision.guildName, decision.missing),
  });
};

const deliver = (
  context: SendContext,
  { guildId, decision }: AnnouncementPreview["entries"][number],
): Outcome | Promise<Outcome> => {
  if (decision.kind === "target")
    return sendToChannel(context, guildId, decision);
  if (decision.kind === "owner_dm")
    return sendOwnerDm(context, guildId, decision);
  return skip(decision.reason, "detail" in decision ? decision.detail : "");
};

/**
 * Sends an approved preview one server at a time. Each server is re-checked,
 * claimed, posted and recorded in that order, so a rerun never double-posts.
 * An aborted signal stops before the next server and still returns counts; it
 * never cancels a post already in flight, so that post is still recorded.
 */
export async function sendAnnouncementPreview(
  deps: RunnerDeps,
  preview: AnnouncementPreview,
  options: { signal?: AbortSignal; onEntry?: (line: string) => void },
): Promise<SendCounts> {
  const { signal, onEntry = () => undefined } = options;
  const context: SendContext = { deps, preview };
  const counts = emptyCounts();
  let pace = false;
  let attempted = 0;
  for (const entry of preview.entries) {
    // Pace only before the next server that may post, so skips cost nothing.
    if (pace && entry.decision.kind !== "skip") {
      await deps.sleep(POST_INTERVAL_MS);
      pace = false;
    }
    if (signal?.aborted) break;
    attempted += 1;
    let outcome: Outcome;
    try {
      outcome = await deliver(context, entry);
    } catch (error) {
      // Settings or claim failures happen before any post to this server.
      tally(counts, "unknown");
      onEntry(
        `${entry.guildId}: stopped: ${readFailure(error)}; nothing was posted to this server and its delivery record may be pending`,
      );
      return counts;
    }
    pace ||= outcome.posted;
    tally(counts, outcome.result);
    onEntry(`${entry.guildId}: ${outcome.line}`);
  }
  const notAttempted = preview.entries.length - attempted;
  if (notAttempted > 0)
    onEntry(`stopped by interrupt; ${notAttempted} servers not attempted`);
  return counts;
}
