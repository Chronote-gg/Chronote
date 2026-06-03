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
  job: {
    uploadId: string;
    status: "queued" | "processing" | "complete";
    meetingGuildId: string;
    channelId_timestamp: string;
  } | null;
};

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
      job: null,
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

    const desktopWindow = window as unknown as {
      __TAURI__: {
        core: {
          invoke: (command: string) => Promise<unknown>;
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
            return state.user;
          }
          if (command === "logout") {
            state.user = null;
            return null;
          }
          if (command === "start_recording") {
            state.recording = {
              isRecording: true,
              startedAt: "2025-01-01T12:00:00.000Z",
            };
            return state.recording;
          }
          if (command === "stop_and_upload_recording") {
            state.recording = { isRecording: false };
            state.job = {
              uploadId: "00000000-0000-4000-8000-000000000001",
              status: "queued",
              meetingGuildId: "personal:user-visual",
              channelId_timestamp: "personal#2025-01-01T12:00:00.000Z",
            };
            return { job: state.job };
          }
          if (command === "get_upload_status") {
            return { job: state.job };
          }
          throw new Error(`Unhandled desktop command: ${command}`);
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
    await expectDesktopScreenshot(page, "desktop-recording");

    await page.getByRole("button", { name: "Stop and upload" }).click();
    await expect(page.getByText("Upload status:")).toBeVisible();
    await expect(page.getByText("queued")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open meeting in Chronote" }),
    ).toBeVisible();
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
