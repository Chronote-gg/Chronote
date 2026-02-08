import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";

test.describe("meeting detail scroll", () => {
  test("fullscreen transcript timeline scrolls (desktop)", async ({
    serverSelectPage,
    libraryPage,
    page,
  }) => {
    await page.goto("/portal/select-server");
    await serverSelectPage.openServerByName(mockGuilds.ddm.name);
    await libraryPage.waitForLoaded();

    await libraryPage.openFirstMeeting();
    const drawerDialog = page.getByRole("dialog");
    await expect(drawerDialog).toBeVisible();

    await page.getByTestId("meeting-fullscreen-toggle").click();

    const timelineViewport = page.getByTestId(
      "meeting-timeline-scroll-viewport",
    );
    await expect(timelineViewport).toBeVisible();

    const drawerBox = await drawerDialog.boundingBox();
    expect(drawerBox).not.toBeNull();

    const metrics = await timelineViewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    expect(metrics.clientHeight).toBeLessThanOrEqual(drawerBox!.height);
    if (metrics.scrollHeight > metrics.clientHeight) {
      await timelineViewport.evaluate((el) => {
        el.scrollTo({ top: 500 });
      });

      await expect
        .poll(async () => timelineViewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(metrics.scrollTop);
    }
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

    await page.getByTestId("meeting-fullscreen-toggle").click();

    const timelineViewport = page.getByTestId(
      "meeting-timeline-scroll-viewport",
    );
    await expect(timelineViewport).toBeVisible();

    const drawerBox = await drawerDialog.boundingBox();
    expect(drawerBox).not.toBeNull();

    const metrics = await timelineViewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    expect(metrics.clientHeight).toBeLessThanOrEqual(drawerBox!.height);
    if (metrics.scrollHeight > metrics.clientHeight) {
      await timelineViewport.evaluate((el) => {
        el.scrollTo({ top: 500 });
      });

      await expect
        .poll(async () => timelineViewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(metrics.scrollTop);
    }
  });
});
