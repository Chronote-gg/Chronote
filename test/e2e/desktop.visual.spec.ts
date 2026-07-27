import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";

const runVisual = process.env.PW_VISUAL === "true";
const desktopUrl = "http://127.0.0.1:1420";

type DesktopMockState = {
  user: {
    id: string;
    username: string;
    avatar: string | null;
    scopes: string[];
  } | null;
  recording: {
    isRecording: boolean;
    startedAt?: string;
  };
  signals: {
    isRecording: boolean;
    sources: Array<{
      sourceId: string;
      kind: string;
      label: string;
      peakLevel: number;
      rmsLevel: number;
      sampleCount: number;
      updatedAtEpochMs: number;
    }>;
  };
  job: {
    uploadId: string;
    status: "queued" | "processing" | "complete";
    meetingGuildId?: string;
    channelIdTimestamp?: string;
  } | null;
  uploadStatusChecks: number;
};

type DesktopRecordingSignal = DesktopMockState["signals"]["sources"][number];

const expectDesktopScreenshot = async (
  page: Page,
  name: string,
): Promise<void> => {
  await waitForVisualReady(page);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    maxDiffPixels: 200,
  });
};

const installDesktopMock = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const state = {
      user: null,
      recording: { isRecording: false },
      signals: { isRecording: false, sources: [] },
      job: null,
      uploadStatusChecks: 0,
    } satisfies DesktopMockState;

    const devices = [
      {
        id: "mic-default",
        name: "USB Podcast Mic",
        direction: "input",
        isDefaultCommunications: true,
      },
      {
        id: "mic-webcam",
        name: "Webcam Microphone",
        direction: "input",
        isDefaultCommunications: false,
      },
      {
        id: "speaker-default",
        name: "Studio Headphones",
        direction: "output",
        isDefaultCommunications: true,
      },
      {
        id: "speaker-hdmi",
        name: "HDMI Display Audio",
        direction: "output",
        isDefaultCommunications: false,
      },
    ];

    const mockUser = {
      id: "user-visual",
      username: "Visual Tester",
      avatar: null,
      scopes: ["profile:read", "personal_uploads:write", "meetings:read"],
    };
    const signalListeners = new Set<
      (event: { payload: DesktopRecordingSignal }) => void
    >();
    let signalTimer: number | undefined;

    const emitSignals = () => {
      for (const source of state.signals.sources) {
        for (const listener of signalListeners) {
          listener({
            payload: {
              ...source,
              updatedAtEpochMs: Date.now(),
            },
          });
        }
      }
    };

    const stopSignals = () => {
      if (signalTimer !== undefined) {
        window.clearInterval(signalTimer);
        signalTimer = undefined;
      }
    };

    const startSignals = () => {
      stopSignals();
      signalTimer = window.setInterval(emitSignals, 33);
      window.setTimeout(emitSignals, 0);
    };

    const desktopWindow = window as unknown as {
      __TAURI__: {
        core: {
          invoke: (command: string) => Promise<unknown>;
        };
        event: {
          listen: (
            event: string,
            handler: (event: { payload: DesktopRecordingSignal }) => void,
          ) => Promise<() => void>;
        };
      };
    };

    desktopWindow.__TAURI__ = {
      core: {
        async invoke(command: string) {
          if (command === "get_session") return state.user;
          if (command === "get_recording_status") return state.recording;
          if (command === "list_audio_devices") return devices;
          if (command === "login") {
            state.user = mockUser;
            return {
              user: state.user,
              sessionPersisted: true,
            };
          }
          if (command === "logout") {
            state.user = null;
            return null;
          }
          if (command === "list_retained_recordings") {
            return [];
          }
          if (command === "start_recording") {
            state.recording = {
              isRecording: true,
              startedAt: "2025-01-01T12:00:00.000Z",
            };
            state.signals = {
              isRecording: true,
              sources: [
                {
                  sourceId: "owner_mic",
                  kind: "owner_mic",
                  label: "Me",
                  peakLevel: 0.74,
                  rmsLevel: 0.24,
                  sampleCount: 48000,
                  updatedAtEpochMs: Date.now(),
                },
                {
                  sourceId: "system_output",
                  kind: "system_output",
                  label: "System/Other",
                  peakLevel: 0.41,
                  rmsLevel: 0.16,
                  sampleCount: 48000,
                  updatedAtEpochMs: Date.now(),
                },
              ],
            };
            startSignals();
            return state.recording;
          }
          if (command === "stop_and_upload_recording") {
            state.recording = { isRecording: false };
            state.signals = { isRecording: false, sources: [] };
            stopSignals();
            state.job = {
              uploadId: "00000000-0000-4000-8000-000000000001",
              status: "queued",
            };
            return { job: state.job };
          }
          if (command === "get_upload_status") {
            state.uploadStatusChecks += 1;
            state.job = {
              uploadId: "00000000-0000-4000-8000-000000000001",
              status: state.uploadStatusChecks >= 3 ? "complete" : "processing",
              meetingGuildId:
                state.uploadStatusChecks >= 2
                  ? "personal:user-visual"
                  : undefined,
              channelIdTimestamp:
                state.uploadStatusChecks >= 2
                  ? "personal#2025-01-01T12:00:00.000Z"
                  : undefined,
            };
            return { job: state.job };
          }
          throw new Error(`Unhandled desktop command: ${command}`);
        },
      },
      event: {
        async listen(event, handler) {
          if (event !== "recording-source-signal") {
            throw new Error(`Unhandled desktop event: ${event}`);
          }
          signalListeners.add(handler);
          return () => signalListeners.delete(handler);
        },
      },
    };
  });
};

