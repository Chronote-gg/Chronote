/** @jest-environment node */
import { jest } from "@jest/globals";
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("../fixtures/notionOwner")
    .runTestNotionOperation,
}));
import { withTestNotionOwner } from "../fixtures/notionOwner";
import type { MeetingHistory } from "../../src/types/db";
import type {
  NotionAutomationConfig,
  NotionAutomationMeetingExport,
} from "../../src/types/notionIntegration";

const mockRepository = {
  writeConnection: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => undefined),
  deleteConnection: jest.fn(async () => undefined),
  writeAutomationConfig: jest.fn(async () => undefined),
  getAutomationConfig: jest.fn(
    async (): Promise<NotionAutomationConfig | undefined> => undefined,
  ),
  reserveMeetingExport: jest.fn(async () => true),
  writeMeetingExport: jest.fn(async () => undefined),
  deleteMeetingExport: jest.fn(async () => undefined),
  getMeetingExport: jest.fn(async () => undefined),
  reserveAutomationMeetingExport: jest.fn(async () => true),
  writeAutomationMeetingExport: jest.fn(async (): Promise<void> => undefined),
  deleteAutomationMeetingExport: jest.fn(async () => undefined),
  getAutomationMeetingExport: jest.fn(
    async (): Promise<NotionAutomationMeetingExport | undefined> => undefined,
  ),
};

jest.mock("../../src/services/configService", () => ({
  config: { notion: { enabled: true } },
}));

jest.mock("../../src/repositories/notionIntegrationRepository", () => ({
  getNotionIntegrationRepository: () => mockRepository,
}));

jest.mock("../../src/services/notionService", () => ({
  NotionApiError: class NotionApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "NotionApiError";
    }
  },
  exportMeetingToNotionAutomation: jest.fn(),
  syncMeetingToNotionAutomation: jest.fn(),
}));

import { config } from "../../src/services/configService";
import {
  exportMeetingToNotionAutomation,
  syncMeetingToNotionAutomation,
} from "../../src/services/notionService";
import {
  autoExportRecoveredMeeting as actual_autoExportRecoveredMeeting,
  maybeAutoExportCompletedMeeting as actual_maybeAutoExportCompletedMeeting,
  maybeAutoSyncMeetingNotes as actual_maybeAutoSyncMeetingNotes,
  retryNotionAutomationExport,
} from "../../src/services/notionAutomationService";

const meeting: MeetingHistory = {
  guildId: "guild-1",
  channelId_timestamp: "channel-1#2026-05-08T12:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "channel-1",
  timestamp: "2026-05-08T12:00:00.000Z",
  notes: "Meeting notes",
  notesVersion: 4,
  participants: [],
  duration: 600,
  transcribeMeeting: true,
  generateNotes: true,
};

const automationConfig: NotionAutomationConfig = {
  guildId: meeting.guildId,
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  destinationType: "page",
  destinationPageId: "parent-page-1",
  destinationTitle: "Meeting archive",
  autoExportEnabled: true,
  channelIds: [],
  tags: [],
  createdAt: "2026-05-08T12:00:00.000Z",
  updatedAt: "2026-05-08T12:00:00.000Z",
};

const existingExport: NotionAutomationMeetingExport = {
  guildId: meeting.guildId,
  channelId_timestamp: meeting.channelId_timestamp,
  ownerUserId: automationConfig.ownerUserId,
  notionPageId: "notion-page-1",
  notionPageUrl: "https://notion.so/notion-page-1",
  notionWorkspaceId: automationConfig.workspaceId,
  exportedNotesVersion: 2,
  status: "failed",
  attemptCount: 2,
  lastAttemptAt: "2026-05-08T12:05:00.000Z",
  lastExportedAt: "2026-05-08T12:02:00.000Z",
};

