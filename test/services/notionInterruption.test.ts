/** @jest-environment node */
import * as db from "../../src/db";
import { registerNotionMutationTracker } from "../../src/services/notionOperationLifetime";
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import {
  fenceRuntimeWorkAdmission,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
import { updateMeetingNotesService } from "../../src/services/meetingHistoryService";
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
const mockApiSettled = jest.fn();
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ transition: () => {}, settle: mockApiSettled }),
  getRuntimeAdmissionContext: async () => ({ instanceId: "synthetic-api" }),
}));
import { config } from "../../src/services/configService";
import {
  getNotionIntegrationRepository,
  resetNotionIntegrationMemoryRepository,
} from "../../src/repositories/notionIntegrationRepository";
import {
  saveNotionConnectionFromCode,
  setNotionFetchForTests,
  resetNotionFetchForTests,
} from "../../src/services/notionService";
import {
  maybeAutoExportCompletedMeeting,
  maybeAutoSyncMeetingNotes,
} from "../../src/services/notionAutomationService";
import { UnresolvedNotionMutation } from "../../src/services/notionOperationLifetime";
import type { MeetingHistory } from "../../src/types/db";
const meeting = {
  guildId: "synthetic-notion",
  channelId_timestamp: "synthetic#2026-01-01",
  meetingId: "synthetic-notion",
  channelId: "synthetic",
  timestamp: "2026-01-01T00:00:00Z",
  notes: "Synthetic notes",
  notesVersion: 2,
  participants: [],
  duration: 1,
  transcribeMeeting: true,
  generateNotes: true,
} satisfies MeetingHistory;
async function fixture() {
  jest.spyOn(db, "getDeploymentControlRepository").mockReturnValue({
    ...db.getDeploymentControlRepository(),
    checkAdmission: jest.fn(async () => ({ kind: "admitted" as const })),
  });
  resetNotionIntegrationMemoryRepository();
  jest.spyOn(config.notion, "enabled", "get").mockReturnValue(true);
  const fetch = jest.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        access_token: "synthetic",
        refresh_token: "synthetic",
        bot_id: "synthetic",
        workspace_id: "synthetic",
        workspace_name: "Synthetic",
        workspace_icon: null,
      }),
    ),
  );
  setNotionFetchForTests(fetch);
  await saveNotionConnectionFromCode({
    userId: "synthetic",
    code: "synthetic",
  });
  const repository = getNotionIntegrationRepository();
  await repository.writeAutomationConfig({
    guildId: meeting.guildId,
    ownerUserId: "synthetic",
    workspaceId: "synthetic",
    destinationType: "page",
    destinationPageId: "synthetic-parent",
    autoExportEnabled: true,
    createdAt: "now",
    updatedAt: "now",
  });
  return {
    fetch,
    repository,
    key: { guildId: meeting.guildId, meetingId: meeting.channelId_timestamp },
  };
}
afterEach(() => {
  resetNotionFetchForTests();
  jest.restoreAllMocks();
});

test("unknown submitted create retains the permanent reservation and prevents automatic duplicate create", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let reject!: (error: Error) => void;
  f.fetch.mockImplementationOnce(() => {
    entered();
    return new Promise((_done, failed) => {
      reject = failed;
    });
  });
  const controller = new AbortController();
  registerNotionMutationTracker(controller.signal, (run) => run());
  const operation = maybeAutoExportCompletedMeeting(meeting, controller.signal);
  const outcome = operation.catch((error: unknown) => error);
  await started;
  expect(f.fetch.mock.calls[1][1].signal).toBe(controller.signal);
  reject(new Error("synthetic lost response"));
  expect(await outcome).toBeInstanceOf(UnresolvedNotionMutation);
  expect(await f.repository.getAutomationMeetingExport(f.key)).toBeUndefined();
  await maybeAutoExportCompletedMeeting(meeting, ownedSignal());
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(
    await f.repository.getAutomationConfig(meeting.guildId),
  ).not.toHaveProperty("lastError");
});

test("pre-dispatch cancellation after held connection lookup never sends a page mutation", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const original = f.repository.getConnection;
  jest
    .spyOn(f.repository, "getConnection")
    .mockImplementationOnce(async (id) => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
      return original(id);
    });
  const controller = new AbortController();
  registerNotionMutationTracker(controller.signal, (run) => run());
  const operation = maybeAutoExportCompletedMeeting(meeting, controller.signal);
  const outcome = operation.catch((error: unknown) => error);
  await started;
  controller.abort(new Error("synthetic stop"));
  release();
  expect(await outcome).toBeInstanceOf(Error);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test("unknown fixed-page update preserves the acknowledged export row", async () => {
  const f = await fixture();
  const existing = {
    guildId: meeting.guildId,
    channelId_timestamp: meeting.channelId_timestamp,
    ownerUserId: "synthetic",
    notionPageId: "synthetic-existing-page",
    exportedNotesVersion: 1,
    status: "exported" as const,
    attemptCount: 1,
    lastAttemptAt: "previous",
  };
  await f.repository.writeAutomationMeetingExport(existing);
  f.fetch.mockRejectedValueOnce(new Error("synthetic lost update response"));
  await expect(
    maybeAutoSyncMeetingNotes(meeting, ownedSignal()),
  ).rejects.toBeInstanceOf(UnresolvedNotionMutation);
  expect(await f.repository.getAutomationMeetingExport(f.key)).toEqual(
    existing,
  );
  expect(f.fetch.mock.calls[1][0]).toContain(
    "synthetic-existing-page/markdown",
  );
});

