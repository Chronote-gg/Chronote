import type { Page } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mockGuilds, mockLibrary, mockSettings } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import { registerNotesRoutingVisualTests } from "./notesRoutingVisuals";

const runVisual = process.env.PW_VISUAL === "true";
type VisualMode = "viewport" | "full";
const visualModes: readonly VisualMode[] = ["viewport"];
const TARGET_SCREENSHOT_MAX_DIFF_PIXELS = 200;
const PAGE_SCREENSHOT_MAX_DIFF_PIXELS = 2_000;
const marketingViewports = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

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
  if (path === "notion.automationStatus") {
    return {
      configured: true,
      userConnected: state.connected,
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
      source: "manual",
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

const jsonResponseHeaders = (source: Record<string, string>) => {
  const headers: Record<string, string> = {
    ...source,
    "content-type": "application/json",
  };
  delete headers["content-length"];
  return headers;
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
    await route.fulfill({
      status: 200,
      headers: jsonResponseHeaders(response.headers()),
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
      await expect.soft(options.target).toHaveScreenshot(screenshotName, {
        maxDiffPixels: TARGET_SCREENSHOT_MAX_DIFF_PIXELS,
      });
      return;
    }

    await expect.soft(page).toHaveScreenshot(screenshotName, {
      fullPage: mode === "full",
      maxDiffPixels: PAGE_SCREENSHOT_MAX_DIFF_PIXELS,
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

  for (const viewport of marketingViewports) {
    test(`join page ${viewport.name} @visual`, async ({ joinPage, page }) => {
      await page.setViewportSize(viewport);
      for (const mode of visualModes) {
        // Capture new responsive baselines with the customer-facing layout.
        const layoutMode = viewport.name === "desktop" ? mode : "viewport";
        await page.goto(withVisualMode("/join", layoutMode));
        await expect(joinPage.hero()).toBeVisible();
        await expect(joinPage.ctaDiscord()).toBeVisible();
        await expect(
          page.getByText("/startmeeting", { exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await expectVisualScreenshot(
          page,
          viewport.name === "desktop" ? "join" : `join-${viewport.name}`,
          mode,
        );
      }
    });
  }

  test("server select @visual", async ({ serverSelectPage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await expect(serverSelectPage.root()).toBeVisible();
      await expectVisualScreenshot(page, "server-select", mode);
    }
  });

  test("portal home and personal settings @visual", async ({ page }) => {
    let notionState: NotionVisualState = {
      connected: true,
      exported: false,
      outdated: false,
    };
    await installNotionVisualState(page, () => notionState);

    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/meetings", mode));
      await expect(page.getByTestId("unified-meetings-page")).toBeVisible();
      await expectVisualScreenshot(page, "my-meetings", mode);

      notionState = { connected: true, exported: false, outdated: false };
      await page.goto(withVisualMode("/portal/settings", mode));
      await expect(page.getByTestId("personal-settings-page")).toBeVisible();
      await expectVisualScreenshot(page, "personal-settings", mode);
    }
  });

  visualModes.forEach((mode) => {
    test(`library page ${mode} @visual`, async ({
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
      const openLibrary = async () => {
        await page.goto(withVisualMode("/portal/select-server", mode));
        await serverSelectPage.openServerByName(mockGuilds.ddm.name);
        await libraryPage.selectAllTime();
        await libraryPage.waitForLoaded(mockLibrary.meetingCount);
      };

      await openLibrary();
      await expectVisualScreenshot(page, "library-list", mode);

      await libraryPage.openFirstMeeting();
      const drawerDialog = page.getByRole("dialog");
      await expect(drawerDialog).toBeVisible();
      await expect(libraryPage.drawerSummaryLabel()).toBeVisible();
      await expectVisualScreenshot(page, "library-drawer", mode);

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Sync latest to Notion" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Open Notion page" }),
      ).toBeVisible();
      await resetDrawerScroll(page, drawerDialog);

      await page.keyboard.press("Escape");

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await page.getByRole("menuitem", { name: "Edit notes" }).click();
      const notesEditorDialog = page.getByRole("dialog", {
        name: /edit notes/i,
      });
      await expect(notesEditorDialog).toBeVisible();

      await notesEditorDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(notesEditorDialog).toBeHidden();

      await drawerDialog.getByRole("button", { name: "Notes actions" }).click();
      await page.getByRole("menuitem", { name: "Import notes" }).click();
      const notesImportDialog = page.getByRole("dialog", {
        name: /import notes/i,
      });
      await expect(notesImportDialog).toBeVisible();

      await notesImportDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(notesImportDialog).toBeHidden();

      await libraryPage.drawerFullscreenToggle().click();
      await expect(
        drawerDialog.getByRole("button", { name: /exit fullscreen/i }),
      ).toBeVisible();
      await expect(
        drawerDialog.getByRole("link", { name: "diagram.png" }),
      ).toBeVisible();

      await libraryPage.drawerFullscreenToggle().click();
      await expect(libraryPage.drawerFullscreenToggle()).toContainText(
        /open fullscreen/i,
      );
      await libraryPage.closeDrawer();
      await expect(libraryPage.drawer()).toBeHidden();

      await page.getByTestId("library-archive-filter").click();
      await page.getByRole("option", { name: "Archived" }).click();
      await libraryPage.waitForLoaded();

      notionState = { connected: false, exported: false, outdated: false };
      await openLibrary();
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
    });
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
          `/upgrade/success?promo=SAVE20&serverId=${mockGuilds.ddm.id}&plan=basic&interval=month`,
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

  registerNotesRoutingVisualTests(expectVisualScreenshot);

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

      await settingsPage.openFirstOverrideEdit();
      const settingsDialog = page.getByRole("dialog", {
        name: /channel settings/i,
      });
      await expect(settingsDialog).toBeVisible();
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
