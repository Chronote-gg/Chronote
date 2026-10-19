import { CONFIG_KEYS } from "../../config/keys";
import { getMockStore, resetMockStore } from "../../repositories/mockStore";
import {
  getConfigOverrideForScope,
  setConfigOverrideForScope,
} from "../configOverridesService";
import * as overridesService from "../configOverridesService";
import {
  fetchChannelContext,
  clearChannelContextSettings,
  setChannelContext,
} from "../channelContextService";
import {
  saveAutoRecordSetting,
  removeAutoRecordSetting,
  getAutoRecordSettingByChannel,
} from "../autorecordService";

const scope = {
  scope: "channel",
  guildId: "routing-guild",
  channelId: "voice",
} as const;
const params = {
  guildId: "routing-guild",
  channelId: "voice",
  enabled: true,
  recordAll: false,
  createdBy: "admin",
};
const route = async () =>
  (await getConfigOverrideForScope(scope, CONFIG_KEYS.notes.channelId))?.value;

beforeEach(async () => {
  resetMockStore();
  getMockStore().configOverrides.clear();
  await setChannelContext("routing-guild", "voice", "admin", {
    defaultNotesChannelId: "notes",
    context: "Keep this",
    liveVoiceEnabled: true,
    chatTtsEnabled: false,
  });
});
afterEach(() => jest.restoreAllMocks());

test("toggle_save_preserves_route when destination is omitted", async () => {
  const saved = await saveAutoRecordSetting(params);
  expect(saved).toMatchObject({ textChannelId: "notes", enabled: true });
  expect(await route()).toBe("notes");
  expect(
    await getAutoRecordSettingByChannel("routing-guild", "voice"),
  ).toMatchObject({ textChannelId: "notes", enabled: true });
});
test("explicit autorecord enable destination replaces the saved route", async () => {
  const read = jest.spyOn(overridesService, "getConfigOverrideForScope");
  const saved = await saveAutoRecordSetting({
    ...params,
    textChannelId: "other",
  });
  expect(saved.textChannelId).toBe("other");
  expect(read).not.toHaveBeenCalled();
  expect(await route()).toBe("other");
});
test("explicit null clears the route while omitted preserves it", async () => {
  const read = jest.spyOn(overridesService, "getConfigOverrideForScope");
  const saved = await saveAutoRecordSetting({ ...params, textChannelId: null });
  expect(saved.textChannelId).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(await route()).toBeUndefined();
});
test("auto-record removal retains the independently saved route", async () => {
  await saveAutoRecordSetting({
    ...params,
    textChannelId: "notes",
    tags: ["recap"],
  });
  const clear = jest.spyOn(overridesService, "clearConfigOverrideForScope");
  await removeAutoRecordSetting("routing-guild", "voice");
  expect(clear).not.toHaveBeenCalledWith(scope, CONFIG_KEYS.notes.channelId);
  expect(await route()).toBe("notes");
  expect(
    await getAutoRecordSettingByChannel("routing-guild", "voice"),
  ).toBeUndefined();
  expect(
    await getConfigOverrideForScope(scope, CONFIG_KEYS.notes.tags),
  ).toBeUndefined();
  expect(await fetchChannelContext("routing-guild", "voice")).toMatchObject({
    context: "Keep this",
    liveVoiceEnabled: true,
    chatTtsEnabled: false,
  });
});
test("delete-all-settings clears the independent route", async () => {
  await saveAutoRecordSetting(params);
  await removeAutoRecordSetting("routing-guild", "voice");
  await clearChannelContextSettings("routing-guild", "voice");
  expect(await route()).toBeUndefined();
  expect(await fetchChannelContext("routing-guild", "voice")).toBeUndefined();
});
test.each([undefined, null])(
  "server-scope omission or null keeps its existing semantics: %s",
  async (textChannelId) => {
    const serverScope = { scope: "server", guildId: "routing-guild" } as const;
    await setConfigOverrideForScope(
      serverScope,
      CONFIG_KEYS.notes.channelId,
      "server-notes",
      "admin",
    );
    const saved = await saveAutoRecordSetting({
      ...params,
      channelId: "ALL",
      recordAll: true,
      textChannelId,
    });
    expect(saved.textChannelId).toBe("server-notes");
    expect(
      (
        await getConfigOverrideForScope(
          serverScope,
          CONFIG_KEYS.notes.channelId,
        )
      )?.value,
    ).toBe("server-notes");
    await removeAutoRecordSetting("routing-guild", "ALL");
    expect(
      (
        await getConfigOverrideForScope(
          serverScope,
          CONFIG_KEYS.notes.channelId,
        )
      )?.value,
    ).toBe("server-notes");
  },
);

test("reset_only_clears_notes_override and preserves context, tags, live voice and TTS", async () => {
  await saveAutoRecordSetting({ ...params, tags: ["recap"] });
  await setChannelContext("routing-guild", "voice", "admin", {
    defaultNotesChannelId: null,
  });
  expect(await route()).toBeUndefined();
  expect(await fetchChannelContext("routing-guild", "voice")).toMatchObject({
    context: "Keep this",
    liveVoiceEnabled: true,
    chatTtsEnabled: false,
  });
  expect(
    await getAutoRecordSettingByChannel("routing-guild", "voice"),
  ).toMatchObject({ enabled: true, tags: ["recap"] });
});
