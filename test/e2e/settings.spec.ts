import { expect, test } from "./fixtures";
import { mockGuilds, mockSettings } from "./mockData";
import {
  saveChannelOverride,
  selectNotesChannel,
} from "./settingsNotesRouting";

test("settings page shows overrides and updates tags (mock)", async ({
  page,
  serverSelectPage,
  nav,
  settingsPage,
}) => {
  await serverSelectPage.goto();
  await serverSelectPage.openServerByName(mockGuilds.ddm.name);

  await nav.goToSettings();
  await settingsPage.waitForLoaded(
    mockSettings.overrideChannelName || undefined,
  );

  const chatTtsEntry = page.getByTestId(
    "settings-config-entry-chatTts.enabled",
  );
  await chatTtsEntry.scrollIntoViewIfNeeded();
  await chatTtsEntry.getByText("On", { exact: true }).click();

  const liveVoiceEntry = page.getByTestId(
    "settings-config-entry-liveVoice.enabled",
  );
  await liveVoiceEntry.scrollIntoViewIfNeeded();
  await liveVoiceEntry.getByText("On", { exact: true }).click();

  const liveVoiceVoiceEntry = page.getByTestId(
    "settings-config-entry-liveVoice.ttsVoice",
  );
  await liveVoiceVoiceEntry.scrollIntoViewIfNeeded();
  await liveVoiceVoiceEntry.getByLabel("liveVoice.ttsVoice").click();
  await page.getByRole("option", { name: "Nova" }).click();

  const chatTtsVoiceEntry = page.getByTestId(
    "settings-config-entry-chatTts.voice",
  );
  await chatTtsVoiceEntry.scrollIntoViewIfNeeded();
  await chatTtsVoiceEntry.getByLabel("chatTts.voice").click();
  await page.getByRole("option", { name: "Alloy" }).click();

  await settingsPage.saveConfigButton().click();

  const override = mockSettings.overrideChannelName
    ? settingsPage.overrideByName(mockSettings.overrideChannelName)
    : settingsPage.firstOverride();
  await expect(override).toBeVisible();

  await settingsPage.openFirstOverrideEdit();
  await expect(settingsPage.modalTitle()).toBeVisible();
  await settingsPage.tagInput().fill("raid, recap");
  await settingsPage.saveChannelButton().click();
  await expect(settingsPage.modal()).toBeHidden();
  await settingsPage.openFirstOverrideEdit();
  await expect(settingsPage.tagInput()).toHaveValue("raid, recap");
  await settingsPage.saveChannelButton().click();
  await expect(settingsPage.modal()).toBeHidden();

  const overridesBefore = await settingsPage.overrides().count();
  await settingsPage.removeFirstOverride().click();
  await expect(settingsPage.overrides()).toHaveCount(overridesBefore);
  await expect(
    override.getByRole("button", { name: /remove override/i }),
  ).toHaveCount(0);

  const refresh = settingsPage.refreshChannelsButton();
  await refresh.click();
  await expect(refresh).toBeVisible();
});

test.describe("notes routing", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page, settingsPage }) => {
    await page.goto(`/portal/server/${mockGuilds.ddm.id}/settings`);
    await settingsPage.waitForLoaded();
  });

  test("notes_routing_persists_and_resets", async ({ page, settingsPage }) => {
    const row = settingsPage.overrideByName("Tabletop Voice");
    const setDefault = async (name: string) => {
      const picker = page.getByRole("combobox", {
        name: "notes.channelId",
        exact: true,
      });
      if ((await picker.inputValue()) === name) return;
      await picker.click();
      await page.getByRole("option", { name, exact: true }).click();
      const saved = page.waitForResponse((response) =>
        response.url().includes("/trpc/config.setServerOverride"),
      );
      await settingsPage.saveConfigButton().click();
      expect((await saved).ok()).toBe(true);
      await page.reload();
      await settingsPage.waitForLoaded();
      await expect(picker).toHaveValue(name);
    };
    await setDefault("#session-notes");
    await row.getByRole("button", { name: "Edit Tabletop Voice" }).click();
    await expect(
      settingsPage
        .modal()
        .getByRole("switch", { name: "Auto-record this channel" }),
    ).not.toBeChecked();
    // An explicit choice equal to the default must stay explicit after that default changes.
    await selectNotesChannel(page, settingsPage, "#session-notes");
    await expect(
      settingsPage
        .modal()
        .getByRole("button", { name: "Reset to server default" }),
    ).toBeEnabled();
    await saveChannelOverride(page, settingsPage);
    await page.reload();
    await settingsPage.waitForLoaded();
    await expect(row).toContainText("#session-notes · Voice channel override");
    await setDefault("#campaign-info");
    await expect(row).toContainText("#session-notes · Voice channel override");
    await row.getByRole("button", { name: "Edit Tabletop Voice" }).click();
    await settingsPage
      .modal()
      .getByRole("button", { name: "Reset to server default" })
      .click();
    await saveChannelOverride(page, settingsPage);
    await page.reload();
    await settingsPage.waitForLoaded();
    await expect(row).toContainText("#campaign-info · Server default");
    await setDefault("#session-notes");
    await expect(row).toContainText("#session-notes · Server default");
  });

  test("notes_routing_does_not_enable_recording", async ({
    page,
    settingsPage,
  }) => {
    const row = settingsPage.overrideByName("Tabletop Voice");
    await row.getByRole("button", { name: "Edit Tabletop Voice" }).click();
    const autoRecord = settingsPage
      .modal()
      .getByRole("switch", { name: "Auto-record this channel" });
    await expect(autoRecord).not.toBeChecked();
    await selectNotesChannel(page, settingsPage, "#campaign-info");
    await expect(autoRecord).not.toBeChecked();
    await saveChannelOverride(page, settingsPage);
    await page.reload();
    await settingsPage.waitForLoaded();
    await expect(row).toContainText("Auto-record off");
    await expect(row).toContainText("#campaign-info · Voice channel override");
    await row.getByRole("button", { name: "Edit Tabletop Voice" }).click();
    await expect(autoRecord).not.toBeChecked();
    await settingsPage
      .modal()
      .getByRole("button", { name: "Reset to server default" })
      .click();
    await saveChannelOverride(page, settingsPage);
  });

  test("notes_routing_editor_scrolls", async ({ page, settingsPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const edit = settingsPage
      .overrideByName("Tabletop Voice")
      .getByRole("button", { name: "Edit Tabletop Voice" });
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(settingsPage.modal()).toBeVisible();
    const scroll = await page.getByRole("dialog").evaluate((dialog) => {
      const elements = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")];
      const container = elements.find(
        (element) =>
          element.scrollHeight > element.clientHeight &&
          ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
      );
      if (!container) return null;
      container.scrollTop = 0;
      const before = container.scrollTop;
      container.scrollTop = 200;
      return {
        height: container.scrollHeight,
        client: container.clientHeight,
        before,
        after: container.scrollTop,
      };
    });
    expect(scroll).not.toBeNull();
    expect(scroll?.height).toBeGreaterThan(scroll?.client ?? Infinity);
    expect(scroll?.after).toBeGreaterThan(scroll?.before ?? Infinity);
    await settingsPage.saveChannelButton().scrollIntoViewIfNeeded();
    await expect(settingsPage.saveChannelButton()).toBeInViewport();
    await expect(settingsPage.saveChannelButton()).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
