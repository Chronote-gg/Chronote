import { CONFIG_KEYS } from "../../src/config/keys";
import {
  resolveGlobalConfigValues,
  resolveConfigSnapshot,
} from "../../src/services/unifiedConfigService";
import { getChronoteDemo } from "../../src/services/chronoteDemo";
import * as appConfigService from "../../src/services/appConfigService";
import { resolveModelChoicesByRole } from "../../src/services/modelChoiceService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { setConfigOverrideForScope } from "../../src/services/configOverridesService";

describe("unifiedConfigService", () => {
  beforeEach(() => {
    resetMockStore();
  });

  test("allows premium transcription when experimental is off", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.transcription.premiumEnabled,
      true,
      "user-1",
    );
    const snapshot = await resolveConfigSnapshot({
      guildId: "guild-1",
      tier: "pro",
    });
    const premium = snapshot.values[CONFIG_KEYS.transcription.premiumEnabled];
    expect(premium.value).toBe(true);
    expect(premium.gated).toBeFalsy();
  });

  test("enables premium transcription for pro with experimental on", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.features.experimental,
      true,
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.transcription.premiumEnabled,
      true,
      "user-1",
    );
    const snapshot = await resolveConfigSnapshot({
      guildId: "guild-1",
      tier: "pro",
    });
    const premium = snapshot.values[CONFIG_KEYS.transcription.premiumEnabled];
    expect(premium.value).toBe(true);
    expect(premium.gated).toBeFalsy();
  });

  test("allows premium transcription for non-pro tiers", async () => {
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.features.experimental,
      true,
      "user-1",
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      CONFIG_KEYS.transcription.premiumEnabled,
      true,
      "user-1",
    );
    const snapshot = await resolveConfigSnapshot({
      guildId: "guild-1",
      tier: "basic",
    });
    const premium = snapshot.values[CONFIG_KEYS.transcription.premiumEnabled];
    expect(premium.value).toBe(true);
    expect(premium.gated).toBeFalsy();
  });

  test("keeps the demo binding out of meeting and server snapshots", async () => {
    const demo = {
      guildId: "200000000000000010",
      voiceChannelId: "200000000000000011",
      outputChannelId: "200000000000000012",
    };
    const readConfig = jest
      .spyOn(appConfigService, "getGlobalConfigValues")
      .mockResolvedValue({ [CONFIG_KEYS.demo.channels]: JSON.stringify(demo) });
    try {
      await expect(getChronoteDemo()).resolves.toEqual(demo);
      const snapshot = await resolveConfigSnapshot({ guildId: "guild-1" });
      expect(snapshot.values[CONFIG_KEYS.demo.channels]).toBeUndefined();
    } finally {
      readConfig.mockRestore();
    }
  });

  test("a retired transcription model stored anywhere resolves to the default", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(appConfigService, "getGlobalConfigValues").mockResolvedValue({
      "models.transcription": "gpt-4o-mini-transcribe",
    });
    expect(await resolveGlobalConfigValues()).toContainEqual(
      expect.objectContaining({ value: "gpt-transcribe" }),
    );
    await setConfigOverrideForScope(
      { scope: "server", guildId: "guild-1" },
      "models.transcription",
      "gpt-4o-transcribe",
      "user-1",
    );
    const snapshot = await resolveConfigSnapshot({ guildId: "guild-1" });
    expect(resolveModelChoicesByRole(snapshot).transcription).toBe(
      "gpt-transcribe",
    );
    expect(console.warn).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });
});
