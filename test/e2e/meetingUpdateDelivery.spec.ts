import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";
import type { MeetingUpdatePublicDelivery } from "../../src/services/meetingUpdateStatus";

for (const width of [1280, 390]) {
  test(`one saved import stays visible while Discord updates at ${width}px`, async ({
    page,
    libraryPage,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    const row = {
      id: "synthetic#2026-01-01",
      meetingId: "synthetic-session",
      channelId: "111111111111111111",
      channelName: "Planning",
      timestamp: "2026-01-01T00:00:00.000Z",
      duration: 600,
      tags: [],
      notes: "Original synthetic notes",
      meetingName: "Synthetic delivery check",
      audioAvailable: false,
      transcriptAvailable: true,
    };
    const notes =
      "## Saved canonical update\n" +
      Array.from(
        { length: 80 },
        (_, i) => `- Synthetic saved decision ${i + 1}.`,
      ).join("\n");
    const pending: MeetingUpdatePublicDelivery = {
      status: "pending",
      reason: null,
      pollable: true,
      desiredRevision: 2,
      syncedRevision: null,
      lastSuccess: null,
    };
    let saves = 0;
    let savedReads = 0;
    let release: (() => void) | undefined;
    const permissionToSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockFirstMeetingRequests(page, {
      "meetings.list": () => ({ meetings: [row] }),
      "meetings.importNotes": () => {
        saves++;
        return { ok: true, kind: "saved", delivery: pending };
      },
      "meetings.detail": async () => {
        if (saves) savedReads++;
        const waitingForSync = savedReads >= 2;
        if (waitingForSync) await permissionToSync;
        return {
          meeting: {
            ...row,
            status: "complete",
            notes: saves ? notes : row.notes,
            notesVersion: saves ? 2 : 1,
            events: [],
            attendees: [],
            audioAccessEnabled: false,
            transcriptAccessEnabled: true,
            updateDelivery: waitingForSync
              ? {
                  ...pending,
                  status: "synced",
                  reason: null,
                  pollable: false,
                  syncedRevision: 2,
                  lastSuccess: { at: 1767225600, contentRevision: 2 },
                }
              : saves
                ? pending
                : {
                    ...pending,
                    status: "unpublished",
                    reason: null,
                    pollable: false,
                  },
          },
        };
      },
    });
    await page.goto(`/portal/server/${mockGuilds.ddm.id}/library`);
    await libraryPage.waitForLoaded();
    await libraryPage.openFirstMeeting();
    await page.getByRole("button", { name: "Notes actions" }).click();
    await page.getByRole("menuitem", { name: "Import notes" }).click();
    const importer = page.getByRole("dialog", { name: "Import notes" });
    await importer
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill(notes);
    await importer
      .getByRole("button", { name: "Import notes", exact: true })
      .click();
    await expect(importer).toBeHidden();
    const status = page.getByTestId("meeting-update-delivery");
    await expect(status).toContainText("Saved. Updating Discord.");
    await expect(
      page.getByRole("heading", {
        name: "Saved canonical update",
        exact: true,
      }),
    ).toBeVisible();
    await expect(status).not.toContainText("Saved. Discord is up to date.");
    await expect
      .poll(() => savedReads, { timeout: 15000 })
      .toBeGreaterThanOrEqual(2);
    await expect(
      page.getByRole("heading", {
        name: "Saved canonical update",
        exact: true,
      }),
    ).toBeVisible();
    await expect(status).toContainText("Saved. Updating Discord.");
    const viewport = libraryPage.drawerSummaryViewport();
    const scroll = await viewport.evaluate((el) => {
      const canScroll = el.scrollHeight > el.clientHeight;
      el.scrollTop = 200;
      return { canScroll, top: el.scrollTop };
    });
    expect(scroll.canScroll).toBe(true);
    expect(scroll.top).toBeGreaterThan(0);
    release?.();
    await expect(status).toContainText("Saved. Discord is up to date.");
    expect(saves).toBe(1);
    await page.getByRole("button", { name: "Notes actions" }).click();
    await page.getByRole("menuitem", { name: "Edit notes" }).click();
    const editor = page.getByRole("dialog", { name: "Edit notes" });
    await editor
      .getByRole("button", { name: "Save notes" })
      .scrollIntoViewIfNeeded();
    await expect(
      editor.getByRole("button", { name: "Save notes" }),
    ).toBeInViewport();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`editor-${width}.png`),
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();
    expect(saves).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`drawer-${width}.png`),
    });
  });
}
