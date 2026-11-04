import { createHash } from "node:crypto";
import { stableJson } from "../../utils/stableJson";
import {
  type AnnouncementDeliveryStore,
  DeliveryTableMissingError,
  type DeliveryRecord,
} from "./announcementDeliveryStore";
import type { AnnouncementDiscordClient } from "./announcementDiscordClient";
import { renderAnnouncementEmbed } from "./announcementEmbed";
import { fetchSnapshot, readFailure } from "./announcementSend";
import type { GuildAnnouncementSettings } from "./announcementSettingsReader";
import { resolveAnnouncementTarget } from "./announcementTargets";
import type {
  Announcement,
  AnnouncementEmbed,
  TargetDecision,
} from "./announcementTypes";

export {
  previewCounts,
  type SendCounts,
  SKIP_REASONS,
  summaryLine,
} from "./announcementCounts";
export {
  ownerDmContent,
  POST_INTERVAL_MS,
  sendAnnouncementPreview,
} from "./announcementSend";

export type AnnouncementScope = {
  accountId: string;
  region: string;
  configTable: string;
  deliveryTable: string;
};

type RecordSkip = {
  kind: "skip";
  reason: "already_sent" | "pending_unknown" | "discord_error";
  detail?: string;
};

export type PreviewEntry = {
  guildId: string;
  decision: TargetDecision | RecordSkip;
};

export type AnnouncementPreview = {
  version: 1;
  createdAt: string;
  scope: AnnouncementScope;
  botUserId: string;
  retryFailed: boolean;
  announcement: Announcement;
  embed: AnnouncementEmbed;
  warnings: string[];
  entries: PreviewEntry[];
  sha256: string;
};

export type RunnerDeps = {
  discord: AnnouncementDiscordClient;
  store: AnnouncementDeliveryStore;
  settings: { read(guildId: string): Promise<GuildAnnouncementSettings> };
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

export const TABLE_MISSING_WARNING =
  "delivery table not found; send will refuse until the Terraform change is applied";

const recordDecision = (
  record: DeliveryRecord | undefined,
  retryFailed: boolean,
): RecordSkip | null => {
  if (!record) return null;
  if (record.status === "pending")
    return { kind: "skip", reason: "pending_unknown" };
  if (record.status === "failed" && retryFailed) return null;
  return { kind: "skip", reason: "already_sent" };
};

const previewDecision = async (
  deps: RunnerDeps,
  guildId: string,
  botUserId: string,
): Promise<PreviewEntry["decision"]> => {
  const settings = await deps.settings.read(guildId);
  if (settings.optedOut)
    return { kind: "skip", reason: "opted_out", rejected: [] };
  try {
    const snapshot = await fetchSnapshot(
      deps.discord,
      guildId,
      botUserId,
      settings.notesChannelId,
    );
    return resolveAnnouncementTarget(snapshot, botUserId, false);
  } catch (error) {
    return {
      kind: "skip",
      reason: "discord_error",
      detail: readFailure(error),
    };
  }
};

const existingRecords = async (
  store: AnnouncementDeliveryStore,
  announcementId: string,
  warnings: string[],
) => {
  try {
    return await store.listForAnnouncement(announcementId);
  } catch (error) {
    if (!(error instanceof DeliveryTableMissingError)) throw error;
    warnings.push(TABLE_MISSING_WARNING);
    return [];
  }
};

const selectGuildIds = (installed: string[], requested?: string[]) => {
  if (!requested) return installed;
  const unknown = requested.filter((id) => !installed.includes(id));
  if (unknown.length > 0)
    throw new Error(
      `Chronote is not installed in these servers: ${unknown.join(", ")}`,
    );
  return requested;
};

export function previewDigest(
  preview: Omit<AnnouncementPreview, "sha256">,
): string {
  return createHash("sha256").update(stableJson(preview)).digest("hex");
}

/** Reads Discord and the stores only: decides every server's delivery without sending. */
export async function buildAnnouncementPreview(
  deps: RunnerDeps,
  input: {
    scope: AnnouncementScope;
    announcement: Announcement;
    warnings: string[];
    guildIds?: string[];
    retryFailed: boolean;
  },
): Promise<AnnouncementPreview> {
  // The target list ages from when it was read, so the clock starts first.
  const now = deps.now();
  const embed = renderAnnouncementEmbed(input.announcement, now);
  const botUserId = await deps.discord.getBotUserId();
  const guildIds = selectGuildIds(
    await deps.discord.listBotGuildIds(),
    input.guildIds,
  );
  const warnings = [...input.warnings];
  const records = await existingRecords(
    deps.store,
    input.announcement.id,
    warnings,
  );
  if (records.length > 0)
    warnings.push(
      `announcement id ${input.announcement.id} already has ${records.length} delivery records from an earlier preview; those servers will not receive this version. Use a new id for new text.`,
    );
  const byGuild = new Map(records.map((record) => [record.guildId, record]));

  const entries: PreviewEntry[] = [];
  for (const guildId of guildIds) {
    const decision =
      recordDecision(byGuild.get(guildId), input.retryFailed) ??
      (await previewDecision(deps, guildId, botUserId));
    entries.push({ guildId, decision });
  }

  const unsigned: Omit<AnnouncementPreview, "sha256"> = {
    version: 1,
    createdAt: now.toISOString(),
    scope: input.scope,
    botUserId,
    retryFailed: input.retryFailed,
    announcement: input.announcement,
    embed,
    warnings,
    entries,
  };
  return { ...unsigned, sha256: previewDigest(unsigned) };
}
