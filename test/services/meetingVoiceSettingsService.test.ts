import { CONFIG_KEYS } from "../../src/config/keys";
import { resolveMeetingVoiceSettings } from "../../src/services/meetingVoiceSettingsService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { setConfigOverrideForScope } from "../../src/services/configOverridesService";

describe("meetingVoiceSettingsService", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("uses channel overrides for chat-to-speech", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.liveVoice.enabled,
      true,
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.liveVoice.commandsEnabled,
      true,
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.chatTts.enabled,
      false,
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.liveVoice.ttsVoice,
      "alloy",
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.chatTts.voice,
      "nova",
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "channel", guildId: "guild-1", channelId: "voice-1" },
      CONFIG_KEYS.chatTts.enabled,
      true,
      "user-1",
    );

    const settings = await resolveMeetingVoiceSettings("guild-1", "voice-1", {
      liveVoiceEnabled: true,
      imagesEnabled: true,
    });

    expect(settings.chatTtsEnabled).toBe(true);
    expect(settings.liveVoiceEnabled).toBe(true);
    expect(settings.liveVoiceCommandsEnabled).toBe(true);
    expect(settings.chatTtsVoice).toBe("nova");
    expect(settings.liveVoiceTtsVoice).toBe("alloy");
  });

  it("keeps chat-to-speech available when the tier has no live voice", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-2" },
      CONFIG_KEYS.liveVoice.commandsEnabled,
      true,
      "user-2",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-2" },
      CONFIG_KEYS.chatTts.enabled,
      true,
      "user-2",
    );

    const settings = await resolveMeetingVoiceSettings("guild-2", "voice-2", {
      liveVoiceEnabled: false,
      imagesEnabled: false,
    });

    expect(settings.chatTtsEnabled).toBe(true);
    expect(settings.liveVoiceEnabled).toBe(false);
    expect(settings.liveVoiceCommandsEnabled).toBe(false);
  });

  it("disables chat-to-speech when the tier allows no monthly messages", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-3" },
      CONFIG_KEYS.chatTts.enabled,
      true,
      "user-3",
    );

    const settings = await resolveMeetingVoiceSettings("guild-3", "voice-3", {
      liveVoiceEnabled: false,
      imagesEnabled: false,
      maxChatTtsMessagesMonthly: 0,
    });

    expect(settings.chatTtsEnabled).toBe(false);
  });
});
