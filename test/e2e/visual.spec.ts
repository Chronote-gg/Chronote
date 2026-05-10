import type { Page } from "@playwright/test";
import type { Locator } from "@playwright/test";
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

type NotionVisualState = {
  connected: boolean;
  exported: boolean;
  outdated: boolean;
};

const replaceTrpcData = (entry: unknown, data: unknown): unknown => {
  if (!entry || typeof entry !== "object" || !("result" in entry)) {
    return { result: { data } };
  }
  const result = entry.result;
  if (!result || typeof result !== "object") return entry;
  const currentData = "data" in result ? result.data : undefined;
  const nextData =
    currentData &&
    typeof currentData === "object" &&
    !Array.isArray(currentData) &&
    "json" in currentData
      ? { ...currentData, json: data }
      : data;
  return { ...entry, result: { ...result, data: nextData } };
};

const buildNotionVisualData = (path: string, state: NotionVisualState) => {
  if (path === "notion.status") {
    return {
      configured: true,
      connected: state.connected,
      workspaceName: state.connected ? "Product Ops" : undefined,
      workspaceId: state.connected ? "workspace-visual" : undefined,
    };
  }
  if (path === "notion.exportStatus") {
    if (!state.exported) {
      return { exported: false, currentNotesVersion: 4, outdated: false };
    }
    return {
      exported: true,
      pageUrl: "https://notion.so/visual-meeting-notes",
      pageId: "page-visual",
      exportedNotesVersion: state.outdated ? 3 : 4,
      currentNotesVersion: 4,
      outdated: state.outdated,
      lastExportedAt: "2025-01-01T00:00:00.000Z",
    };
  }
  return undefined;
};

const installNotionVisualState = async (
  page: Page,
  getState: () => NotionVisualState,
): Promise<void> => {
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const marker = "/trpc/";
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex === -1) {
      await route.continue();
      return;
    }

    const paths = decodeURIComponent(
      url.pathname.slice(markerIndex + marker.length),
    ).split(",");
    if (!paths.some((path) => path.startsWith("notion."))) {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      await route.fulfill({ response });
      return;
    }

    const body: unknown = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    const nextEntries = entries.map((entry, index) => {
      const visualData = buildNotionVisualData(paths[index] ?? "", getState());
      return visualData === undefined
        ? entry
        : replaceTrpcData(entry, visualData);
    });
    const headers = {
      ...response.headers(),
      "content-type": "application/json",
    };
    delete headers["content-length"];

    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify(Array.isArray(body) ? nextEntries : nextEntries[0]),
    });
  });
};

