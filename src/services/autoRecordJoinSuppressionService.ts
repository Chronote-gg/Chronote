export type AutoRecordJoinSuppressionReason =
  | "explicit_end"
  | "forced_disconnect";

type ChannelKey = string;

const buildChannelKey = (guildId: string, channelId: string): ChannelKey =>
  `${guildId}#${channelId}`;

export class AutoRecordJoinSuppressionService {
  private suppressedChannels = new Map<
    ChannelKey,
    { reason: AutoRecordJoinSuppressionReason; createdAt: string }
  >();

  private nonBotMemberIdsByChannel = new Map<ChannelKey, Set<string>>();

  shouldSuppressAutoJoin(guildId: string, channelId: string): boolean {
    return this.suppressedChannels.has(buildChannelKey(guildId, channelId));
  }

  suppressUntilEmpty(options: {
    guildId: string;
    channelId: string;
    nonBotMemberIds: string[];
    reason: AutoRecordJoinSuppressionReason;
  }): boolean {
    const key = buildChannelKey(options.guildId, options.channelId);
    if (this.suppressedChannels.has(key)) return false;

    const members = new Set(
      options.nonBotMemberIds.filter((memberId) => memberId.trim().length > 0),
    );
    if (members.size === 0) return false;

    this.suppressedChannels.set(key, {
      reason: options.reason,
      createdAt: new Date().toISOString(),
    });
    this.nonBotMemberIdsByChannel.set(key, members);
    return true;
  }

  handleVoiceStateChange(options: {
    guildId: string;
    userId: string;
    isBot: boolean;
    oldChannelId?: string | null;
    newChannelId?: string | null;
  }): {
    clearedSuppression: boolean;
  } {
    if (options.isBot) {
      return { clearedSuppression: false };
    }
    if (options.oldChannelId === options.newChannelId) {
      return { clearedSuppression: false };
    }

    let clearedSuppression = false;

    if (options.oldChannelId) {
      const oldKey = buildChannelKey(options.guildId, options.oldChannelId);
      const members = this.nonBotMemberIdsByChannel.get(oldKey);
      if (members) {
        members.delete(options.userId);
        if (members.size === 0 && this.suppressedChannels.has(oldKey)) {
          this.suppressedChannels.delete(oldKey);
          this.nonBotMemberIdsByChannel.delete(oldKey);
          clearedSuppression = true;
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

    return { clearedSuppression };
  }
}

export const autoRecordJoinSuppressionService =
  new AutoRecordJoinSuppressionService();
