/** @jest-environment node */
import {
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  handleOnboardButtonInteraction,
  handleOnboardChannelSelect,
  handleOnboardCommand,
  handleOnboardModalSubmit,
  isOnboardButton,
  isOnboardChannelSelect,
  isOnboardModal,
} from "../../src/commands/onboard";
import { saveAutoRecordSetting } from "../../src/services/autorecordService";
import { setConfigOverrideForScope } from "../../src/services/configOverridesService";
import { saveGuildInstallerForMembership } from "../../src/services/guildInstallerService";
import {
  removeOnboardingState,
  saveOnboardingState,
} from "../../src/services/onboardingService";
import { captureEvent } from "../../src/services/analyticsService";

jest.mock("../../src/services/configService", () => ({
  config: { frontend: { siteUrl: "https://chronote.test/" }, stripe: {} },
}));
jest.mock("../../src/services/autorecordService", () => ({
  saveAutoRecordSetting: jest.fn(),
}));
jest.mock("../../src/services/configOverridesService", () => ({
  setConfigOverrideForScope: jest.fn(),
}));
jest.mock("../../src/services/guildInstallerService", () => ({
  saveGuildInstallerForMembership: jest.fn(),
  fetchGuildInstallerForMembership: jest.fn(),
}));
jest.mock("../../src/services/onboardingService", () => ({
  fetchOnboardingState: jest.fn(),
  removeOnboardingState: jest.fn(),
  saveOnboardingState: jest.fn(),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

const fixture = (customId = "") => ({
  guild: { id: "guild-1", joinedTimestamp: Date.parse("2026-09-05T10:00:00Z") },
  guildId: "guild-1",
  memberPermissions: { has: () => false },
  user: { id: "former-installer" },
  customId,
  commandName: "onboard",
  reply: jest.fn(),
});

function expectRetirement(reply: jest.Mock) {
  const payload = reply.mock.calls[0][0];
  expect(payload.content).toBe("Setup is now in the portal.");
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.components[0].toJSON().components).toEqual([
    expect.objectContaining({
      label: "Open portal",
      style: 5,
      url: "https://chronote.test/portal/meetings?scope=guild&serverId=guild-1",
    }),
  ]);
  expect(saveAutoRecordSetting).not.toHaveBeenCalled();
  expect(setConfigOverrideForScope).not.toHaveBeenCalled();
  expect(saveGuildInstallerForMembership).not.toHaveBeenCalled();
  expect(saveOnboardingState).not.toHaveBeenCalled();
  expect(removeOnboardingState).not.toHaveBeenCalled();
  expect(captureEvent).not.toHaveBeenCalled();
}

test("legacy_controls_are_read_only: a former installer receives the retirement notice for a cached slash command", async () => {
  const interaction = fixture();
  await handleOnboardCommand(
    interaction as unknown as ChatInputCommandInteraction,
  );
  expectRetirement(interaction.reply);
});

test.each([
  "onboard_ctx_modal",
  "onboard_auto_off",
  "onboard_auto_one",
  "onboard_auto_all",
  "onboard_skip_autorecord",
  "onboard_skip_tour",
  "onboard_next_upgrade",
  "onboard_skip_upgrade",
])("legacy_controls_are_read_only: button %s", async (id) => {
  expect(isOnboardButton(id)).toBe(true);
  const interaction = fixture(id);
  await handleOnboardButtonInteraction(
    interaction as unknown as ButtonInteraction,
  );
  expectRetirement(interaction.reply);
});

test("legacy_controls_are_read_only: an open context modal cannot change settings", async () => {
  expect(isOnboardModal("onboard_context_modal")).toBe(true);
  const interaction = fixture("onboard_context_modal");
  await handleOnboardModalSubmit(
    interaction as unknown as ModalSubmitInteraction,
  );
  expectRetirement(interaction.reply);
});

test.each(["onboard_voice", "onboard_text"])(
  "legacy_controls_are_read_only: channel selector %s",
  async (id) => {
    expect(isOnboardChannelSelect(id)).toBe(true);
    const interaction = fixture(id);
    await handleOnboardChannelSelect(
      interaction as unknown as ChannelSelectMenuInteraction,
    );
    expectRetirement(interaction.reply);
  },
);
