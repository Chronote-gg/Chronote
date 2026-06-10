import { jest } from "@jest/globals";
import { CONFIG_KEYS } from "../../config/keys";
import {
  clearChannelContext,
  clearChannelContextSettings,
} from "../channelContextService";
import { clearConfigOverrideForScope } from "../configOverridesService";

jest.mock("../configOverridesService", () => ({
  buildScopePrefix: jest.fn(),
  clearConfigOverrideForScope: jest.fn(async () => undefined),
  listConfigOverridesForScope: jest.fn(async () => []),
  listConfigOverridesForScopePrefix: jest.fn(async () => []),
  setConfigOverrideForScope: jest.fn(async () => undefined),
}));

describe("channelContextService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clears only prompt context for /context clear-channel", async () => {
    await clearChannelContext("guild-1", "voice-1");

    expect(clearConfigOverrideForScope).toHaveBeenCalledTimes(1);
    expect(clearConfigOverrideForScope).toHaveBeenCalledWith(
      { scope: "channel", guildId: "guild-1", channelId: "voice-1" },
      CONFIG_KEYS.context.instructions,
    );
  });

  it("can clear all channel settings for the settings UI remove action", async () => {
    await clearChannelContextSettings("guild-1", "voice-1");

    expect(clearConfigOverrideForScope).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG_KEYS.context.instructions,
    );
    expect(clearConfigOverrideForScope).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG_KEYS.notes.channelId,
    );
    expect(clearConfigOverrideForScope).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG_KEYS.chatTts.ttsOnlyEnabled,
    );
  });
});
