import {
  buildChannelOverrides,
  formatChannelLabel,
  resolveDefaultNotesChannelId,
} from "../settingsChannels";

describe("settingsChannels utils", () => {
  it("formats channel labels based on access", () => {
    expect(
      formatChannelLabel({
        value: "1",
        label: "General",
        botAccess: true,
        missingPermissions: [],
      }),
    ).toBe("General");
    expect(
      formatChannelLabel({
        value: "1",
        label: "General",
        botAccess: false,
        missingPermissions: ["CONNECT"],
      }),
    ).toBe("General (bot access needed)");
  });

  it("builds overrides merged from rules and contexts and sorts", () => {
    const overrides = buildChannelOverrides({
      channelRules: [
        {
          channelId: "b",
          enabled: true,
          guildId: "g1",
          recordAll: false,
          createdBy: "u1",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
        {
          channelId: "a",
          enabled: false,
          textChannelId: "t1",
          tags: ["x"],
          guildId: "g1",
          recordAll: false,
          createdBy: "u1",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      channelContexts: [
        {
          channelId: "b",
          context: "ctx-b",
          guildId: "g1",
          updatedAt: "2025-01-01T00:00:00.000Z",
          updatedBy: "u1",
        },
        {
          channelId: "c",
          context: "ctx-c",
          defaultNotesChannelId: "t2",
          chatTtsEnabled: true,
          chatTtsTtsOnlyEnabled: true,
          guildId: "g1",
          updatedAt: "2025-01-01T00:00:00.000Z",
          updatedBy: "u1",
        },
      ],
      voiceChannelMap: new Map([
        ["a", "Alpha"],
        ["b", "Beta"],
        ["c", "Gamma"],
      ]),
      textChannelMap: new Map([
        ["t1", "Notes"],
        ["t2", "TTS Status"],
      ]),
      defaultNotesChannelId: "t1",
    });
    expect(overrides.map((o) => o.channelId)).toEqual(["a", "b", "c"]);
    const a = overrides[0];
    expect(a.voiceLabel).toBe("Alpha");
    expect(a.textLabel).toBe("Notes");
    expect(a.autoRecordEnabled).toBe(false);
    expect(a.tags).toEqual(["x"]);
    const b = overrides[1];
    expect(b.context).toBe("ctx-b");
    const c = overrides[2];
    expect(c.textLabel).toBe("TTS Status");
    expect(c.textChannelId).toBe("t2");
    expect(c.chatTtsTtsOnlyEnabled).toBe(true);
  });

  it("resolves default notes channel from context or record-all rule", () => {
    expect(
      resolveDefaultNotesChannelId({
        contextData: { defaultNotesChannelId: "ctx" },
        recordAllRule: {
          channelId: "1",
          enabled: true,
          textChannelId: "rule",
          guildId: "g1",
          recordAll: true,
          createdBy: "u1",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    ).toBe("ctx");
    expect(
      resolveDefaultNotesChannelId({
        contextData: null,
        recordAllRule: {
          channelId: "1",
          enabled: true,
          textChannelId: "rule",
          guildId: "g1",
          recordAll: true,
          createdBy: "u1",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    ).toBe("rule");
  });
});
