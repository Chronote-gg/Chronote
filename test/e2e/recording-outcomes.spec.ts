import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
test.beforeEach(async ({ page }) => {
  await applyVisualDefaults(page);
});
const capture = {
  kind: "interrupted",
  startedAt: "2026-01-01T00:00:00Z",
  detectedAt: "2026-01-01T01:00:00Z",
  endedAt: null,
};
const captureNotice =
  "Partial notes: recording was interrupted. These notes cover only the saved recording. Saved recording coverage is unknown. The exact recording end time is unknown.";
const recoveryNotice = "Saved recording recovery finished.";
const notes = Array.from(
  { length: 24 },
  (_, index) => `- Generated saved decision ${index + 1}.`,
).join("\n");

test("interrupted library detail keeps warning and scrolls saved notes", async ({
  page,
  serverSelectPage,
  nav,
  libraryPage,
}) => {
  await page.route("**/trpc/*", async (route) => {
    const paths =
      new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ??
      [];
    if (
      !paths.some(
        (path) =>
          path === "meetings.list" ||
          path === "meetings.myList" ||
          path === "meetings.detail",
      )
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    for (const entry of payload) {
      const data = entry.result?.data;
      const meetings = data?.meetings ?? (data?.meeting ? [data.meeting] : []);
      for (const meeting of meetings)
        Object.assign(meeting, {
          status: "interrupted",
          capture,
          captureNotice,
          recoveryNotice,
          notes,
          summarySentence: "Generated saved conversation.",
          transcriptAccessEnabled: false,
          audioAccessEnabled: false,
        });
    }
    await route.fulfill({ response, json: payload });
  });
  await serverSelectPage.goto();
  await serverSelectPage.openServerByName(mockGuilds.ddm.name);
  await nav.goToLibrary();
  await libraryPage.waitForLoaded();
  await expect(
    page.getByText("Interrupted", { exact: true }).first(),
  ).toBeVisible();
  await libraryPage.openFirstMeeting();
  const viewport = page.getByTestId("meeting-summary-scroll-viewport");
  await expect(
    viewport.getByText(captureNotice, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await viewport.evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-library-journey.png",
    fullPage: true,
  });
});

test("direct public share shows deterministic warning above generated notes", async ({
  page,
}) => {
  await page.route("**/trpc/*", async (route) => {
    const paths =
      new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ??
      [];
    if (!paths.some((path) => path.startsWith("meetingShares."))) {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: paths.map(() => ({
        result: {
          data: {
            meeting: {
              title: "Generated interrupted meeting",
              timestamp: "2026-01-01T00:00:00Z",
              duration: 0,
              notes,
              tags: [],
              attendees: ["Generated participant"],
              events: [],
              transcript: "",
              transcriptAccessEnabled: false,
              capture,
              captureNotice,
              recoveryNotice,
            },
            share: { shareId: "generated", visibility: "public" },
          },
        },
      })),
    });
  });
  await page.goto(`/share/meeting/${mockGuilds.ddm.id}/generated`);
  await expect(page.getByText(captureNotice, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unknown duration", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Generated saved decision 24.", { exact: false }),
  ).toBeVisible();
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-share-journey.png",
    fullPage: true,
  });
});

test("direct live link distinguishes interruption and unavailable status, then rechecks", async ({
  page,
}) => {
  let connections = 0;
  await page.route("**/api/live/*/*/stream", async (route) => {
    connections += 1;
    const status = connections === 1 ? "unavailable" : "interrupted";
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: init\ndata: ${JSON.stringify({ meeting: { guildId: mockGuilds.ddm.id, meetingId: "generated", channelId: "generated", channelName: "Generated voice", startedAt: "2026-01-01T00:00:00Z", isAutoRecording: false, status, attendees: [], ...(status === "interrupted" ? { capture, captureNotice, recoveryNotice: "Recovering saved recording." } : {}) }, events: [] })}\n\n`,
    });
  });
  await page.goto(`/live/${mockGuilds.ddm.id}/generated`);
  await expect(
    page.getByText("Status unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Complete", { exact: true })).toHaveCount(0);
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-live-unavailable-journey.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText(captureNotice, { exact: true })).toBeVisible();
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-live-interrupted-journey.png",
    fullPage: true,
  });
});
