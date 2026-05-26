import {
  type GuildMember,
  type PermissionResolvable,
  PermissionsBitField,
  type TextChannel,
  type VoiceBasedChannel,
} from "discord.js";
import {
  buildAutoRecordPermissionChannelMessage,
  buildAutoRecordPermissionDmMessage,
  canBotSendMessages,
  checkBotPermissions,
  formatMissingPermissions,
  getMissingMeetingTextChannelPermissions,
} from "../permissions";

const member = {} as GuildMember;

const buildPermissions = (...flags: PermissionResolvable[]) =>
  new PermissionsBitField(flags);

const buildVoiceChannel = (
  permissions: PermissionsBitField | null,
): VoiceBasedChannel =>
  ({
    name: "voice",
    permissionsFor: jest.fn(() => permissions),
  }) as unknown as VoiceBasedChannel;

const buildTextChannel = (
  permissions: PermissionsBitField | null,
): TextChannel =>
  ({
    name: "notes",
    permissionsFor: jest.fn(() => permissions),
  }) as unknown as TextChannel;

describe("permissions", () => {
  it("accepts the full autorecord permission set", () => {
    const voiceChannel = buildVoiceChannel(
      buildPermissions(
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
      ),
    );
    const textChannel = buildTextChannel(
      buildPermissions(
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.EmbedLinks,
      ),
    );

    expect(checkBotPermissions(voiceChannel, textChannel, member)).toEqual({
      success: true,
    });
  });

  it("reports text permissions needed for meeting message updates", () => {
    const missing = getMissingMeetingTextChannelPermissions(
      buildTextChannel(
        buildPermissions(
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ),
      ),
      member,
    );

    expect(missing).toEqual(["Read Message History", "Embed Links"]);
  });

  it("allows plain channel warnings when only rich message permissions are missing", () => {
    const textChannel = buildTextChannel(
      buildPermissions(
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
      ),
    );

    expect(canBotSendMessages(textChannel, member)).toBe(true);
  });

  it("includes the missing permissions in failure messages", () => {
    const result = checkBotPermissions(
      buildVoiceChannel(
        buildPermissions(
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
        ),
      ),
      buildTextChannel(buildPermissions(PermissionsBitField.Flags.ViewChannel)),
      member,
    );

    expect(result).toEqual({
      success: false,
      errorMessage:
        "I am missing **Send Messages**, **Read Message History**, **Embed Links** in **notes**.",
    });
  });

  it("formats permission names for Discord messages", () => {
    expect(formatMissingPermissions(["Read Message History"])).toBe(
      "**Read Message History**",
    );
  });

  it("builds a channel warning with scoped missing permissions", () => {
    expect(
      buildAutoRecordPermissionChannelMessage({
        voiceChannelName: "voice",
        textChannelName: "notes",
        missingVoicePermissions: ["Connect"],
        missingTextPermissions: ["Read Message History", "Embed Links"],
      }),
    ).toBe(
      "Cannot start auto-recording because Chronote is missing permissions in voice channel **voice**: **Connect**; notes channel **notes**: **Read Message History**, **Embed Links**.",
    );
  });

  it("produces a coherent message when both permission arrays are unexpectedly empty", () => {
    const message = buildAutoRecordPermissionChannelMessage({
      voiceChannelName: "voice",
      textChannelName: "notes",
      missingVoicePermissions: [],
      missingTextPermissions: [],
    });

    expect(message).toBe(
      "Cannot start auto-recording because Chronote is missing permissions in one or more channels (permissions may have just been updated).",
    );
  });

  it("asks non-admin trigger users to contact an admin", () => {
    expect(
      buildAutoRecordPermissionDmMessage({
        isAdmin: false,
        voiceChannelName: "voice",
        textChannelName: "notes",
        missingVoicePermissions: [],
        missingTextPermissions: ["Send Messages"],
      }),
    ).toContain("please ask an admin");
  });

  it("gives admins the exact missing permission summary", () => {
    expect(
      buildAutoRecordPermissionDmMessage({
        isAdmin: true,
        voiceChannelName: "voice",
        textChannelName: "notes",
        missingVoicePermissions: [],
        missingTextPermissions: ["Send Messages"],
      }),
    ).toBe(
      "Cannot start auto-recording because Chronote is missing permissions in notes channel **notes**: **Send Messages**. Grant those permissions, then have everyone leave and rejoin the voice channel to trigger auto-record again.",
    );
  });
});
