import { renewalGraceFixture } from "../../src/frontend/pages/renewalGraceFixtures";
import {
  useFreeBilling,
  useIntroBilling,
  useRenewalGrace,
} from "./billingMocks";
import type { Page } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mockGuilds, mockLibrary, mockSettings } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import { registerNotesRoutingVisualTests } from "./notesRoutingVisuals";
import { assertPageCanScroll } from "./scrollAssertions";

const runVisual = process.env.PW_VISUAL === "true";
const visualModes = ["viewport", "full"] as const;
type VisualMode = (typeof visualModes)[number];
const TARGET_SCREENSHOT_MAX_DIFF_PIXELS = 200;
const PAGE_SCREENSHOT_MAX_DIFF_PIXELS = 2_000;
const marketingViewports = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
  { name: "intermediate", width: 768, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
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

  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of marketingViewports) {
      for (const surface of ["home", "upgrade", "billing"] as const) {
        const fixture = {
          home: {
            path: "/",
            selector: "home-billing-period",
            purchase: "home-cta-basic",
          },
          upgrade: {
            path: `/upgrade/select-server?serverId=${mockGuilds.ddm.id}`,
            selector: "upgrade-billing-period",
            purchase: "upgrade-plan-basic",
          },
          billing: {
            path: `/portal/server/${mockGuilds.ddm.id}/billing`,
            selector: "billing-interval",
            purchase: "billing-plan-basic",
          },
        }[surface];
        test(`basic intro ${surface} ${viewport.name} ${colorScheme} @visual`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          await page.addInitScript(
            (scheme) =>
              localStorage.setItem("mantine-color-scheme-value", scheme),
            colorScheme,
          );
          await useIntroBilling(page);
          await page.goto(fixture.path);
          const selector = page.getByTestId(fixture.selector);
          await expect(page.getByTestId("basic-intro-terms")).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute(
            "data-mantine-color-scheme",
            colorScheme,
          );
          for (const interval of ["month", "year"] as const) {
            await selector
              .getByText(interval === "month" ? "Monthly" : "Annual", {
                exact: true,
              })
              .click();
            await expect(page.getByTestId("basic-intro-terms")).toContainText(
              interval === "month"
                ? "$6/month for your first 3 months, then $10/month"
                : "$60 for your first year, then $100/year",
            );
            const heights = await selector
              .locator("label")
              .evaluateAll((labels) =>
                labels.map((label) => label.getBoundingClientRect().height),
              );
            expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const purchase = page.getByTestId(fixture.purchase);
            const action =
              surface === "home" ? purchase : purchase.getByRole("button");
            await action.scrollIntoViewIfNeeded();
            await expect(action).toBeVisible();
            await expect(action).toBeEnabled();
            if (surface === "home" && viewport.width === 390) {
              const cards = page.getByTestId("home-pricing-cards");
              await expect(cards).toBeVisible();
              const bounds = await cards
                .locator(":scope > [data-testid]")
                .evaluateAll((elements) =>
                  elements.map((element) => {
                    const box = element.getBoundingClientRect();
                    return {
                      top: box.top,
                      bottom: box.bottom,
                      left: box.left,
                      right: box.right,
                    };
                  }),
                );
              expect(bounds).toHaveLength(3);
              expect(bounds[1].top).toBeGreaterThan(bounds[0].bottom);
              expect(bounds[2].top).toBeGreaterThan(bounds[1].bottom);
              expect(
                bounds.every(
                  (box) => box.left >= 0 && box.right <= viewport.width,
                ),
              ).toBe(true);
            }
            await assertPageCanScroll(page);
            await page.evaluate(() => window.scrollTo(0, 0));
            for (const mode of visualModes) {
              await page.goto(
                withVisualMode(
                  new URL(page.url()).pathname + new URL(page.url()).search,
                  mode,
                ),
              );
              await selector
                .getByText(interval === "month" ? "Monthly" : "Annual", {
                  exact: true,
                })
                .click();
              await expect(page.getByTestId("basic-intro-terms")).toContainText(
                interval === "month" ? "$6/month" : "$60 for your first year",
              );
              await waitForVisualReady(page);
              await page.evaluate(() =>
                window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
              );
              await expect
                .poll(() => page.evaluate(() => window.scrollY))
                .toBe(0);
              await expectVisualScreenshot(
                page,
                `basic-intro-${surface}-${viewport.name}-${colorScheme}-${interval}`,
                mode,
              );
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              ).toBe(true);
              await expect(
                page.getByTestId("basic-intro-discount"),
              ).toContainText("40% off");
            }
          }
        });
      }
    }
  }

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

  for (const viewport of marketingViewports.slice(0, 2)) {
    test(`recording-limit pages ${viewport.name} @visual`, async ({ page }) => {
      await useFreeBilling(page);
      await page.setViewportSize(viewport);
      const context =
        "source=discord_limit&limitType=weekly_recording&limitSurface=manual_start";
      await page.goto(
        `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&${context}&visual=1`,
      );
      await expect(
        page.getByText("Compare weekly recording time for this server."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue with Basic" }),
      ).toBeEnabled();
      await expectVisualScreenshot(
        page,
        `upgrade-limit-${viewport.name}`,
        "full",
      );
      const billingMode = viewport.name === "mobile" ? "viewport" : "full";
      await page.goto(
        withVisualMode(
          `/portal/server/${mockGuilds.ddm.id}/billing?${context}`,
          billingMode,
        ),
      );
      await expect(
        page.getByText("Compare weekly recording time for this server."),
      ).toBeVisible();
      await expect(page.getByTestId("billing-plan-basic")).toBeVisible();
      await expectVisualScreenshot(
        page,
        `billing-limit-${viewport.name}`,
        billingMode,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }

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
      await expect(page.getByTestId("my-meetings-page")).toBeVisible();
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
        await libraryPage.waitForLoaded();
        await page.getByTestId("library-range").click();
        await page.getByRole("option", { name: "All time" }).click();
        await libraryPage.waitForLoaded(mockLibrary.meetingCount);
      };

      await openLibrary();
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
      await expectVisualScreenshot(page, "library-notion-connect-menu", mode, {
        target: connectDrawerDialog,
      });
    });
  });

  test("ask page @visual", async ({ serverSelectPage, nav, askPage, page }) => {
    for (const mode of visualModes) {
      await page.goto(withVisualMode("/portal/select-server", mode));
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await nav.goToAsk();
      await askPage.waitForReady();
      await expectVisualScreenshot(page, "ask-list", mode);

      await askPage.switchListMode("archived");
      await askPage.waitForReady();
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

  for (const viewport of marketingViewports.filter(
    (item) => item.name === "desktop" || item.name === "mobile",
  )) {
    test(`billing renewal grace ${viewport.name} @visual`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await useRenewalGrace(page, {
        view: renewalGraceFixture({ priorTier: "pro", scheduledChange: true }),
      });
      for (const mode of visualModes) {
        await page.goto(
          withVisualMode(`/portal/server/${mockGuilds.ddm.id}/billing`, mode),
        );
        await expect(page.getByTestId("billing-renewal-grace")).toContainText(
          "keep using Pro until",
        );
        await expectVisualScreenshot(
          page,
          `billing-renewal-grace-${viewport.name}`,
          mode,
        );
      }
    });
    test(`billing canceled subscription ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useFreeBilling(page, { terminalStatus: "canceled" });
      for (const mode of visualModes) {
        await page.goto(
          withVisualMode(`/portal/server/${mockGuilds.ddm.id}/billing`, mode),
        );
        const currentPlan = page.getByTestId("billing-current-plan");
        await expect(currentPlan).toContainText("Free");
        await expect(currentPlan).not.toContainText("Canceled");
        await page
          .getByRole("button", { name: "Payment history", exact: true })
          .click();
        await expect(page.getByTestId("billing-payment-history")).toContainText(
          "Previous subscription: Canceled",
        );
        await expectVisualScreenshot(
          page,
          `billing-canceled-subscription-${viewport.name}`,
          mode,
        );
      }
    });
  }

  for (const viewport of marketingViewports.filter(
    (item) => item.name === "desktop" || item.name === "mobile",
  )) {
    test(`billing scheduled cancellation ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const cancellationAt = "2026-11-12T12:00:00.000Z";
      await useIntroBilling(page, {
        status: "ineligible",
        details: { status: "unavailable" },
        cancellationAt,
        nextBillingDate: cancellationAt,
      });
      for (const mode of visualModes) {
        await page.goto(
          withVisualMode(`/portal/server/${mockGuilds.ddm.id}/billing`, mode),
        );
        const currentPlan = page.getByTestId("billing-current-plan");
        await expect(currentPlan).toContainText(
          "Your Basic plan ends November 12, 2026.",
        );
        await expect(currentPlan).not.toContainText("next billing");
        await assertPageCanScroll(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expectVisualScreenshot(
          page,
          `billing-scheduled-cancellation-${viewport.name}`,
          mode,
        );
      }
    });
  }

  for (const viewport of marketingViewports.filter(
    (item) => item.name === "desktop" || item.name === "mobile",
  )) {
    test(`billing canceled subscription intro ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useIntroBilling(page, { legacy: true, terminalStatus: "canceled" });
      for (const mode of visualModes) {
        await page.goto(
          withVisualMode(`/portal/server/${mockGuilds.ddm.id}/billing`, mode),
        );
        const currentPlan = page.getByTestId("billing-current-plan");
        await expect(currentPlan).toContainText("Free");
        await expect(currentPlan).not.toContainText("Canceled");
        await page
          .getByRole("button", { name: "Payment history", exact: true })
          .click();
        await expect(page.getByTestId("billing-payment-history")).toContainText(
          "Previous subscription: Canceled",
        );
        await expectVisualScreenshot(
          page,
          `billing-canceled-subscription-intro-${viewport.name}`,
          mode,
        );
      }
    });
  }

  for (const viewport of marketingViewports.filter(
    (item) => item.name === "desktop" || item.name === "mobile",
  )) {
    test(`billing expired subscription ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useFreeBilling(page, { terminalStatus: "incomplete_expired" });
      for (const mode of visualModes) {
        await page.goto(
          withVisualMode(`/portal/server/${mockGuilds.ddm.id}/billing`, mode),
        );
        await expect(page.getByTestId("billing-current-plan")).toContainText(
          "Free",
        );
        await page
          .getByRole("button", { name: "Payment history", exact: true })
          .click();
        await expect(page.getByTestId("billing-payment-history")).toContainText(
          "Previous subscription: Expired",
        );
        await expect(
          page.getByRole("button", { name: "Get Basic again" }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Upgrade to Pro" }),
        ).toBeEnabled();
        await expectVisualScreenshot(
          page,
          `billing-expired-subscription-${viewport.name}`,
          mode,
        );
      }
    });
    for (const terminalStatus of ["canceled", "incomplete_expired"] as const) {
      test(`direct ${terminalStatus} history ${viewport.name} @visual`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await useFreeBilling(page, { terminalStatus });
        for (const mode of visualModes) {
          await page.goto(
            withVisualMode(
              `/upgrade/select-server?serverId=${mockGuilds.ddm.id}`,
              mode,
            ),
          );
          await expect(
            page.getByRole("button", { name: "Continue with Basic" }),
          ).toBeEnabled();
          await expect(
            page.getByRole("button", { name: "Continue with Pro" }),
          ).toBeEnabled();
          await expect(page.getByTestId("upgrade-plan-free")).toContainText(
            "Always free",
          );
          await expect(
            page.getByRole("button", { name: "View billing history" }),
          ).toBeVisible();
          await expectVisualScreenshot(
            page,
            `direct-${terminalStatus}-history-${viewport.name}`,
            mode,
          );
        }
      });
    }
  }

  for (const viewport of marketingViewports.filter(
    (item) => item.name === "desktop" || item.name === "mobile",
  )) {
    for (const entry of ["billing", "acquisition"] as const) {
      test(`complimentary terminal ${entry} ${viewport.name} @visual`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await useFreeBilling(page, {
          terminalStatus: "canceled",
          grantTier: "basic",
        });
        for (const mode of visualModes) {
          const path =
            entry === "billing"
              ? `/portal/server/${mockGuilds.ddm.id}/billing`
              : `/upgrade/select-server?serverId=${mockGuilds.ddm.id}`;
          await page.goto(withVisualMode(path, mode));
          const action =
            entry === "billing"
              ? "Start paying for Basic"
              : "Continue with Basic";
          await expect(
            page.getByRole("button", { name: action, exact: true }),
          ).toBeEnabled();
          if (entry === "billing") {
            await expect(
              page.getByTestId("billing-current-plan"),
            ).toContainText("Basic");
            await expect(
              page.getByTestId("billing-current-plan"),
            ).toContainText("45m / 20h");
          }
          await expectVisualScreenshot(
            page,
            `comped-terminal-${entry}-${viewport.name}`,
            mode,
          );
        }
      });
    }
    test(`Home unavailable offer ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useIntroBilling(page, { status: "unavailable" });
      for (const mode of visualModes) {
        await page.goto(withVisualMode("/", mode));
        await expect(page.getByTestId("home-cta-pro")).toBeEnabled();
        await expect(page.getByTestId("home-cta-basic")).toBeDisabled();
        await expectVisualScreenshot(
          page,
          `home-offer-unavailable-${viewport.name}`,
          mode,
        );
      }
    });
  }

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

  for (const viewport of marketingViewports) {
    test(`upgrade plan selection (free tier) ${viewport.name} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      // The Playwright mock backend sets FORCE_TIER=pro, which routes the
      // upgrade page to the "already on Pro" surface and hides the plan
      // picker. Intercept billing.me here so billing data reports the free
      // tier, exercising the Basic/Pro plan cards and the Continue-to-Stripe
      // CTA. This is the state most users actually see on /upgrade/select-server.
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
        if (!paths.some((path) => path.startsWith("billing.me"))) {
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
          if (!paths[index]?.startsWith("billing.me")) return entry;
          return replaceTrpcData(entry, {
            billingEnabled: true,
            tier: "free",
            status: "free",
            nextBillingDate: null,
            usage: null,
          });
        });
        await route.fulfill({
          status: 200,
          headers: jsonResponseHeaders(response.headers()),
          body: JSON.stringify(
            Array.isArray(body) ? nextEntries : nextEntries[0],
          ),
        });
      });

      for (const mode of visualModes) {
        const layoutMode = viewport.name === "desktop" ? mode : "viewport";
        await page.goto(
          withVisualMode(
            `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&promo=SAVE20`,
            layoutMode,
          ),
        );
        const main = page.locator("main");
        await expect(main).toBeVisible();
        // Wait for the Free server's Basic/Pro comparison to finish loading.
        await expect(page.getByText("Recommended")).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Basic", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Pro", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Continue with Basic",
            exact: true,
          }),
        ).toBeEnabled();
        await expect(
          page.getByText(mockGuilds.ddm.name, { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("upgrade-plan-free")).toBeVisible();
        const boxes = await page
          .getByTestId("upgrade-plans")
          .locator(".mantine-Paper-root")
          .evaluateAll((cards) =>
            cards.map((card) => {
              const { x, y, width, height } = card.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        expect(boxes).toHaveLength(3);
        expect(
          Math.max(...boxes.map((box) => box.width)) -
            Math.min(...boxes.map((box) => box.width)),
        ).toBeLessThan(2);
        if (viewport.width < 1200) {
          expect(boxes[1].y).toBeGreaterThanOrEqual(
            boxes[0].y + boxes[0].height,
          );
          expect(boxes[2].y).toBeGreaterThanOrEqual(
            boxes[1].y + boxes[1].height,
          );
        } else {
          expect(
            Math.max(...boxes.map((box) => box.y)) -
              Math.min(...boxes.map((box) => box.y)),
          ).toBeLessThan(2);
        }
        const bullets = await page
          .getByTestId("upgrade-plan-free")
          .getByRole("listitem")
          .evaluateAll((items) =>
            items.map((item) => {
              const { top, bottom } = item.getBoundingClientRect();
              return { top, bottom };
            }),
          );
        for (let index = 1; index < bullets.length; index++)
          expect(bullets[index].top).toBeGreaterThanOrEqual(
            bullets[index - 1].bottom,
          );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await expectVisualScreenshot(
          page,
          viewport.name === "desktop"
            ? "upgrade-select-free"
            : `upgrade-select-free-${viewport.name}`,
          mode,
        );
        await page
          .getByTestId("upgrade-billing-period")
          .getByText("Annual", { exact: true })
          .click();
        await expect(page.getByTestId("upgrade-plan-basic")).toContainText(
          "$120 / yr",
        );
        await expect(page.getByTestId("upgrade-plan-pro")).toContainText(
          "$290 / yr",
        );
        await expectVisualScreenshot(
          page,
          viewport.name === "desktop"
            ? "upgrade-select-free-annual"
            : `upgrade-select-free-annual-${viewport.name}`,
          mode,
        );
      }
    });
  }

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
