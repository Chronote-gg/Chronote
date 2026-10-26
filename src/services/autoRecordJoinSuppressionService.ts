import { getDeploymentControlRepository } from "../db";
import type {
  SuppressionRecord,
  WorkAdmissionAuthority,
} from "../types/deploymentControl";
import { getRuntimeAdmissionContext } from "./runtimeLifecycleService";

export type AutoRecordJoinSuppressionReason =
  "explicit_end" | "forced_disconnect";

type ChannelKey = string;

const buildChannelKey = (guildId: string, channelId: string): ChannelKey =>
  `${guildId}#${channelId}`;

export class AutoRecordJoinSuppressionService {
  constructor(private readonly authority?: WorkAdmissionAuthority) {}

  async read(
    guildId: string,
    channelId: string,
  ): Promise<SuppressionRecord | undefined> {
    const row = await getDeploymentControlRepository().getRecord(
      `SUPPRESS#${guildId}`,
      `CHANNEL#${channelId}`,
    );
    if (row && row.recordType !== "suppression")
      throw new Error("Invalid suppression record");
    return row;
  }
  private suppressedChannels = new Map<
    ChannelKey,
    { reason: AutoRecordJoinSuppressionReason; createdAt: string }
  >();

  private nonBotMemberIdsByChannel = new Map<ChannelKey, Set<string>>();

  async shouldSuppressAutoJoin(
    guildId: string,
    channelId: string,
  ): Promise<boolean> {
    return Boolean((await this.read(guildId, channelId))?.suppressed);
  }

  async suppressUntilEmpty(options: {
    guildId: string;
    channelId: string;
    nonBotMemberIds: string[];
    reason: AutoRecordJoinSuppressionReason;
    meetingId: string;
    authority?: WorkAdmissionAuthority;
  }): Promise<boolean> {
    const key = buildChannelKey(options.guildId, options.channelId);

    const members = new Set(
      options.nonBotMemberIds.filter((memberId) => memberId.trim().length > 0),
    );
    if (members.size === 0) return false;

    const authority = options.authority ??
      this.authority ?? {
        kind: "serving",
        context: await getRuntimeAdmissionContext(),
      };
    let persisted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await this.read(options.guildId, options.channelId);
      const record: SuppressionRecord = {
        pk: `SUPPRESS#${options.guildId}`,
        sk: `CHANNEL#${options.channelId}`,
        recordType: "suppression",
        protocolVersion: 1,
        guildId: options.guildId,
        channelId: options.channelId,
        meetingId: options.meetingId,
        createdAt: Math.floor(Date.now() / 1000),
        reason: options.reason,
        suppressed: true,
        version: (previous?.version ?? 0) + 1,
      };
      if (
        (await getDeploymentControlRepository().writeSuppression({
          record,
          expectedVersion: previous?.version,
          authority,
        })) === "applied"
      ) {
        persisted = true;
        break;
      }
    }
    if (!persisted)
      throw new Error("Could not persist auto-record suppression");

    this.suppressedChannels.set(key, {
      reason: options.reason,
      createdAt: new Date().toISOString(),
    });
    this.nonBotMemberIdsByChannel.set(key, members);
    return true;
  }

  async handleVoiceStateChange(options: {
    guildId: string;
    userId: string;
    isBot: boolean;
    oldChannelId?: string | null;
    newChannelId?: string | null;
  }): Promise<{
    clearedSuppression: boolean;
    clearedSuppressionInfo?: {
      reason: AutoRecordJoinSuppressionReason;
      createdAt: string;
    };
  }> {
    if (options.isBot) {
      return { clearedSuppression: false };
    }
    if (options.oldChannelId === options.newChannelId) {
      return { clearedSuppression: false };
    }

    let clearedSuppression = false;
    let clearedSuppressionInfo:
      | {
          reason: AutoRecordJoinSuppressionReason;
          createdAt: string;
        }
      | undefined;

    if (options.oldChannelId) {
      const oldKey = buildChannelKey(options.guildId, options.oldChannelId);
      const members = this.nonBotMemberIdsByChannel.get(oldKey);
      if (members) {
        members.delete(options.userId);
        const suppressionInfo = this.suppressedChannels.get(oldKey);
        if (members.size === 0 && suppressionInfo) {
          if (
            !(await this.clearIfEmpty({
              guildId: options.guildId,
              channelId: options.oldChannelId,
              nonBotMemberIds: () => [...members],
            }))
          )
            return { clearedSuppression: false };
          this.suppressedChannels.delete(oldKey);
          this.nonBotMemberIdsByChannel.delete(oldKey);
          clearedSuppression = true;
          clearedSuppressionInfo = suppressionInfo;
        }
      }
    }

    if (options.newChannelId) {
      const newKey = buildChannelKey(options.guildId, options.newChannelId);
      const members = this.nonBotMemberIdsByChannel.get(newKey);
      if (members) {
        members.add(options.userId);
      }
    }

    return { clearedSuppression, clearedSuppressionInfo };
  }

  async clearIfEmpty(options: {
    guildId: string;
    channelId: string;
    nonBotMemberIds: () => string[];
    authority?: WorkAdmissionAuthority;
  }): Promise<boolean> {
    const authority = options.authority ??
      this.authority ?? {
        kind: "serving",
        context: await getRuntimeAdmissionContext(),
      };
    const previous = await this.read(options.guildId, options.channelId);
    if (!previous?.suppressed || options.nonBotMemberIds().length) return false;
    return (
      (await getDeploymentControlRepository().writeSuppression({
        record: {
          ...previous,
          suppressed: false,
          version: previous.version + 1,
        },
        expectedVersion: previous.version,
        authority,
      })) === "applied"
    );
  }
}

export const autoRecordJoinSuppressionService =
  new AutoRecordJoinSuppressionService();
