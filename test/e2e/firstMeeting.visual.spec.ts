import type { Locator } from "@playwright/test";
import type { FirstMeetingState } from "../../src/types/firstMeeting";
import { expect, test } from "./fixtures";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import { assertPageCanScroll } from "./scrollAssertions";

const serverId = mockGuilds.ddm.id;
const meeting = {
  historyId: "111111111111111111#2024-12-31T12:00:00.000Z",
  title: "Engineering weekly planning",
  portalUrl: `http://127.0.0.1:5173/portal/meetings/${serverId}/111111111111111111%232024-12-31T12%3A00%3A00.000Z`,
  discordUrl: `https://discord.com/channels/${serverId}/222222222222222222/333333333333333333`,
  captureNotice: "Some audio could not be captured.",
  recoveryNotice: "Recording recovered after an interruption.",
};
const scenarios: Array<{
  name: string;
  heading: string;
  state?: FirstMeetingState;
  action?: "View recording" | "Open meeting";
  optional?: boolean;
  unavailable?: boolean;
}> = [
  { name: "unknown", heading: "Record your first meeting." },
  {
    name: "recording",
    heading: "Recording in progress",
    state: { kind: "recording", meeting },
    action: "View recording",
  },
  {
    name: "processing",
    heading: "Preparing your notes",
    state: { kind: "processing", meeting },
    action: "View recording",
  },
  {
    name: "ready",
    heading: "Your notes are ready",
    state: { kind: "ready", meeting },
    action: "Open meeting",
  },
  {
    name: "saved",
    heading: "Notes saved",
    state: { kind: "saved", meeting },
    action: "Open meeting",
  },
  {
    name: "partial",
    heading: "Notes saved. Some notes could not be posted to Discord.",
    state: { kind: "delivery_attention", delivery: "partial", meeting },
    action: "Open meeting",
  },
  {
    name: "failed",
    heading: "Notes saved. Discord delivery failed.",
    state: { kind: "delivery_attention", delivery: "failed", meeting },
    action: "Open meeting",
  },
  {
    name: "unavailable",
    heading: "Record your first meeting.",
    unavailable: true,
  },
  { name: "optional", heading: "Record your first meeting.", optional: true },
];
async function keyboardReachable(action: Locator) {
  await action.focus();
  await action.page().keyboard.press("Shift+Tab");
  await action.page().keyboard.press("Tab");
  await expect(action).toBeFocused();
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport();
}