async function correctionFixture() {
  const f = await fixture();
  mockApiSettled.mockClear();
  await f.repository.writeAutomationMeetingExport({
    guildId: meeting.guildId,
    channelId_timestamp: meeting.channelId_timestamp,
    ownerUserId: "synthetic",
    notionPageId: "synthetic-page",
    exportedNotesVersion: 1,
    status: "exported",
    attemptCount: 1,
    lastAttemptAt: "previous",
  });
  const historyRepository = getMeetingHistoryRepository();
  jest.spyOn(historyRepository, "updateNotes").mockResolvedValue(true);
  jest.spyOn(historyRepository, "get").mockResolvedValue(meeting);
  return f;
}
function correct(id: string) {
  return runRuntimeApiOperation(id, (operation) =>
    updateMeetingNotesService(
      {
        guildId: meeting.guildId,
        channelId_timestamp: meeting.channelId_timestamp,
        notes: meeting.notes!,
        notesVersion: 2,
        editedBy: "synthetic",
        expectedPreviousVersion: 1,
      },
      operation.signal,
      operation,
    ),
  );
}
test("actual canonical ACK followed by held automatic Notion lookup cancellation releases after the whole helper settles", async () => {
  const f = await correctionFixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.repository.getConnection;
  jest
    .spyOn(f.repository, "getConnection")
    .mockImplementationOnce(async (id) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(id);
    });
  const id = "synthetic-api-notion-read";
  const task = correct(id).catch((error: unknown) => error);
  await started;
  fenceRuntimeWorkAdmission(id);
  expect(mockApiSettled).not.toHaveBeenCalled();
  release();
  await task;
  expect(mockApiSettled).toHaveBeenCalledTimes(1);
  expect(
    getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id),
  ).toBeUndefined();
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
test.each(["5xx", "body_loss", "known_ack"])(
  "actual automatic Notion mutation %s determines API ownership",
  async (outcome) => {
    const f = await correctionFixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetch.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (outcome === "body_loss")
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("Synthetic lost body");
          },
        };
      return new Response(
        JSON.stringify(
          outcome === "5xx"
            ? { message: "Synthetic unknown" }
            : { markdown: "Synthetic" },
        ),
        { status: outcome === "5xx" ? 503 : 200 },
      );
    });
    const id = `synthetic-api-notion-${outcome}`;
    const task = correct(id).catch((error: unknown) => error);
    await started;
    fenceRuntimeWorkAdmission(id);
    expect(mockApiSettled).not.toHaveBeenCalled();
    release();
    await task;
    expect(mockApiSettled).toHaveBeenCalledTimes(
      outcome === "known_ack" ? 1 : 0,
    );
    expect(
      Boolean(
        getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id),
      ),
    ).toBe(outcome !== "known_ack");
    expect(
      (await f.repository.getAutomationMeetingExport(f.key))
        ?.exportedNotesVersion,
    ).toBe(outcome === "known_ack" ? 2 : 1);
  },
);

// The initial 401 is a definite rejection. The subsequent token rotation owns
// its complete response validation, and only its successful ACK permits release.
test.each(["5xx", "body_loss", "schema_loss", "known_ack"])(
  "actual automatic token refresh %s retains its exact API owner through validation",
  async (outcome) => {
    const f = await correctionFixture();
    f.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }),
    );
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetch.mockImplementationOnce(async (url) => {
      expect(url).toContain("/oauth/token");
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (outcome === "body_loss")
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("Synthetic token body loss");
          },
        };
      return new Response(
        JSON.stringify(
          outcome === "known_ack"
            ? {
                access_token: "synthetic-rotated",
                refresh_token: "synthetic-rotated",
                bot_id: "synthetic",
                workspace_id: "synthetic",
              }
            : { message: "Synthetic invalid token response" },
        ),
        { status: outcome === "5xx" ? 503 : 200 },
      );
    });
    const writeConnection = jest.spyOn(f.repository, "writeConnection");
    const id = `synthetic-api-token-${outcome}`;
    const task = correct(id).catch((error: unknown) => error);
    // Race with task completion so an incorrect 401-unknown classification fails promptly.
    expect(
      await Promise.race([
        started.then(() => "issued"),
        task.then(() => "ended"),
      ]),
    ).toBe("issued");
    fenceRuntimeWorkAdmission(id);
    expect(mockApiSettled).not.toHaveBeenCalled();
    release();
    await task;
    expect(mockApiSettled).toHaveBeenCalledTimes(
      outcome === "known_ack" ? 1 : 0,
    );
    expect(writeConnection).toHaveBeenCalledTimes(
      outcome === "known_ack" ? 1 : 0,
    );
    expect(f.fetch).toHaveBeenCalledTimes(3);
  },
);

function ownedSignal() {
  const signal = new AbortController().signal;
  registerNotionMutationTracker(signal, (run) => run());
  return signal;
}