const personalMeeting: MeetingHistory = {
  ...meeting,
  guildId: "personal:owner-1",
  channelId_timestamp: "personal#2026-05-08T12:00:00.000Z",
  channelId: "personal",
  ownershipScope: "personal",
  ownerUserId: "owner-1",
  meetingCreatorId: "owner-1",
};

const personalAutomationConfig: NotionAutomationConfig = {
  ...automationConfig,
  guildId: personalMeeting.guildId,
  ownerUserId: "owner-1",
};

describe("notionAutomationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(config.notion, "enabled", true);
    mockRepository.getAutomationConfig.mockResolvedValue(automationConfig);
    mockRepository.getAutomationMeetingExport.mockResolvedValue(undefined);
    mockRepository.reserveAutomationMeetingExport.mockResolvedValue(true);
  });

  it("syncs the existing Notion page when retrying an automation export", async () => {
    const syncedExport: NotionAutomationMeetingExport = {
      ...existingExport,
      status: "exported",
      exportedNotesVersion: meeting.notesVersion ?? 1,
      attemptCount: existingExport.attemptCount + 1,
      lastAttemptAt: "2026-05-08T12:10:00.000Z",
      lastExportedAt: "2026-05-08T12:10:00.000Z",
      lastError: undefined,
    };
    mockRepository.getAutomationMeetingExport.mockResolvedValue(existingExport);
    jest.mocked(syncMeetingToNotionAutomation).mockResolvedValue(syncedExport);

    await expect(retryNotionAutomationExport(meeting)).resolves.toBe(
      syncedExport,
    );
    expect(syncMeetingToNotionAutomation).toHaveBeenCalledWith({
      userId: automationConfig.ownerUserId,
      meeting,
      existing: existingExport,
      signal: expect.any(AbortSignal),
    });
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
  });

  it("fails forced retries when another retry already reserved the export", async () => {
    mockRepository.reserveAutomationMeetingExport.mockResolvedValue(false);

    await expect(retryNotionAutomationExport(meeting)).rejects.toMatchObject({
      status: 409,
      code: "automation_retry_conflict",
      message:
        "Notion automation retry is already in progress. Try again shortly.",
    });
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
    expect(syncMeetingToNotionAutomation).not.toHaveBeenCalled();
  });

  it("skips background exports and syncs when Notion is disabled", async () => {
    jest.replaceProperty(config.notion, "enabled", false);

    await maybeAutoExportCompletedMeeting(meeting);
    await maybeAutoSyncMeetingNotes(meeting);

    expect(mockRepository.getAutomationConfig).not.toHaveBeenCalled();
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
    expect(syncMeetingToNotionAutomation).not.toHaveBeenCalled();
  });

  it("exports personal meetings with the owner's Notion automation", async () => {
    const exported: NotionAutomationMeetingExport = {
      guildId: personalMeeting.guildId,
      channelId_timestamp: personalMeeting.channelId_timestamp,
      ownerUserId: personalAutomationConfig.ownerUserId,
      notionPageId: "notion-page-1",
      notionPageUrl: "https://notion.so/notion-page-1",
      notionWorkspaceId: personalAutomationConfig.workspaceId,
      exportedNotesVersion: personalMeeting.notesVersion ?? 1,
      status: "exported",
      attemptCount: 1,
      lastAttemptAt: "2026-05-08T12:10:00.000Z",
      lastExportedAt: "2026-05-08T12:10:00.000Z",
    };
    mockRepository.getAutomationConfig.mockResolvedValue(
      personalAutomationConfig,
    );
    jest.mocked(exportMeetingToNotionAutomation).mockResolvedValue(exported);

    await maybeAutoExportCompletedMeeting(personalMeeting);

    expect(exportMeetingToNotionAutomation).toHaveBeenCalledWith({
      userId: "owner-1",
      meeting: personalMeeting,
      destinationPageId: personalAutomationConfig.destinationPageId,
      attemptCount: 1,
      signal: expect.any(AbortSignal),
    });
  });

  it("skips personal automation when the config owner does not own the meeting", async () => {
    mockRepository.getAutomationConfig.mockResolvedValue({
      ...personalAutomationConfig,
      ownerUserId: "other-user",
    });

    await maybeAutoExportCompletedMeeting(personalMeeting);

    expect(
      mockRepository.reserveAutomationMeetingExport,
    ).not.toHaveBeenCalled();
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
  });
  it.each(["config", "reservation", "page"] as const)(
    "cancellation during held %s retains the caller and prevents later writes",
    async (boundary) => {
      let entered!: () => void;
      const started = new Promise<void>((done) => {
        entered = done;
      });
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const wait = async () => {
        entered();
        await held;
      };
      if (boundary === "config")
        mockRepository.getAutomationConfig.mockImplementationOnce(async () => {
          await wait();
          return automationConfig;
        });
      if (boundary === "reservation")
        mockRepository.reserveAutomationMeetingExport.mockImplementationOnce(
          async () => {
            await wait();
            return true;
          },
        );
      if (boundary === "page")
        jest
          .mocked(exportMeetingToNotionAutomation)
          .mockImplementationOnce(async () => {
            await wait();
            return { ...existingExport, status: "exported" };
          });
      const controller = new AbortController();
      let settled = false;
      const operation = maybeAutoExportCompletedMeeting(
        meeting,
        controller.signal,
      );
      const observed = operation.then(
        () => {
          settled = true;
          return "success";
        },
        () => {
          settled = true;
          return "interrupted";
        },
      );
      await started;
      controller.abort(new Error("synthetic interruption"));
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await observed).toBe("interrupted");
      if (boundary !== "page")
        expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
      expect(
        mockRepository.writeAutomationMeetingExport,
      ).not.toHaveBeenCalled();
      expect(mockRepository.writeAutomationConfig).not.toHaveBeenCalled();
    },
  );

  it("cancellation during an issued failure write waits and prevents the following config write", async () => {
    jest
      .mocked(exportMeetingToNotionAutomation)
      .mockRejectedValueOnce(new Error("fixture refusal"));
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    let release!: () => void;
    mockRepository.writeAutomationMeetingExport.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((done) => {
        release = done;
      });
    });
    const controller = new AbortController();
    const task = maybeAutoExportCompletedMeeting(meeting, controller.signal);
    const observed = task.then(
      () => "success",
      () => "interrupted",
    );
    await started;
    controller.abort();
    release();
    expect(await observed).toBe("interrupted");
    expect(mockRepository.writeAutomationConfig).not.toHaveBeenCalled();
  });
});