test.describe("first-meeting journeys", () => {
  test.skip(process.env.PW_VISUAL !== "true", "Visual regression disabled");
  test.use({
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
  });
  test.beforeEach(async ({ page }) => {
    await applyVisualDefaults(page);
  });
  for (const width of [390, 768, 1280]) {
    for (const colorScheme of ["dark", "light"] as const) {
      for (const scenario of scenarios.filter(
        (item) =>
          colorScheme === "dark" ||
          ["ready", "partial", "optional"].includes(item.name),
      )) {
        test(`${scenario.name} ${colorScheme} ${width}px @visual`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 720 });
          await page.addInitScript(
            (scheme) =>
              localStorage.setItem("mantine-color-scheme-value", scheme),
            colorScheme,
          );
          await mockFirstMeetingRequests(page, {
            "meetings.firstMeeting": () => scenario.state ?? { kind: "guide" },
          });
          if (scenario.unavailable)
            await page.route("**/trpc/meetings.firstMeeting*", (route) =>
              route.abort("failed"),
            );
          await page.goto(
            `/join${scenario.name === "unknown" ? "" : `?serverId=${serverId}`}`,
          );
          await expect(
            page.getByRole("heading", { name: scenario.heading, exact: true }),
          ).toBeVisible();
          if (scenario.state) {
            await expect(page.getByText(meeting.captureNotice)).toBeVisible();
            await expect(page.getByText(meeting.recoveryNotice)).toBeVisible();
            await expect(
              page.getByRole("link", { name: scenario.action, exact: true }),
            ).toHaveAttribute(
              "href",
              scenario.action === "Open meeting"
                ? meeting.portalUrl
                : meeting.discordUrl,
            );
          }
          if (scenario.unavailable)
            await expect(
              page.getByText("Status unavailable. Check again to refresh it."),
            ).toBeVisible();
          const optional = page.locator("details");
          if (scenario.optional) {
            await optional.locator("summary").click();
            await expect(optional).toHaveAttribute("open", "");
            await expect(
              page.getByText("/context", { exact: true }),
            ).toBeVisible();
          } else await expect(optional).not.toHaveAttribute("open");
          await keyboardReachable(
            page.getByRole("link", {
              name: scenario.action ?? "Open Discord",
              exact: true,
            }),
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await assertPageCanScroll(page);
          await page.evaluate(() => window.scrollTo(0, 0));
          await waitForVisualReady(page);
          await expect(page).toHaveScreenshot(
            `first-meeting-${scenario.name}-${colorScheme}-${width}.png`,
            { fullPage: true, maxDiffPixels: 200 },
          );
        });
      }
      test(`empty library ${colorScheme} ${width}px @visual`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 600 });
        await page.addInitScript(
          (scheme) =>
            localStorage.setItem("mantine-color-scheme-value", scheme),
          colorScheme,
        );
        await mockFirstMeetingRequests(page, {
          "meetings.myList": () => ({
            meetings: [],
            hasMore: false,
            discoveryComplete: true,
            nextCursor: null,
          }),
          "servers.listEligible": () => ({
            guilds: [{ id: serverId, name: "DDM", canManage: false }],
          }),
        });
        await page.goto(`/portal/server/${serverId}/library`);
        const root = page.getByTestId("first-meeting-empty-state");
        await expect(root).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Your first meeting in DDM goes here.",
          }),
        ).toBeVisible();
        if (width < 768)
          await page.getByRole("button", { name: /^Filters/ }).click();
        await expect(page.getByTestId("library-archive-filter")).toBeVisible();
        await expect(page.getByTestId("library-search")).toBeVisible();
        const action = page.getByRole("link", {
          name: "Open Discord",
          exact: true,
        });
        await expect(action).toHaveAttribute(
          "href",
          `https://discord.com/channels/${serverId}`,
        );
        await keyboardReachable(action);
        const layout = await root.evaluate((element) => {
          const sample = element.querySelector(
            '[data-testid="sample-summary"]',
          )!;
          const steps = element.querySelector("ol")!;
          const style = getComputedStyle(element);
          return {
            width:
              element.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
            example: sample.getBoundingClientRect().toJSON(),
            steps: steps.getBoundingClientRect().toJSON(),
            overflow: element.scrollWidth > element.clientWidth,
            palette: getComputedStyle(sample).backgroundColor,
          };
        });
        expect(layout.overflow).toBe(false);
        expect(layout.palette).toBe("rgb(49, 51, 56)");
        if (layout.width < 800)
          expect(layout.example.y).toBeGreaterThan(layout.steps.bottom);
        else expect(layout.example.x).toBeGreaterThan(layout.steps.right);
        if (width === 390 || width === 768)
          expect(layout.example.y).toBeGreaterThan(layout.steps.bottom);
        const scroll = await page.locator("main").evaluate((element) => {
          const height = element.scrollHeight;
          const client = element.clientHeight;
          element.scrollTop = 0;
          const before = element.scrollTop;
          element.scrollTop = 100;
          const after = element.scrollTop;
          element.scrollTop = 0;
          return { height, client, before, after };
        });
        expect(scroll.height).toBeGreaterThan(scroll.client);
        expect(scroll.after).toBeGreaterThan(scroll.before);
        await page.goto(`/portal/server/${serverId}/library?visual=1`);
        await expect(root).toBeVisible();
        await waitForVisualReady(page);
        await expect(page).toHaveScreenshot(
          `first-meeting-library-${colorScheme}-${width}.png`,
          { fullPage: true, maxDiffPixels: 200 },
        );
      });
    }
  }
});