test.describe("visual regression", () => {
  test.skip(!runVisual, "Visual regression disabled");

  test.use({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    contextOptions: {
      reducedMotion: "reduce",
    },
  });

  test.beforeEach(async ({ page }) => {
    await applyVisualDefaults(page);
  });

  const expectVisualScreenshot = async (
    page: Page,
    name: string,
    mode: VisualMode,
    options?: {
      target?: Locator;
    },
  ): Promise<void> => {
    await waitForVisualReady(page);

    const screenshotName = buildScreenshotName(name, mode);
    if (options?.target) {
      await expect(options.target).toHaveScreenshot(screenshotName, {
        maxDiffPixels: 200,
      });
      return;
    }

    await expect(page).toHaveScreenshot(screenshotName, {
      fullPage: mode === "full",
      maxDiffPixels: 200,
    });
  };

  const resetDrawerScroll = async (
    page: Page,
    drawerDialog: Locator,
  ): Promise<void> => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await drawerDialog.evaluate((element) => {
      element.scrollTop = 0;
      for (const child of element.querySelectorAll<HTMLElement>("*")) {
        child.scrollTop = 0;
      }
    });
  };

  test("home page @visual", async ({ homePage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/", mode));
      await expect(homePage.hero()).toBeVisible();
      await expectVisualScreenshot(page, "home", mode);
    }
  });

  test("join page @visual", async ({ joinPage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/join", mode));
      await expect(joinPage.hero()).toBeVisible();
      await expectVisualScreenshot(page, "join", mode);
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
    let notionState: NotionVisualState = {
      connected: true,
      exported: true,
      outdated: true,
    };
    await installNotionVisualState(page, () => notionState);

    for (const mode of visualModes) {
      notionState = { connected: true, exported: true, outdated: true };
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

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Sync latest to Notion" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Open Notion page" }),
      ).toBeVisible();
      await resetDrawerScroll(page, drawerDialog);
      await expectVisualScreenshot(page, "library-notion-sync-menu", mode, {
        target: drawerDialog,
      });
      await page.keyboard.press("Escape");

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await page.getByRole("menuitem", { name: "Edit notes" }).click();
      const notesEditorDialog = page.getByRole("dialog", {
        name: /edit notes/i,
      });
      await expect(notesEditorDialog).toBeVisible();
      await expectVisualScreenshot(page, "library-notes-editor", mode, {
        target: notesEditorDialog,
      });
      await notesEditorDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(notesEditorDialog).toBeHidden();

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await page.getByRole("menuitem", { name: "Import notes" }).click();
      const notesImportDialog = page.getByRole("dialog", {
        name: /import notes/i,
      });
      await expect(notesImportDialog).toBeVisible();
      await expectVisualScreenshot(page, "library-notes-import", mode, {
        target: notesImportDialog,
      });
      await notesImportDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(notesImportDialog).toBeHidden();

      await libraryPage.drawerFullscreenToggle().click();
      await expect(
        drawerDialog.getByRole("button", { name: /exit fullscreen/i }),
      ).toBeVisible();
      await expect(
        drawerDialog.getByRole("link", { name: "diagram.png" }),
      ).toBeVisible();
      await expectVisualScreenshot(page, "library-transcript", mode);
      await libraryPage.drawerFullscreenToggle().click();
      await expect(libraryPage.drawerFullscreenToggle()).toContainText(
        /open fullscreen/i,
      );
      await libraryPage.closeDrawer();
      await expect(libraryPage.drawer()).toBeHidden();

      await page.getByTestId("library-archive-filter").click();
      await page.getByRole("option", { name: "Archived" }).click();
      await libraryPage.waitForLoaded();
      await expectVisualScreenshot(page, "library-archived", mode);

      notionState = { connected: false, exported: false, outdated: false };
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await libraryPage.waitForLoaded();
      await page.getByTestId("library-range").click();
      await page.getByRole("option", { name: "All time" }).click();
      await libraryPage.waitForLoaded(mockLibrary.meetingCount);
      await libraryPage.openFirstMeeting();
      const connectDrawerDialog = page.getByRole("dialog");
      await expect(connectDrawerDialog).toBeVisible();
      await connectDrawerDialog
        .getByRole("button", { name: "Notes actions" })
        .click();
      await expect(
        page.getByRole("menuitem", { name: "Connect Notion" }),
      ).toBeVisible();
      await resetDrawerScroll(page, connectDrawerDialog);
      await expectVisualScreenshot(page, "library-notion-connect-menu", mode, {
        target: connectDrawerDialog,
      });
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
      await expectVisualScreenshot(page, "settings-experimental", mode);

      await settingsPage.openFirstOverrideEdit();
      const settingsDialog = page.getByRole("dialog", {
        name: /channel settings/i,
      });
      await expect(settingsDialog).toBeVisible();
      await expectVisualScreenshot(page, "settings-modal", mode, {
        target: settingsDialog,
      });
    }
  });

  test("admin config page @visual", async ({
    serverSelectPage,
    nav,
    adminConfigPage,
    page,
  }) => {
    for (const mode of visualModes) {
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
    }
  });

  test("contact feedback page @visual", async ({ page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/feedback", mode));
      await expect(page.getByTestId("contact-feedback-page")).toBeVisible();
      await expectVisualScreenshot(page, "contact-feedback", mode);
    }
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
