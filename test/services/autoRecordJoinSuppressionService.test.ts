import { AutoRecordJoinSuppressionService } from "../../src/services/autoRecordJoinSuppressionService";

describe("AutoRecordJoinSuppressionService", () => {
  test("suppresses auto-join until channel empties", () => {
    const svc = new AutoRecordJoinSuppressionService();
    expect(
      svc.suppressUntilEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: ["u1", "u2"],
        reason: "explicit_end",
      }),
    ).toBe(true);
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    const result = svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(result.clearedSuppression).toBe(true);
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });

  test("does not suppress when no non-bot members are present", () => {
    const svc = new AutoRecordJoinSuppressionService();
    expect(
      svc.suppressUntilEmpty({
        guildId: "g1",
        channelId: "c1",
        nonBotMemberIds: [],
        reason: "explicit_end",
      }),
    ).toBe(false);
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });

  test("ignores bot voice state changes", () => {
    const svc = new AutoRecordJoinSuppressionService();
    svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "forced_disconnect",
    });

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "bot-1",
      isBot: true,
      oldChannelId: "c1",
      newChannelId: null,
    });

    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);
  });

  test("tracks member moves between channels for suppressed channels", () => {
    const svc = new AutoRecordJoinSuppressionService();
    svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "explicit_end",
    });
    svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c2",
      nonBotMemberIds: ["u2"],
      reason: "explicit_end",
    });

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: "c2",
    });

    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
    expect(svc.shouldSuppressAutoJoin("g1", "c2")).toBe(true);

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c2",
      newChannelId: null,
    });
    expect(svc.shouldSuppressAutoJoin("g1", "c2")).toBe(true);

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c2",
      newChannelId: null,
    });
    expect(svc.shouldSuppressAutoJoin("g1", "c2")).toBe(false);
  });

  test("tracks members who join after suppression begins", () => {
    const svc = new AutoRecordJoinSuppressionService();
    svc.suppressUntilEmpty({
      guildId: "g1",
      channelId: "c1",
      nonBotMemberIds: ["u1"],
      reason: "explicit_end",
    });

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: null,
      newChannelId: "c1",
    });

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u1",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(true);

    svc.handleVoiceStateChange({
      guildId: "g1",
      userId: "u2",
      isBot: false,
      oldChannelId: "c1",
      newChannelId: null,
    });
    expect(svc.shouldSuppressAutoJoin("g1", "c1")).toBe(false);
  });
});