test.describe("desktop visual regression", () => {
  test.skip(!runVisual, "Visual regression disabled");

  test.use({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    contextOptions: {
      reducedMotion: "reduce",
    },
  });

  test.beforeEach(async ({ page }) => {
    await applyVisualDefaults(page);
    await installDesktopMock(page);
  });

  test("desktop recorder flow @visual", async ({ page }) => {
    await page.goto(desktopUrl);
    await expect(
      page.getByRole("heading", {
        name: "Sign in to record",
      }),
    ).toBeVisible();
    await expectDesktopScreenshot(page, "desktop-signed-out");

    await page.getByRole("button", { name: "Sign in with Chronote" }).click();
    await expect(page.getByRole("heading", { name: "Recorder" })).toBeVisible();
    await expect(page.getByText("Signed in as Visual Tester")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Chronote meetings" }),
    ).toHaveAttribute("href", "http://127.0.0.1:5173/portal/meetings");
    await page.getByLabel("Title").fill("Design review");
    await page.getByLabel("Tags").fill("desktop, visual");
    await expectDesktopScreenshot(page, "desktop-ready");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Microphone").selectOption("mic-default");
    await page.getByLabel("System output").selectOption("speaker-default");
    await expectDesktopScreenshot(page, "desktop-settings");
    await page.getByRole("button", { name: "Hide settings" }).click();

    await page.getByRole("button", { name: "Record" }).click();
    await expect(
      page.getByRole("button", { name: "Stop and upload" }),
    ).toBeVisible();
    await expect(page.getByText("Recording started.")).toBeVisible();
    await expect(page.getByLabel("Mic signal level")).toHaveAttribute(
      "aria-valuenow",
      "74",
    );
    await expect(page.getByLabel("System/Other signal level")).toHaveAttribute(
      "aria-valuenow",
      "41",
    );
    await expectDesktopScreenshot(page, "desktop-recording");

    await page.getByRole("button", { name: "Stop and upload" }).click();
    await expect(page.getByText("Upload received.")).toBeVisible();
    await expect(
      page.getByText(
        "Processing your meeting. This will update when notes are ready.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Checking processing status...")).toBeVisible();
    await expectDesktopScreenshot(page, "desktop-processing");
    await expect(
      page.getByText("Your meeting is processing. You can open it now."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open created meeting" }),
    ).toHaveAttribute(
      "href",
      "http://127.0.0.1:5173/portal/meetings/personal%3Auser-visual/personal%232025-01-01T12%3A00%3A00.000Z",
    );
    await expectDesktopScreenshot(page, "desktop-processing-linked");
    await expect(page.getByText("Your meeting is ready.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open created meeting" }),
    ).toHaveAttribute(
      "href",
      "http://127.0.0.1:5173/portal/meetings/personal%3Auser-visual/personal%232025-01-01T12%3A00%3A00.000Z",
    );
    await expectDesktopScreenshot(page, "desktop-uploaded");
  });

  test("desktop recorder narrow layout @visual", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(desktopUrl);
    await page.getByRole("button", { name: "Sign in with Chronote" }).click();
    await expect(page.getByText("Signed in as Visual Tester")).toBeVisible();
    await expectDesktopScreenshot(page, "desktop-mobile-ready");
  });
});
