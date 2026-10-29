import type { Locator, Page } from "@playwright/test";
import { testIds } from "./testIds";

export class LibraryPage {
  constructor(private readonly page: Page) {}

  root(): Locator {
    return this.page.getByTestId(testIds.library.page);
  }

  searchInput(): Locator {
    return this.page.getByTestId(testIds.library.search);
  }

  refreshButton(): Locator {
    return this.page.getByRole("button", { name: "Refresh", exact: true });
  }

  archiveFilter(): Locator {
    return this.page.getByTestId(testIds.library.archiveFilter);
  }

  async selectAllTime(): Promise<void> {
    const range = this.page.getByTestId("library-range");
    if ((await range.inputValue()) === "All time") return;
    await range.click();
    await this.page.getByRole("option", { name: "All time" }).click();
  }

  async selectArchiveView(view: "active" | "archived" | "all"): Promise<void> {
    if (!(await this.archiveFilter().isVisible()))
      await this.page.getByRole("button", { name: /^Filters/ }).click();
    const label =
      view === "archived" ? "Archived" : view === "all" ? "All" : "Active";
    await this.archiveFilter().click();
    await this.page.getByRole("option", { name: label }).click();
  }

  meetingRows(): Locator {
    return this.page.getByTestId(testIds.library.meetingRow);
  }

  loadingIndicator(): Locator {
    return this.page.getByTestId(testIds.library.loading);
  }

  meetingRowByText(text: string): Locator {
    return this.meetingRows().filter({ hasText: text });
  }

  async waitForLoaded(expectedCount?: number): Promise<void> {
    await this.root().waitFor({ state: "visible" });
    await this.loadingIndicator().waitFor({ state: "hidden" });
    if (typeof expectedCount === "number") {
      if (expectedCount > 0) {
        await this.meetingRows().first().waitFor({ state: "visible" });
      }
    }
  }

  firstMeeting(): Locator {
    return this.meetingRows().first();
  }

  async openFirstMeeting(): Promise<void> {
    const row = this.firstMeeting();
    await row.click({ position: { x: 12, y: 12 } });
  }

  drawer(): Locator {
    return this.page.getByTestId(testIds.library.drawer).getByRole("dialog");
  }

  drawerContent(): Locator {
    return this.drawer().getByTestId(testIds.library.drawerContent);
  }

  drawerSummaryScroll(): Locator {
    return this.drawer().getByTestId(testIds.library.summaryScroll);
  }

  drawerSummaryViewport(): Locator {
    return this.drawer().getByTestId(testIds.library.summaryViewport);
  }

  drawerTimelineViewport(): Locator {
    return this.drawer().getByTestId(testIds.library.timelineViewport);
  }

  drawerTimelineEvents(): Locator {
    return this.drawer().locator("[data-event-id]");
  }

  drawerFullscreenToggle(): Locator {
    return this.drawer().getByTestId(testIds.library.fullscreenToggle);
  }

  drawerDownload(): Locator {
    return this.drawer().getByTestId(testIds.library.download);
  }

  drawerArchive(): Locator {
    return this.drawer().getByTestId(testIds.library.archive);
  }

  drawerUnarchive(): Locator {
    return this.drawer().getByTestId(testIds.library.unarchive);
  }

  drawerArchiveConfirm(): Locator {
    return this.page.getByTestId(testIds.library.archiveConfirm);
  }

  drawerSummaryLabel(): Locator {
    return this.drawer().getByText("Summary", { exact: true }).first();
  }

  drawerTimelineLabel(): Locator {
    return this.drawer().getByText("Transcript", { exact: true }).first();
  }

  async closeDrawer(): Promise<void> {
    await this.page.keyboard.press("Escape");
  }
}