describe("ordinary Notion callers during recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(config.notion, "enabled", true);
    mockRepository.getAutomationConfig.mockResolvedValue(automationConfig);
    mockRepository.getAutomationMeetingExport.mockResolvedValue(undefined);
    mockRepository.reserveAutomationMeetingExport.mockResolvedValue(true);
    jest
      .mocked(exportMeetingToNotionAutomation)
      .mockResolvedValue({ ...existingExport, status: "exported" });
    jest
      .mocked(syncMeetingToNotionAutomation)
      .mockResolvedValue({ ...existingExport, status: "exported" });
  });

  function recovering(
    status: "complete" | "interrupted",
    state: "pending" | "submitted",
  ): MeetingHistory {
    return {
      ...meeting,
      status,
      recovery: {
        attempt: 1,
        executionVersion: 2,
        stage: "export",
        retry: { maxAttempts: 4, nextAttemptAt: null },
        ...(state === "pending"
          ? { disposition: "pending" as const }
          : {
              disposition: "needs_reconciliation" as const,
              reason: "export_uncertain" as const,
            }),
      },
      recoveryExport: {
        checkpointRevision: 1,
        intentExecutionVersion: 2,
        state,
      },
    };
  }

  const cases = (["complete", "interrupted"] as const).flatMap((status) =>
    (["pending", "submitted"] as const).flatMap((state) =>
      (["background", "retry_create", "retry_sync", "auto_sync"] as const).map(
        (caller) => ({ status, state, caller }),
      ),
    ),
  );
  it.each(cases)(
    "$caller refuses $status $state recovery without mutation",
    async ({ status, state, caller }) => {
      const row = recovering(status, state);
      const before = structuredClone(row);
      if (caller !== "background")
        mockRepository.getAutomationMeetingExport.mockResolvedValue({
          ...existingExport,
          notionPageId:
            caller === "retry_create" ? undefined : existingExport.notionPageId,
          status: caller === "auto_sync" ? "exported" : "failed",
        });
      if (caller.startsWith("retry"))
        await expect(retryNotionAutomationExport(row)).rejects.toMatchObject({
          code: "automation_not_eligible",
        });
      else if (caller === "auto_sync") await maybeAutoSyncMeetingNotes(row);
      else await maybeAutoExportCompletedMeeting(row);
      expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
      expect(syncMeetingToNotionAutomation).not.toHaveBeenCalled();
      expect(
        mockRepository.reserveAutomationMeetingExport,
      ).not.toHaveBeenCalled();
      expect(
        mockRepository.writeAutomationMeetingExport,
      ).not.toHaveBeenCalled();
      expect(mockRepository.writeAutomationConfig).not.toHaveBeenCalled();
      expect(row).toEqual(before);
    },
  );

  it.each(
    (["complete", "interrupted"] as const).flatMap((status) =>
      (["acknowledged", "skipped"] as const).map((state) => ({
        status,
        state,
      })),
    ),
  )(
    "terminal $status $state recovery preserves ordinary create, retry and sync",
    async ({ status, state }) => {
      const row = recovering(status, "pending");
      row.recovery = {
        ...row.recovery!,
        disposition: "done",
        outcome: "completed",
      };
      row.recoveryExport = { ...row.recoveryExport!, state };
      await maybeAutoExportCompletedMeeting(row);
      expect(exportMeetingToNotionAutomation).toHaveBeenCalledTimes(1);
      mockRepository.getAutomationMeetingExport.mockResolvedValue({
        ...existingExport,
        status: "exported",
      });
      await retryNotionAutomationExport(row);
      await maybeAutoSyncMeetingNotes(row);
      expect(syncMeetingToNotionAutomation).toHaveBeenCalledTimes(2);
    },
  );
  it("the recovery entrypoint accepts a claimed never-submitted export and refuses submitted uncertainty", async () => {
    const row = recovering("interrupted", "pending");
    row.recovery = { ...row.recovery!, disposition: "claimed" };
    await expect(autoExportRecoveredMeeting(row)).resolves.toBe("acknowledged");
    const unknown = recovering("complete", "submitted");
    const before = structuredClone(unknown);
    await expect(autoExportRecoveredMeeting(unknown)).rejects.toThrow(
      "not pending",
    );
    expect(exportMeetingToNotionAutomation).toHaveBeenCalledTimes(1);
    expect(unknown).toEqual(before);
  });
});

function maybeAutoExportCompletedMeeting(
  meeting: MeetingHistory,
  signal?: AbortSignal,
) {
  return withTestNotionOwner(
    (owned) => actual_maybeAutoExportCompletedMeeting(meeting, owned),
    signal,
  );
}

function maybeAutoSyncMeetingNotes(
  meeting: MeetingHistory,
  signal?: AbortSignal,
) {
  return withTestNotionOwner(
    (owned) => actual_maybeAutoSyncMeetingNotes(meeting, owned),
    signal,
  );
}

function autoExportRecoveredMeeting(
  meeting: MeetingHistory,
  signal?: AbortSignal,
) {
  return withTestNotionOwner(
    (owned) => actual_autoExportRecoveredMeeting(meeting, owned),
    signal,
  );
}
