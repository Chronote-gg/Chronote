import {
  ButtonStyle,
  ComponentType,
  type BaseMessageOptions,
} from "discord.js";
import { buildFirstMeetingInstallerMessage } from "../../src/utils/firstMeetingGuide";

function links(payload: BaseMessageOptions) {
  const row = payload.components?.[0];
  if (!row || !("type" in row) || row.type !== ComponentType.ActionRow) {
    throw new Error("Expected API button action row");
  }
  return row.components.filter(
    (component) =>
      component.type === ComponentType.Button &&
      component.style === ButtonStyle.Link,
  );
}

test("installer_explains_first_recording with the approved copy and direct server/library links", () => {
  const payload = buildFirstMeetingInstallerMessage({
    guildId: "guild-1",
    serverName: "The Workshop",
    siteUrl: "https://chronote.test/",
  });
  expect(payload.content).toBe(
    [
      "Thanks for adding Chronote to **The Workshop**.",
      "",
      "Here's how to get your first notes:",
      "",
      "1. Join a voice channel.",
      "2. Run `/startmeeting` in a text channel.",
      "3. Follow the private link to your recording. Press **End meeting** when you're done.",
      "",
      "Your notes will be posted with the recording and saved in your meeting library.",
    ].join("\n"),
  );
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(links(payload)).toEqual([
    expect.objectContaining({
      label: "Open portal",
      style: 5,
      url: "https://chronote.test/portal/server/guild-1/library",
    }),
    expect.objectContaining({
      label: "Open The Workshop",
      style: 5,
      url: "https://discord.com/channels/guild-1",
    }),
  ]);
  expect(payload.content).not.toMatch(/onboard|remind|upgrade|Manage Guild/i);
});

test("installer_explains_first_recording escapes Markdown-bearing names and disables mentions", () => {
  const payload = buildFirstMeetingInstallerMessage({
    guildId: "guild-1",
    serverName: "**Team** _one_ @everyone <@123>",
    siteUrl: "https://chronote.test",
  });
  expect(payload.content).toContain(
    "Thanks for adding Chronote to **\\*\\*Team\\*\\* \\_one\\_ @everyone <@123>**.",
  );
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(links(payload)).toContainEqual(
    expect.objectContaining({
      label: "Open **Team** _one_ @everyone <@123>",
      url: "https://discord.com/channels/guild-1",
    }),
  );
});

test.each(["L".repeat(100), "😀".repeat(50)])(
  "installer_explains_first_recording keeps long names within Discord button limits: %s",
  (serverName) => {
    const payload = buildFirstMeetingInstallerMessage({
      guildId: "guild/1",
      serverName,
      siteUrl: "https://chronote.test",
    });
    const buttons = links(payload);
    expect(payload.content).toContain(`**${serverName}**`);
    for (const button of buttons) {
      expect(button.label?.length).toBeLessThanOrEqual(80);
      expect(button.label?.isWellFormed()).toBe(true);
    }
    expect(buttons).toContainEqual(
      expect.objectContaining({
        url: "https://discord.com/channels/guild%2F1",
      }),
    );
    expect(buttons).toContainEqual(
      expect.objectContaining({
        url: "https://chronote.test/portal/server/guild%2F1/library",
      }),
    );
  },
);

test("installer payload components are plain API objects for the shared browser preview", () => {
  const payload = buildFirstMeetingInstallerMessage({
    guildId: "guild-1",
    serverName: "The Workshop",
    siteUrl: "https://chronote.test",
  });
  expect(Object.getPrototypeOf(payload.components?.[0])).toBe(Object.prototype);
  expect(payload.components).toEqual([
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Open portal",
          url: "https://chronote.test/portal/server/guild-1/library",
        },
        {
          type: 2,
          style: 5,
          label: "Open The Workshop",
          url: "https://discord.com/channels/guild-1",
        },
      ],
    },
  ]);
});
