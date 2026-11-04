import { expect, test } from "./fixtures";
import { mockUnifiedMeetings } from "./unifiedMeetingsMocks";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import type { UnifiedScenario } from "../../src/frontend/storybook/unifiedMeetingsFixtures";
const viewports = [
  { width: 1280, height: 720 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 1920, height: 1080 },
];
const states: Array<{
  name: string;
  path?: string;
  scenario?: UnifiedScenario;
  manySources?: boolean;
}> = [
  { name: "all" },
  { name: "empty", scenario: "empty" },
  { name: "server", path: "scope=guild&serverId=engineering" },
  { name: "personal", path: "scope=personal" },
  { name: "attended", path: "attended=true" },
  {
    name: "server-empty",
    path: "scope=guild&serverId=engineering",
    scenario: "empty",
  },
  { name: "personal-empty", path: "scope=personal", scenario: "empty" },
  { name: "filtered-empty", path: "scope=personal&q=unmatched" },
  { name: "retained", path: "scope=guild&serverId=previous" },
  { name: "denied", path: "scope=guild&serverId=denied", scenario: "error" },
  { name: "error", scenario: "error" },
  { name: "loading", scenario: "loading" },
  { name: "drawer", path: "meetingServerId=engineering&meetingId=record-0" },
  { name: "long-sources", manySources: true, scenario: "long" },
];
test.describe("unified Meetings", () => {
  test.skip(process.env.PW_VISUAL !== "true", "Visual regression disabled");
  test.use({
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
  });
  for (const viewport of viewports)
    for (const theme of ["dark", "light"] as const)
      for (const state of states) {
        if (
          theme === "light" &&
          ["retained", "loading", "error", "denied", "long-sources"].includes(
            state.name,
          )
        )
          continue;
        test(`${state.name} ${theme} ${viewport.width} @visual`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          await applyVisualDefaults(page);
          await page.addInitScript(
            (scheme) =>
              localStorage.setItem("mantine-color-scheme-value", scheme),
            theme,
          );
          const releaseRequests = await mockUnifiedMeetings(page, state);
          try {
            for (const mode of ["viewport", "full"] as const) {
              await page.goto(
                `/portal/meetings?${state.path ?? ""}&visual=${mode === "full" ? "1" : "0"}`,
              );
              await expect(
                page.getByTestId("unified-meetings-page"),
              ).toBeVisible();
              if (state.name === "drawer")
                await expect(page.getByTestId("meeting-drawer")).toContainText(
                  "Decision 1",
                );
              if (state.scenario === "error")
                await expect(
                  page.getByText("Unable to load meetings. Try again shortly."),
                ).toBeVisible({ timeout: 15000 });
              if (state.name !== "loading") await waitForVisualReady(page);
              else
                await expect(page.getByTestId("library-loading")).toBeVisible();
              expect(
                await page.evaluate(() => ({
                  width: document.documentElement.scrollWidth,
                  viewport: innerWidth,
                  overflow: [...document.querySelectorAll("*")]
                    .filter(
                      (el) => el.getBoundingClientRect().right > innerWidth + 1,
                    )
                    .slice(0, 8)
                    .map((el) => ({
                      tag: el.tagName,
                      cls: el.className,
                      right: el.getBoundingClientRect().right,
                    })),
                })),
              ).toEqual(expect.objectContaining({ width: viewport.width }));
              await expect(page).toHaveScreenshot(
                `unified-${state.name}-${theme}-${viewport.width}-${mode}.png`,
                { fullPage: mode === "full", maxDiffPixels: 2000 },
              );
            }
          } finally {
            await releaseRequests();
          }
        });
      }
});
