import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";

type CaptureNotesScreenshot = (
  page: Page,
  name: string,
  mode: "viewport",
  options?: { target?: Locator },
) => Promise<void>;

export function registerNotesRoutingVisualTests(
  expectVisualScreenshot: CaptureNotesScreenshot,
): void {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [1280, 768, 390]) {
      test(`notes routing ${width}px ${colorScheme} @visual`, async ({
        page,
        settingsPage,
      }) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.addInitScript(
          (scheme) =>
            localStorage.setItem("mantine-color-scheme-value", scheme),
          colorScheme,
        );
        await page.goto(`/portal/server/${mockGuilds.ddm.id}/settings`);
        await settingsPage.waitForLoaded();
        const row = settingsPage.overrideByName("Tabletop Voice");
        await expect(row).toContainText("Server default");
        const notesEntry = page.getByTestId(
          "settings-config-entry-notes.channelId",
        );
        await notesEntry.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await expect(notesEntry).toBeInViewport({ ratio: 1 });
        await expect(
          page.getByRole("combobox", { name: "notes.channelId", exact: true }),
        ).toBeInViewport();
        await expectVisualScreenshot(
          page,
          `notes-routing-default-notes-${width}-${colorScheme}`,
          "viewport",
          { target: page.getByTestId("settings-config-entry-notes.channelId") },
        );
        await expectVisualScreenshot(
          page,
          `notes-routing-voice-overrides-${width}-${colorScheme}`,
          "viewport",
          { target: page.getByTestId("settings-overrides") },
        );
        await row.getByRole("button", { name: "Edit Tabletop Voice" }).click();
        await expect(
          settingsPage
            .modal()
            .getByRole("switch", { name: "Auto-record this channel" }),
        ).not.toBeChecked();
        await expect(
          settingsPage
            .modal()
            .getByRole("combobox", { name: "Notes channel", exact: true }),
        ).toBeEnabled();
        await expectVisualScreenshot(
          page,
          `notes-routing-editor-${width}-${colorScheme}`,
          "viewport",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
    }
  }
}
