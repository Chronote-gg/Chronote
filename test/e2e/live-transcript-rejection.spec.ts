import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";
import { buildLiveMeetingTimelineEvents } from "../../src/services/meetingTimelineService";
import {
  createSpeechCoverage,
  DEFAULT_SPEECH_POLICY,
} from "../../src/services/speechDetectionPolicy";
import type { MeetingData } from "../../src/types/meeting-data";
import type { AudioFileData } from "../../src/types/audio";

// Browser acceptance uses the committed timeline, hook and both existing entry paths.
// A local SSE producer sends real timeline projections before/after a synthetic rejection.
for (const entry of ["live page", "dashboard"] as const) {
  test(`final rejection removes the fast guess from the ${entry}`, async ({
    page,
    serverSelectPage,
    nav,
    libraryPage,
  }) => {
    const pcm = Buffer.alloc(192000, 7);
    const originalPcm = Buffer.from(pcm);
    const file: AudioFileData = {
      userId: "synthetic-user",
      timestamp: Date.parse("2025-01-01T00:00:10Z"),
      transcript: "Synthetic fast guess to remove",
      processing: true,
      audioOnlyProcessing: false,
    };
    const retained: AudioFileData = {
      ...file,
      timestamp: file.timestamp + 10000,
      transcript: "Retained synthetic speech",
    };
    const meeting = {
      guildId: mockGuilds.ddm.id,
      channelId: "synthetic-voice",
      meetingId: "synthetic-meeting",
      startTime: new Date("2025-01-01T00:00:00Z"),
      chatLog: [],
      audioData: { currentSnippets: new Map(), audioFiles: [file, retained] },
      participants: new Map([
        [
          "synthetic-user",
          { id: "synthetic-user", username: "Synthetic speaker" },
        ],
      ]),
      guild: {
        members: { cache: new Map() },
        client: { users: { cache: new Map() } },
      },
      transcribeMeeting: true,
      generateNotes: true,
    } as unknown as MeetingData;
    const before = buildLiveMeetingTimelineEvents(meeting);
    const guess = before.find((event) => event.text === file.transcript)!;
    const kept = before.find((event) => event.text === retained.transcript)!;
    const clients = new Set<ServerResponse>();
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "http://127.0.0.1:5173",
        "Access-Control-Allow-Credentials": "true",
      });
      response.write(
        `event: init\ndata: ${JSON.stringify({ meeting: { guildId: meeting.guildId, meetingId: meeting.meetingId, channelId: meeting.channelId, channelName: "Synthetic meeting", startedAt: meeting.startTime.toISOString(), isAutoRecording: false, status: "in_progress", attendees: [] }, events: before })}\n\n`,
      );
      clients.add(response);
      response.on("close", () => clients.delete(response));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing synthetic SSE address");
    await page.addInitScript((url) => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(source: string | URL, options?: EventSourceInit) {
          super(String(source).includes("/api/live/") ? url : source, options);
        }
      };
    }, `http://127.0.0.1:${address.port}/stream`);
    try {
      if (entry === "live page") {
        await page.goto(`/live/${meeting.guildId}/${meeting.meetingId}`);
        await expect(page.getByTestId("live-meeting-page")).toBeVisible();
      } else {
        await page.route("**/trpc/meetings.detail*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const entries = Array.isArray(body) ? body : [body];
          for (const entry of entries) {
            const data = entry.result?.data?.json ?? entry.result?.data;
            if (data?.meeting)
              Object.assign(data.meeting, {
                status: "in_progress",
                transcriptAccessEnabled: true,
                events: [],
                notes: "",
              });
          }
          await route.fulfill({
            response,
            json: Array.isArray(body) ? entries : entries[0],
          });
        });
        await serverSelectPage.goto();
        await serverSelectPage.openServerByName(mockGuilds.ddm.name);
        await nav.goToLibrary();
        await libraryPage.waitForLoaded(1);
        await libraryPage.openFirstMeeting();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page
          .getByRole("button", { name: "Open fullscreen", exact: true })
          .first()
          .click();
      }
      const guessRow = page.locator(`[data-event-id="${guess.id}"]`);
      const retainedRow = page.locator(`[data-event-id="${kept.id}"]`);
      await expect(guessRow).toContainText("Synthetic fast guess to remove");
      await expect(retainedRow).toContainText("Retained synthetic speech");
      expect(guess.offsetSeconds).toBe(10);
      expect(kept.offsetSeconds).toBe(20);
      file.finalSpeechRejection = createSpeechCoverage(
        pcm,
        DEFAULT_SPEECH_POLICY.policyFingerprint,
      );
      file.slowTranscript = "";
      file.coalescedTranscript = "older guess";
      file.finalPassTranscript = "late guess";
      const after = buildLiveMeetingTimelineEvents(meeting);
      const ids = new Set(after.map((event) => event.id));
      const removedEventIds = before
        .filter((event) => !ids.has(event.id))
        .map((event) => event.id);
      expect(removedEventIds).toEqual([guess.id]);
      const payload = `event: events\ndata: ${JSON.stringify({ events: after, removedEventIds })}\n\n`;
      for (const client of clients) client.write(payload);
      await expect(guessRow).toHaveCount(0);
      await expect(
        page.getByText("Synthetic fast guess to remove", { exact: true }),
      ).toHaveCount(0);
      await expect(retainedRow).toContainText("Retained synthetic speech");
      expect(after.find((event) => event.id === kept.id)?.offsetSeconds).toBe(
        20,
      );
      expect(file.timestamp).toBe(Date.parse("2025-01-01T00:00:10Z"));
      expect(pcm).toEqual(originalPcm);
    } finally {
      for (const client of clients) client.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}
