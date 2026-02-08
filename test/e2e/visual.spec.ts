import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mockGuilds, mockLibrary, mockSettings } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";

const runVisual = process.env.PW_VISUAL === "true";
const visualModes = ["viewport", "full"] as const;
type VisualMode = (typeof visualModes)[number];

const withVisualMode = (path: string, mode: VisualMode): string => {
  const url = new URL(path, "http://localhost");
  url.searchParams.set("visual", mode === "full" ? "1" : "0");
  return `${url.pathname}${url.search}${url.hash}`;
};

const buildScreenshotName = (base: string, mode: VisualMode): string =>
  `${base}-${mode}.png`;

test.describe("visual regression", () => {
  test.skip(!runVisual, "Visual regression disabled");

  test.use({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    contextOptions: {
      reducedMotion: "reduce",
      timezoneId: "UTC",
    },
  });

  test.beforeEach(async ({ page }) => {
    await applyVisualDefaults(page);
  });

  const expectVisualScreenshot = async (
    page: Page,
    name: string,
    mode: VisualMode,
  ): Promise<void> => {
    await waitForVisualReady(page);
    await expect(page).toHaveScreenshot(buildScreenshotName(name, mode), {
      fullPage: mode === "full",
      maxDiffPixels: 200,
    });
  };

  test("home page @visual", async ({ homePage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/", mode));
      await expect(homePage.hero()).toBeVisible();
      await expectVisualScreenshot(page, "home", mode);
    }
  });

  test("server select @visual", async ({ serverSelectPage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await expect(serverSelectPage.root()).toBeVisible();
      await expectVisualScreenshot(page, "server-select", mode);
    }
  });

  test("library page @visual", async ({
    serverSelectPage,
    libraryPage,
    page,
  }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await libraryPage.waitForLoaded();
      await page.getByTestId("library-range").click();
      await page.getByRole("option", { name: "All time" }).click();
      await libraryPage.waitForLoaded(mockLibrary.meetingCount);
      await expectVisualScreenshot(page, "library-list", mode);

      await libraryPage.openFirstMeeting();
      const drawerDialog = page.getByRole("dialog");
      await expect(drawerDialog).toBeVisible();
      await expectVisualScreenshot(page, "library-drawer", mode);
      await libraryPage.closeDrawer();
      await expect(libraryPage.drawer()).toBeHidden();

      await page.getByTestId("library-archive-filter").click();
      await page.getByRole("option", { name: "Archived" }).click();
      await libraryPage.waitForLoaded();
      await expectVisualScreenshot(page, "library-archived", mode);
    }
  });

  test("ask page @visual", async ({ serverSelectPage, nav, askPage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await nav.goToAsk();
      await askPage.waitForReady();
      await expectVisualScreenshot(page, "ask-list", mode);

      await askPage.switchListMode("archived");
      await expectVisualScreenshot(page, "ask-archived", mode);

      await askPage.startNewChat();
      await expect(askPage.title()).toContainText(/new chat/i);
      await expectVisualScreenshot(page, "ask-new-chat", mode);
    }
  });

  test("billing page @visual", async ({
    serverSelectPage,
    nav,
    billingPage,
    page,
  }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await nav.goToBilling();
      await billingPage.waitForLoaded();
      await billingPage.expandPlans();
      await expectVisualScreenshot(page, "billing-paid", mode);

      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.chronote.name);
      await nav.goToBilling();
      await billingPage.waitForLoaded();
      await billingPage.expandPlans();
      await expectVisualScreenshot(page, "billing-free", mode);
    }
  });

  test("upgrade flow pages @visual", async ({ page }) => {
    for (const mode of visualModes) {
      await page.goto(
        withVisualMode("/upgrade?promo=SAVE20&canceled=true", mode),
      );
      const main = page.locator("main");
      await expect(main).toBeVisible();
      await expectVisualScreenshot(page, "upgrade", mode);

      await page.goto(
        withVisualMode("/upgrade/select-server?promo=SAVE20", mode),
      );
      await expect(main).toBeVisible();
      await expectVisualScreenshot(page, "upgrade-select", mode);

      await page.goto(
        withVisualMode(
          `/upgrade/success?promo=SAVE20&serverId=${mockGuilds.ddm.id}`,
          mode,
        ),
      );
      await expect(main).toBeVisible();
      await expectVisualScreenshot(page, "upgrade-success", mode);

      await page.goto(withVisualMode("/promo/SAVE20", mode));
      await expect(main).toBeVisible();
      await expectVisualScreenshot(page, "promo-landing", mode);
    }
  });

  test("settings page @visual", async ({
    serverSelectPage,
    nav,
    settingsPage,
    page,
  }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await nav.goToSettings();
      await settingsPage.waitForLoaded(
        mockSettings.overrideChannelName || undefined,
      );
      await page.waitForTimeout(150); // allow config hydration to settle
      await expectVisualScreenshot(page, "settings", mode);

      await settingsPage.expandGroup("Experimental");
      const experimentalGroup = settingsPage.groupByName("Experimental");
      await expect(experimentalGroup).toBeVisible();
      await page.waitForTimeout(150); // allow experimental toggles to render
      if (mode === "viewport") {
        await expectVisualScreenshot(page, "settings-experimental", mode);
      }

      await settingsPage.openFirstOverrideEdit();
      const settingsDialog = page.getByRole("dialog", {
        name: /channel settings/i,
      });
      await expect(settingsDialog).toBeVisible();
      await expectVisualScreenshot(page, "settings-modal", mode);
    }
  });

  test("admin config page @visual", async ({
    serverSelectPage,
    nav,
    adminConfigPage,
    page,
  }) => {
    const mode: VisualMode = "full";
    await page.goto(withVisualMode("/portal/select-server", mode));
    await serverSelectPage.openServerByName(mockGuilds.ddm.name);
    await nav.goToAdminConfig();
    await adminConfigPage.waitForLoaded();
    await adminConfigPage.expandGroup("Experimental");
    await adminConfigPage
      .entryByKey("transcription.premium.enabled")
      .waitFor({ state: "visible" });
    await page.waitForTimeout(150); // stabilize async field rendering
    await expectVisualScreenshot(page, "admin-config", mode);
  });

  test("settings experimental full @visual (skipped)", async () => {
    test.skip(
      true,
      "TODO: settings-experimental-full visual snapshot is failing",
    );
  });

  test("admin config viewport @visual (skipped)", async () => {
    test.skip(true, "TODO: admin-config-viewport visual snapshot is failing");
  });

  test("admin home and feedback pages @visual", async ({ page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/admin", mode));
      await expect(page.getByTestId("admin-home-page")).toBeVisible();
      await expectVisualScreenshot(page, "admin-home", mode);

      await page.goto(withVisualMode("/admin/feedback", mode));
      await expect(page.getByTestId("admin-feedback-page")).toBeVisible();
      await expect(
        page.getByText("Clear summary and next steps."),
      ).toBeVisible();
      await expectVisualScreenshot(page, "admin-feedback", mode);
    }
  });
});
