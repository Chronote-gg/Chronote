import { expect, test } from "./fixtures";
import { mockUnifiedMeetings } from "./unifiedMeetingsMocks";
import { assertPageCanScroll } from "./scrollAssertions";

test("mobile keeps results visible and secondary filters available on demand", async ({
  page,
  libraryPage,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockUnifiedMeetings(page);
  await page.goto("/portal/meetings");
  await expect(libraryPage.firstMeeting()).toBeInViewport();
  await expect(page.getByTestId("library-range")).toBeHidden();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByTestId("library-range")).toBeVisible();
  await page.getByTestId("library-range").click();
  await page.getByRole("option", { name: "Last 90 days", exact: true }).click();
  await expect(page).toHaveURL(/range=%2290%22/);
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await expect(page.getByTestId("library-range")).toBeHidden();
});

test("default browsing, source isolation, attendance and paging survive browser history", async ({
  page,
  libraryPage,
}) => {
  await mockUnifiedMeetings(page, { member: true });
  await page.goto("/portal/meetings");
  await expect(libraryPage.meetingRows()).toHaveCount(3);
  await expect(page.getByLabel("Only meetings I attended")).not.toBeChecked();
  await expect(page.getByTestId("library-range")).toHaveValue("All time");
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(libraryPage.meetingRows()).toHaveCount(5);
  await expect(
    page
      .getByText("Previous server", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  const sources = page
    .getByRole("region", { name: "Meeting sources" })
    .filter({ visible: true });
  await sources.getByRole("button", { name: "Personal recordings" }).click();
  await expect(libraryPage.meetingRows()).toHaveCount(2);
  await expect(libraryPage.meetingRowByText("Shared interview")).toBeVisible();
  await expect(
    libraryPage.meetingRowByText("Engineering planning"),
  ).toHaveCount(0);
  await page.getByLabel("Only meetings I attended").check();
  await expect(libraryPage.meetingRows()).toHaveCount(1);
  await expect(libraryPage.meetingRowByText("Shared interview")).toBeVisible();
  await page.goBack();
  await expect(libraryPage.meetingRows()).toHaveCount(2);
  await page.goForward();
  await expect(libraryPage.meetingRows()).toHaveCount(1);
  await sources.getByRole("button", { name: "Engineering HQ" }).click();
  await page.getByLabel("Only meetings I attended").check();
  await expect(
    page.getByText("No meetings match these filters."),
  ).toBeVisible();
  await expect(page.getByTestId("first-meeting-empty-state")).toHaveCount(0);
  await page.getByLabel("Only meetings I attended").uncheck();
  await expect(libraryPage.meetingRows()).toHaveCount(1);
  await expect(
    libraryPage.meetingRowByText("Engineering planning"),
  ).toBeVisible();
  await expect(page.getByTestId("nav-settings")).toHaveAttribute(
    "data-disabled",
    "true",
  );
});

test("legacy and direct detail links preserve selection and close to the list", async ({
  page,
  libraryPage,
}) => {
  await mockUnifiedMeetings(page);
  await page.goto("/portal/server/engineering/library");
  await expect(page).toHaveURL(/\/portal\/meetings\?/);
  await expect(page.getByTestId("library-range")).toHaveValue("All time");
  await expect(libraryPage.meetingRows()).toHaveCount(1);
  await page.goto("/portal/meetings/engineering/record-0");
  await expect(libraryPage.drawer()).toBeVisible();
  await expect(libraryPage.drawer()).toContainText("Decision 1");
  await libraryPage.closeDrawer();
  await expect(libraryPage.drawer()).toBeHidden();
  await page.goBack();
  await expect(libraryPage.drawer()).toBeVisible();
  await page.goForward();
  await expect(libraryPage.drawer()).toBeHidden();
});

test("sign in returns to the requested meeting filters", async ({ page }) => {
  await mockUnifiedMeetings(page, { signedOut: true });
  await page.goto("/portal/meetings?scope=personal&attended=true");
  const link = page
    .getByRole("link", { name: "Connect Discord", exact: true })
    .last();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).not.toBeNull();
  const redirect = new URL(href!, page.url()).searchParams.get("redirect");
  expect(redirect).toContain("/portal/meetings?scope=personal&attended=true");
  await mockUnifiedMeetings(page);
  await page.goto(redirect!);
  await expect(page.getByLabel("Only meetings I attended")).toBeChecked();
  await expect(page.getByTestId("library-meeting-row")).toHaveCount(1);
});

for (const member of [true, false])
  test(`empty server setup respects ${member ? "member" : "manager"} permission`, async ({
    page,
  }) => {
    await mockUnifiedMeetings(page, { scenario: "empty", member });
    await page.goto("/portal/meetings?scope=guild&serverId=engineering");
    await expect(page.getByTestId("first-meeting-empty-state")).toBeVisible();
    await expect(page.locator('a[href*="optional-setup"]')).toHaveCount(
      member ? 0 : 1,
    );
    await page
      .getByRole("region", { name: "Meeting sources" })
      .filter({ visible: true })
      .getByRole("button", { name: "Community Studio" })
      .click();
    await expect(page.locator('a[href*="optional-setup"]')).toHaveCount(0);
  });

test("denied source settles without loading or first-meeting guidance", async ({
  page,
}) => {
  await mockUnifiedMeetings(page, { scenario: "error", member: true });
  await page.goto("/portal/meetings?scope=guild&serverId=denied");
  await expect(
    page.getByText("This source is unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("first-meeting-empty-state")).toHaveCount(0);
  await expect(page.getByTestId("library-meeting-row")).toHaveCount(0);
  await expect(page.getByTestId("library-loading")).toHaveCount(0, {
    timeout: 15000,
  });
});

for (const width of [390, 767, 768, 1280])
  test(`ordinary portal scroll boundaries at ${width}px`, async ({
    page,
    libraryPage,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await mockUnifiedMeetings(page, { scenario: "long", manySources: true });
    await page.goto("/portal/meetings");
    await expect(libraryPage.meetingRows()).toHaveCount(40);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-visual-mode",
      "true",
    );
    const content = page.getByTestId("meeting-browse-scroll");
    const sources = page
      .getByRole("region", { name: "Meeting sources" })
      .filter({ visible: true });
    await assertPageCanScroll(page, content);
    await assertPageCanScroll(page, sources);
    expect(await content.evaluate((node) => node.scrollTop)).toBe(0);
    const sourceBox = await sources.boundingBox();
    const contentBox = await page
      .getByTestId("unified-meetings-page")
      .boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (width >= 768) expect(sourceBox!.x).toBeLessThan(contentBox!.x);
    else expect(sourceBox!.x).toBeGreaterThanOrEqual(contentBox!.x);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await libraryPage.openFirstMeeting();
    await expect(libraryPage.drawer()).toContainText("Decision 1");
    await assertPageCanScroll(page, libraryPage.drawerSummaryViewport());
    await assertPageCanScroll(
      page,
      page.getByTestId("meeting-detail-compact-scroll"),
    );
    const outer = await libraryPage.drawerContent().evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
    }));
    expect(outer.content).toBeLessThanOrEqual(outer.height + 1);
  });
