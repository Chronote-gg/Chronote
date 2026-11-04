import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
test.beforeEach(async ({ page }) => {
  await applyVisualDefaults(page);
});
const capture = {
  kind: "interrupted",
  startedAt: "2026-01-01T00:00:00Z",
  detectedAt: "2026-01-01T00:30:00Z",
  endedAt: null,
};
test("My Meetings shows unknown duration and terminal empty recovery before direct detail entry", async ({
  page,
}) => {
  await page.route("**/trpc/*", async (route) => {
    const paths =
      new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ??
      [];
    if (!paths.includes("meetings.myList")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    for (const entry of payload) {
      const meetings = entry.result?.data?.meetings;
      if (!meetings) continue;
      entry.result.data.meetings = ["disabled", "no_usable_speech"].map(
        (outcome, index) => ({
          ...meetings[index % meetings.length],
          id: "generated-" + outcome + "#2026-01-01",
          meetingId: "generated-" + outcome,
          meetingName:
            "Generated " + (index === 0 ? "disabled notes" : "no speech"),
          status: "interrupted",
          duration: 0,
          capture,
          summarySentence: "",
          notes: "",
          notesAvailable: false,
          recoveryNotice:
            outcome === "disabled"
              ? "Recovery finished with the original transcription and notes settings."
              : "No usable saved speech was found.",
          recovery: { disposition: "done", stage: "notes", outcome },
        }),
      );
    }
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/portal/meetings");
  await expect(
    page.getByText("Unknown duration", { exact: false }),
  ).toHaveCount(2);
  await expect(
    page.getByText("Notes will appear after the meeting is processed.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Recovery finished with the original transcription and notes settings.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("No usable saved speech was found.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 960 });
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-fix1-my-meetings-journey.png",
    fullPage: true,
  });
  await expect(
    page.getByText("No summary available.", { exact: true }),
  ).toHaveCount(2);
  await page.getByTestId("library-meeting-row").nth(1).scrollIntoViewIfNeeded();
  await waitForVisualReady(page);
  await page.screenshot({
    path: "test/storybook/screenshots/r5-fix1-my-meetings-no-speech-journey.png",
    fullPage: true,
  });
  await page.getByTestId("library-meeting-row").first().click();
  await expect(page).toHaveURL((url) => {
    const serverId = url.searchParams.get("meetingServerId");
    return (
      url.pathname === "/portal/meetings" &&
      (serverId === mockGuilds.ddm.id ||
        serverId === JSON.stringify(mockGuilds.ddm.id)) &&
      url.searchParams.get("meetingId") === "generated-disabled#2026-01-01"
    );
  });
  await expect(
    page.getByTestId("meeting-drawer").getByRole("dialog"),
  ).toBeVisible();
});
test("detail unavailable survives unchanged history, rechecks and displays the returning owner", async ({
  page,
  serverSelectPage,
  nav,
  libraryPage,
}) => {
  let reads = 0,
    connections = 0;
  await page.route("**/trpc/*", async (route) => {
    const paths =
      new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ??
      [];
    if (
      !paths.some(
        (path) => path === "meetings.list" || path === "meetings.detail",
      )
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    for (const entry of payload) {
      const data = entry.result?.data;
      if (data?.meeting) reads += 1;
      for (const meeting of data?.meetings ??
        (data?.meeting ? [data.meeting] : []))
        Object.assign(meeting, {
          status: "in_progress",
          meetingName: "Generated owner recheck",
          notes: "",
          summarySentence: "",
          transcriptAccessEnabled: true,
          audioAccessEnabled: false,
          attendees: [],
          events: [],
        });
    }
    await route.fulfill({ response, json: payload });
  });
  const responses = new Set<ServerResponse>();
  const stream = createServer((_request, response) => {
    connections += 1;
    const status = connections === 1 ? "unavailable" : "in_progress";
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "http://127.0.0.1:5173",
      "Access-Control-Allow-Credentials": "true",
    });
    response.write(
      "event: init\ndata: " +
        JSON.stringify({
          meeting: {
            guildId: mockGuilds.ddm.id,
            meetingId: "generated",
            channelId: "generated",
            channelName: "Generated",
            startedAt: "2026-01-01T00:00:00Z",
            status,
            isAutoRecording: false,
            attendees: [],
          },
          events: [],
        }) +
        "\n\n",
    );
    responses.add(response);
    response.on("close", () => responses.delete(response));
    if (status === "unavailable") response.end();
  });
  await new Promise<void>((resolve) => stream.listen(0, "127.0.0.1", resolve));
  const address = stream.address();
  if (!address || typeof address === "string")
    throw new Error("Generated SSE fixture needs a loopback port");
  await page.route("**/api/live/*/*/stream", (route) =>
    route.continue({
      url: "http://127.0.0.1:" + address.port + "/generated-stream",
    }),
  );
  try {
    await serverSelectPage.goto();
    await serverSelectPage.openServerByName(mockGuilds.ddm.name);
    await nav.goToLibrary();
    await libraryPage.waitForLoaded();
    await libraryPage.openFirstMeeting();
    const drawer = page.getByTestId("meeting-drawer");
    await expect(
      drawer.getByText("Status unavailable", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(
      drawer.getByText("Live transcript", { exact: true }),
    ).toHaveCount(0);
    await expect(
      drawer.getByText("Notes will appear after the meeting is processed.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await waitForVisualReady(page);
    await page.screenshot({
      path: "test/storybook/screenshots/r5-fix1-detail-unavailable-journey.png",
      fullPage: true,
    });
    await drawer.getByTestId("meeting-fullscreen-toggle").click();
    await expect(
      drawer.getByText(
        "Recording status cannot be confirmed. Recheck to resume live updates.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      drawer.getByText("Waiting for the first transcript line...", {
        exact: true,
      }),
    ).toHaveCount(0);
    await waitForVisualReady(page);
    await page.screenshot({
      path: "test/storybook/screenshots/r5-fix1-detail-fullscreen-unavailable.png",
      fullPage: true,
    });
    await drawer
      .getByRole("button", { name: "Recheck recording status", exact: true })
      .click();
    await expect(
      drawer.getByText("Live transcript", { exact: true }),
    ).toBeVisible();
    await expect(
      drawer.getByText("Status unavailable", { exact: true }),
    ).toHaveCount(0);
    await expect(
      drawer.getByRole("button", {
        name: "Recheck recording status",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect.poll(() => connections).toBe(2);
    await waitForVisualReady(page);
    await page.screenshot({
      path: "test/storybook/screenshots/r5-fix1-detail-returning-owner.png",
      fullPage: true,
    });
  } finally {
    for (const response of responses) response.end();
    await new Promise<void>((resolve, reject) =>
      stream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
