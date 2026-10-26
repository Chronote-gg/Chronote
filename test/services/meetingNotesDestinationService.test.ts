/** @jest-environment node */
import {
  ChannelType,
  Client,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import { mockNotesDestinations } from "../fixtures/notesDestinationConfig";
import { getGlobalConfigValues } from "../../src/services/appConfigService";
import { listConfigOverridesForScope } from "../../src/services/configOverridesService";
import {
  assertMemberCanAccessNotesChannel,
  resolveMeetingNotesChannel,
} from "../../src/services/meetingNotesDestinationService";

const client = new Client({ intents: [] });
const guild: Guild = Reflect.construct(Guild, [client, { id: "guild-1" }]);
const destination: TextChannel = Reflect.construct(TextChannel, [
  guild,
  { id: "notes-1", name: "private-notes", type: ChannelType.GuildText },
  guild.client,
]);
const member: GuildMember = Reflect.construct(GuildMember, [
  client,
  { user: { id: "user-1", username: "Starter" }, roles: [] },
  guild,
]);
const invocationChannelId = "invocation-1";
let serverDestination: string | undefined;
let voiceDestination: string | undefined;
let fetchChannel: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  serverDestination = undefined;
  voiceDestination = undefined;
  mockNotesDestinations((scope) =>
    scope === "channel" ? voiceDestination : serverDestination,
  );
  fetchChannel = jest
    .spyOn(guild.channels, "fetch")
    .mockResolvedValue(destination);
});

const resolve = (explicitChannelId?: string) =>
  resolveMeetingNotesChannel({
    guild,
    voiceChannelId: "voice-1",
    invocationChannelId,
    explicitChannelId,
  });

test("explicit_destination_wins", async () => {
  serverDestination = "server-notes";
  voiceDestination = "voice-notes";
  const resolved = await resolve("notes-1");
  expect(resolved.id).toBe("notes-1");
  expect(fetchChannel).toHaveBeenCalledWith("notes-1");
  expect(getGlobalConfigValues).not.toHaveBeenCalled();
  expect(listConfigOverridesForScope).not.toHaveBeenCalled();
});

test("voice_override_wins", async () => {
  serverDestination = "server-notes";
  voiceDestination = "notes-1";
  const resolved = await resolve();
  expect(resolved.id).toBe("notes-1");
  expect(fetchChannel).toHaveBeenCalledWith("notes-1");
  expect(fetchChannel).not.toHaveBeenCalledWith(invocationChannelId);
});

test("server_default_wins", async () => {
  serverDestination = " notes-1 ";
  const resolved = await resolve();
  expect(resolved.id).toBe("notes-1");
  expect(fetchChannel).toHaveBeenCalledWith("notes-1");
  expect(fetchChannel).not.toHaveBeenCalledWith(invocationChannelId);
});

test.each([undefined, "   "])(
  "unconfigured_manual_uses_invocation (%s)",
  async (value) => {
    serverDestination = value;
    fetchChannel.mockResolvedValue(
      Reflect.construct(TextChannel, [
        guild,
        { id: invocationChannelId, type: ChannelType.GuildText },
        guild.client,
      ]),
    );
    const resolved = await resolve();
    expect(resolved.id).toBe(invocationChannelId);
  },
);

test("unconfigured_remote_or_auto_blocks", async () => {
  await expect(
    resolveMeetingNotesChannel({ guild, voiceChannelId: "voice-1" }),
  ).rejects.toThrow();
  expect(fetchChannel).not.toHaveBeenCalled();
});

test.each(["explicit", "configured"])(
  "unavailable_destination_never_falls_through (%s)",
  async (selection) => {
    serverDestination = "notes-1";
    fetchChannel.mockResolvedValue(null);
    await expect(
      resolve(selection === "explicit" ? "missing-1" : undefined),
    ).rejects.toThrow();
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).not.toHaveBeenCalledWith(invocationChannelId);
  },
);

test("a fetch failure blocks without exposing the destination name", async () => {
  serverDestination = "notes-1";
  fetchChannel.mockRejectedValue(new Error("private-notes cannot be fetched"));
  await expect(resolve()).rejects.not.toThrow("private-notes");
  expect(fetchChannel).not.toHaveBeenCalledWith(invocationChannelId);
});

test.each([ChannelType.PublicThread, ChannelType.GuildForum, ChannelType.DM])(
  "rejects non-text destination type %s",
  async (type) => {
    fetchChannel.mockResolvedValue({ id: "notes-1", guild, type });
    await expect(resolve("notes-1")).rejects.toThrow();
    expect(fetchChannel).not.toHaveBeenCalledWith(invocationChannelId);
  },
);

test("rejects a destination in another guild", async () => {
  const otherGuild: Guild = Reflect.construct(Guild, [
    client,
    { id: "guild-2" },
  ]);
  fetchChannel.mockResolvedValue(
    Reflect.construct(TextChannel, [
      otherGuild,
      { id: "notes-1", type: ChannelType.GuildText },
      otherGuild.client,
    ]),
  );
  await expect(resolve("notes-1")).rejects.toThrow();
});

test.each(["global", "overrides"])(
  "a failed %s config read never uses the invocation channel",
  async (provider) => {
    if (provider === "global")
      jest
        .mocked(getGlobalConfigValues)
        .mockRejectedValue(new Error("private-notes config failure"));
    else
      jest
        .mocked(listConfigOverridesForScope)
        .mockRejectedValue(new Error("private-notes config failure"));
    await expect(resolve()).rejects.not.toThrow("private-notes");
    expect(fetchChannel).not.toHaveBeenCalled();
    if (provider === "global")
      expect(getGlobalConfigValues).toHaveBeenCalledWith({ strict: true });
  },
);

test("starter_access_does_not_require_admin", () => {
  jest
    .spyOn(destination, "permissionsFor")
    .mockReturnValue(
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
    );
  expect(() =>
    assertMemberCanAccessNotesChannel(member, destination),
  ).not.toThrow();
});

test.each([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
])("starter access requires permission %s", (missing) => {
  jest
    .spyOn(destination, "permissionsFor")
    .mockReturnValue(
      new PermissionsBitField(
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ].filter((permission) => permission !== missing),
      ),
    );
  expect(() =>
    assertMemberCanAccessNotesChannel(member, destination),
  ).toThrow();
});

test("permission-provider failure does not expose the hidden channel name", () => {
  jest.spyOn(destination, "permissionsFor").mockImplementation(() => {
    throw new Error("private-notes permission failure");
  });
  expect(() =>
    assertMemberCanAccessNotesChannel(member, destination),
  ).toThrow();
  expect(() =>
    assertMemberCanAccessNotesChannel(member, destination),
  ).not.toThrow("private-notes");
});

test("missing starter permissions block access", () => {
  jest.spyOn(destination, "permissionsFor").mockReturnValue(null);
  expect(() =>
    assertMemberCanAccessNotesChannel(member, destination),
  ).toThrow();
});
