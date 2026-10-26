import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import type { SettingsPage } from "./pages";

export async function saveChannelOverride(
  page: Page,
  settingsPage: SettingsPage,
): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/trpc/channelContexts.set") && response.ok(),
    ),
    settingsPage.saveChannelButton().click(),
  ]);
  await expect(settingsPage.modal()).toBeHidden();
}

export async function selectNotesChannel(
  page: Page,
  settingsPage: SettingsPage,
  name: string,
): Promise<void> {
  await settingsPage
    .modal()
    .getByLabel("Notes channel", { exact: true })
    .click();
  await page.getByRole("option", { name, exact: true }).click();
}
