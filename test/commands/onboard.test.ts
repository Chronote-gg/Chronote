import type { ChatInputCommandInteraction } from "discord.js";
import { handleOnboardCommand } from "../../src/commands/onboard";
import { resetMockStore } from "../../src/repositories/mockStore";
import { saveGuildInstallerIfAbsent } from "../../src/services/guildInstallerService";

beforeEach(() => resetMockStore());

test("a former installer cannot bypass Manage Guild after an offline reinstall", async () => {
  const guildId = "guild-1";
  await saveGuildInstallerIfAbsent({
    guildId,
    installerId: "former-installer",
    installedAt: "2026-09-01T10:00:00.000Z",
  });
  const reply = jest.fn();
  const interaction = {
    guild: {
      id: guildId,
      joinedTimestamp: Date.parse("2026-09-05T10:00:00.000Z"),
    },
    memberPermissions: { has: () => false },
    user: { id: "former-installer" },
    reply,
  } as unknown as ChatInputCommandInteraction;

  await handleOnboardCommand(interaction);

  expect(reply).toHaveBeenCalledWith({
    content: "You need Manage Guild permission to run onboarding.",
    ephemeral: true,
  });
});
