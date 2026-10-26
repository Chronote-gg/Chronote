import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";

test.describe("meeting detail scroll", () => {
  test("fullscreen transcript timeline scrolls (desktop)", async ({
    serverSelectPage,
    libraryPage,
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto("/portal/select-server");
    await serverSelectPage.openServerByName(mockGuilds.ddm.name);
    await libraryPage.waitForLoaded();

    await libraryPage.openFirstMeeting();
    const drawerDialog = page.getByRole("dialog");
    await expect(drawerDialog).toBeVisible();

    await libraryPage.drawerFullscreenToggle().click();

    const timelineViewport = libraryPage.drawerTimelineViewport();
    await expect(timelineViewport).toBeVisible();
    await expect(libraryPage.drawerTimelineEvents().first()).toBeVisible();

    const leftScrollArea = page.getByTestId("meeting-detail-left-scroll");
    await expect(leftScrollArea).toBeVisible();

    const drawerBox = await drawerDialog.boundingBox();
    expect(drawerBox).not.toBeNull();

    const leftBox = await leftScrollArea.boundingBox();
    const rightBox = await timelineViewport.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();
    // At desktop sizes we expect the fullscreen layout to stay side-by-side
    // (not stacked), so the transcript viewport should overlap the left panel
    // vertically.
    expect(rightBox!.y).toBeLessThan(leftBox!.y + leftBox!.height);

    const metrics = await timelineViewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    expect(metrics.clientHeight).toBeLessThanOrEqual(drawerBox!.height);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await timelineViewport.hover();
    await page.mouse.wheel(0, 600);

    await expect
      .poll(async () => timelineViewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(metrics.scrollTop);
  });

  test("fullscreen transcript timeline scrolls (mobile)", async ({
    serverSelectPage,
    libraryPage,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/portal/select-server");
    await serverSelectPage.openServerByName(mockGuilds.ddm.name);
    await libraryPage.waitForLoaded();

    await libraryPage.openFirstMeeting();
    const drawerDialog = page.getByRole("dialog");
    await expect(drawerDialog).toBeVisible();

    await libraryPage.drawerFullscreenToggle().click();

    const timelineViewport = libraryPage.drawerTimelineViewport();
    await expect(timelineViewport).toBeVisible();
    await expect(libraryPage.drawerTimelineEvents().first()).toBeVisible();

    const drawerBox = await drawerDialog.boundingBox();
    expect(drawerBox).not.toBeNull();

    const metrics = await timelineViewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    expect(metrics.clientHeight).toBeLessThanOrEqual(drawerBox!.height);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await timelineViewport.hover();
    await page.mouse.wheel(0, 600);

    await expect
      .poll(async () => timelineViewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(metrics.scrollTop);
  });
});

for (const visual of ["0", "1"]) {
  test(`compact summary keeps its real scroll boundary with visual=${visual}`, async ({
    page,
    libraryPage,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const sentinel = "Final bounded capture note";
    const meeting = {
      id: "capture-containment#2026-01-01",
      meetingId: "capture-containment-session",
      meetingName: "Bounded capture review",
      channelId: "111111111111111111",
      channelName: "Planning",
      timestamp: "2026-01-01T00:00:00.000Z",
      duration: 600,
      tags: [],
      notes:
        Array.from(
          { length: 40 },
          (_, index) => `- Capture decision ${index + 1} remains readable.`,
        ).join("\n") + `\n\n${sentinel}`,
    };
    await mockFirstMeetingRequests(page, {
      "meetings.list": () => ({ meetings: [meeting] }),
      "meetings.detail": () => ({
        meeting: {
          ...meeting,
          status: "complete",
          summarySentence:
            "A readable summary with all remaining notes available below.",
          notesVersion: 1,
          attendees: ["Speaker A", "Speaker B"],
          events: [],
          audioAccessEnabled: false,
          transcriptAccessEnabled: true,
          updateDelivery: {
            status: "held",
            reason: "initial_publication_unsettled",
            pollable: false,
            desiredRevision: 1,
            syncedRevision: null,
            lastSuccess: null,
          },
        },
      }),
    });
    await page.goto(
      `/portal/server/${mockGuilds.ddm.id}/library?visual=${visual}`,
    );
    await libraryPage.waitForLoaded();
    await libraryPage.openFirstMeeting();
    await expect(page.getByTestId("meeting-update-delivery")).toContainText(
      "Saved. Publication is on hold",
    );
    await expect
      .poll(() => page.locator("html").getAttribute("data-visual-mode"))
      .toBe(visual === "1" ? "true" : null);

    const viewport = libraryPage.drawerSummaryViewport();
    const panel = page.getByTestId("meeting-summary-scroll").locator("..");
    const attendees = page
      .getByText("Attendees", { exact: true })
      .locator("../..");
    const metrics = await viewport.evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
    }));
    expect(["auto", "scroll"]).toContain(metrics.overflowY);
    expect(metrics.height).toBeGreaterThan(64);
    expect(metrics.content).toBeGreaterThan(metrics.height);
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(metrics.top).toBeGreaterThanOrEqual(panelBox!.y);
    expect(metrics.bottom).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
    await expect(
      page.getByRole("button", { name: "Copy summary as Markdown" }),
    ).toBeInViewport();
    await expect(
      page.getByText("Capture decision 1 remains readable.", {
        exact: true,
      }),
    ).toBeInViewport();

    const lastNote = page.getByText(sentinel, { exact: true });
    await expect(lastNote).not.toBeInViewport();
    await viewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(lastNote).toBeInViewport();
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(lastNote).not.toBeInViewport();

    const outer = page.getByTestId("meeting-detail-compact-scroll");
    const outerMetrics = await outer.evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
    }));
    expect(outerMetrics.content).toBeGreaterThan(outerMetrics.height);
    await outer.evaluate((node) => {
      node.scrollTop = 60;
    });
    await expect
      .poll(() => outer.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await outer.evaluate((node) => {
      node.scrollTop = 0;
    });

    const summaryBox = await panel.boundingBox();
    const attendeesBox = await attendees.boundingBox();
    expect(summaryBox).not.toBeNull();
    expect(attendeesBox).not.toBeNull();
    expect(attendeesBox!.y).toBeGreaterThanOrEqual(
      summaryBox!.y + summaryBox!.height,
    );
    await expect(attendees).toBeInViewport();
    expect(attendeesBox!.y + attendeesBox!.height).toBeLessThanOrEqual(720);
    await page.screenshot({
      path: testInfo.outputPath(`bounded-summary-visual-${visual}.png`),
      clip: {
        x: summaryBox!.x,
        y: summaryBox!.y,
        width: summaryBox!.width,
        height: attendeesBox!.y + attendeesBox!.height - summaryBox!.y,
      },
    });
  });
}
