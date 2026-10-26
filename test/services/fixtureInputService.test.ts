/** @jest-environment node */
import * as historyRepository from "../../src/repositories/meetingHistoryRepository";
import * as historyIndex from "../../src/services/meetingUserIndexService";
import { fixtureGrantIdentity } from "../fixtures/productionIntroduction";
import { createHash } from "node:crypto";
import { config } from "../../src/services/configService";
import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { uploadObjectToS3 } from "../../src/services/storageService";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { saveOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { EventEmitter } from "node:events";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/deploymentControl";
import type {
  FixtureGrant,
  NewWorkScope,
} from "../../src/types/productionIntroduction";
import { originalFixtureScope } from "../../src/services/activeMeetingLeaseService";
import { getDeploymentControlRepository } from "../../src/db";
import { fixtureScopeForGrant } from "../../src/services/deploymentFixtureAdmission";
import {
  acceptedFixturePcm,
  allowFixtureActor,
  armFixtureObservation,
  beginFixtureClosure,
  closeFixtureObservation,
  failFixture,
  fixtureGenerationObserver,
  fixtureInputSnapshot,
  fixtureOutputSnapshot,
  isFixture,
  observeFixtureMember,
  observeFixtureMessage,
  rejectFixtureTts,
  startFixtureCapture,
  verifyFixtureReservation,
} from "../../src/services/fixtureInputService";
import { observeFixtureChannel } from "../../src/services/fixtureObservationService";
import { collectMeetingContext } from "../../src/services/contextService";
import { fetchChannelContext } from "../../src/services/channelContextService";
import { resolveConfigSnapshot } from "../../src/services/unifiedConfigService";
import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import { startRecordingContentCheckpoint } from "../../src/services/recordingContentService";
import { prepareLiveNotesPrompt } from "../../src/services/notesPromptService";
import {
  getTranscriptionPrompt,
  getTranscriptionCleanupPrompt,
} from "../../src/services/transcriptionPromptService";
import {
  getLangfuseChatPrompt,
  getLangfuseTextPrompt,
} from "../../src/services/langfusePromptService";
import { liveMeetingNotesInput } from "../../src/services/liveMeetingNotesService";
import { validateFixtureCapture } from "../../src/services/fixtureEvidenceValidation";
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";

jest.mock("../../src/services/langfusePromptService", () => ({
  getLangfuseChatPrompt: jest.fn(async (input) => ({
    messages: [{ role: "user", content: JSON.stringify(input.variables) }],
    langfusePrompt: { name: input.name, version: 1 },
  })),
  getLangfuseTextPrompt: jest.fn(async (input) => ({
    prompt: JSON.stringify(input.variables),
    langfusePrompt: { name: input.name, version: 1 },
  })),
}));
jest.mock("../../src/services/savedRecordingPrompt", () => ({
  snapshotRecordingPrompt: jest.fn(async () => {
    throw new Error("synthetic unavailable template");
  }),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  originalFixtureScope: jest.fn(),
}));
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/services/channelContextService", () => ({
  fetchChannelContext: jest.fn(),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  ...jest.requireActual("../../src/services/unifiedConfigService"),
  resolveConfigSnapshot: jest.fn(),
}));
jest.mock("../../src/services/storageService", () => ({
  uploadObjectToS3: jest.fn(),
}));
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(),
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  saveOwnedMeetingHistoryService: jest.fn(),
  listRecentMeetingsForChannelService: jest.fn(),
}));
const ownership = {
  guildId: "guild",
  meetingId: "meeting",
  ownerInstanceId: "owner",
  executionVersion: 1,
  voiceOperationAttemptId: "voice-attempt",
  sessionMode: "meeting",
} as const;
const historyKey = {
  guildId: "guild",
  channelId_timestamp: "voice#2026-10-20T00:00:00.000Z",
};
const grant: FixtureGrant = {
  ...fixtureGrantIdentity,
  state: "consumed",
  meetingId: "meeting",
  guildId: "guild",
  voiceChannelId: "voice",
  textChannelId: "text",
  actorUserId: "actor",
  sessionMode: "meeting",
  inputProfile: "manual_script_v1",
  scriptSha256: "a".repeat(64),
  checklistSha256: "b".repeat(64),
  ownership,
  historyKey,
};
let reservation: SessionReservation;
let scope: Extract<NewWorkScope, { kind: "fixture" }>;
let getRecord: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  reservation = {
    ...ownership,
    historyKey,
    reservedAt: Date.parse("2026-10-20T00:00:00.000Z"),
    workHandle: { settle: jest.fn(), transition: jest.fn() },
  } as SessionReservation;
  scope = fixtureScopeForGrant(grant);
  jest
    .mocked(originalFixtureScope)
    .mockImplementation((value) => (value === reservation ? scope : undefined));
  getRecord = jest.fn(async () => grant);
  jest
    .mocked(getDeploymentControlRepository)
    .mockReturnValue({ getRecord } as never);
});
async function verified() {
  await verifyFixtureReservation(reservation);
  return { reservation };
}
function capture(meeting: { reservation: SessionReservation }) {
  armFixtureObservation(meeting, () => {});
  const at = new Date();
  startFixtureCapture(meeting, at);
  return {
    ...ownership,
    ...historyKey,
    channelId: "voice",
    reservedAt: new Date(reservation.reservedAt).toISOString(),
    captureStartedAt: at.toISOString(),
    requested: { transcribeMeeting: true, generateNotes: true },
  };
}
function close(meeting: { reservation: SessionReservation }) {
  beginFixtureClosure(meeting);
  closeFixtureObservation(meeting, new Date().toISOString(), true);
}

test.each(["missing", "issued", "owner", "history", "script"])(
  "cannot arm a %s consumed grant",
  async (kind) => {
    getRecord.mockResolvedValue(
      kind === "missing"
        ? undefined
        : kind === "issued"
          ? {
              ...grant,
              state: "issued",
              ownership: undefined,
              historyKey: undefined,
            }
          : kind === "owner"
            ? {
                ...grant,
                ownership: { ...ownership, ownerInstanceId: "wrong" },
              }
            : kind === "history"
              ? {
                  ...grant,
                  historyKey: { ...historyKey, channelId_timestamp: "wrong" },
                }
              : { ...grant, scriptSha256: "c".repeat(64) },
    );
    await expect(verifyFixtureReservation(reservation)).rejects.toThrow();
    expect(isFixture({ reservation })).toBe(false);
  },
);
test("copied reservation and serialized evidence never activate live fixture authority", async () => {
  const meeting = await verified();
  const copied = {
    reservation: { ...reservation },
    fixtureInput: fixtureInputSnapshot(meeting),
  };
  await verifyFixtureReservation(copied.reservation);
  expect(isFixture(copied)).toBe(false);
  expect(getRecord).toHaveBeenCalledTimes(1);
});
test("only accepted actor PCM increments evidence and actual closure closes it", async () => {
  const meeting = await verified();
  const provenance = capture(meeting);
  expect(allowFixtureActor(meeting, "actor")).toBe(true);
  acceptedFixturePcm(meeting, 3840);
  close(meeting);
  expect(fixtureInputSnapshot(meeting)).toMatchObject({
    state: "closed",
    acceptedPcmChunks: 1,
    acceptedPcmBytes: 3840,
  });
  expect(() =>
    validateFixtureCapture(provenance, fixtureInputSnapshot(meeting)),
  ).not.toThrow();
  expect(allowFixtureActor(meeting, "actor")).toBe(false);
  expect(fixtureInputSnapshot(meeting)?.state).toBe("incomplete");
});
test.each(["member", "audio", "message", "tts"])(
  "%s contamination survives normal closure",
  async (kind) => {
    const meeting = await verified();
    capture(meeting);
    if (kind === "member") observeFixtureMember(meeting, "other", true, "bot");
    if (kind === "audio")
      expect(allowFixtureActor(meeting, "other")).toBe(false);
    if (kind === "message") observeFixtureMessage(meeting, 1);
    if (kind === "tts") expect(rejectFixtureTts(meeting)).toBe(true);
    close(meeting);
    expect(fixtureInputSnapshot(meeting)?.state).toBe("contaminated");
  },
);
test.each([
  "observer_gap",
  "decoder_failure",
  "ownership_lost",
  "reattachment",
] as const)(
  "%s remains incomplete after subsequent PCM and close",
  async (reason) => {
    const meeting = await verified();
    capture(meeting);
    failFixture(meeting, reason);
    acceptedFixturePcm(meeting, 3840);
    close(meeting);
    expect(fixtureInputSnapshot(meeting)).toMatchObject({
      state: "incomplete",
      continuityFailures: 1,
      failureReasons: [reason],
    });
  },
);
test("missing observation and reattachment cannot close a passing interval", async () => {
  const meeting = await verified();
  startFixtureCapture(meeting, new Date());
  close(meeting);
  expect(fixtureInputSnapshot(meeting)?.state).toBe("incomplete");
  await expect(verifyFixtureReservation(reservation)).rejects.toThrow(
    "reattach",
  );
});
test("context lookup returns empty without selecting dictionary, instructions or history", async () => {
  const meeting = await verified();
  const content = {
    ...meeting,
    meetingContext: "untrusted",
    dictionaryEntries: [{ term: "private" }],
    runtimeConfig: {},
  } as MeetingData;
  expect(await collectMeetingContext(content, true)).toEqual({
    availability: "available",
    data: {},
  });
  expect(fetchChannelContext).not.toHaveBeenCalled();
  expect(resolveConfigSnapshot).not.toHaveBeenCalled();
});
test("metadata observer covers initialization joins and chat without reading message content", async () => {
  const meeting = await verified();
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" } });
  const detach = observeFixtureChannel({
    ...meeting,
    client,
    guild: { id: "guild", shardId: 0 },
    channelId: "voice",
    memberIds: () => ["actor", "bot"],
    signal: new AbortController().signal,
  } as never);
  client.emit(
    "voiceStateUpdate",
    { guild: { id: "guild" }, id: "other", channelId: null },
    { guild: { id: "guild" }, id: "other", channelId: "voice" },
  );
  client.emit("messageCreate", {
    guildId: "guild",
    channelId: "voice",
    author: { id: "other-bot" },
    attachments: { size: 2 },
    get content() {
      throw new Error("must not read");
    },
  });
  expect(fixtureInputSnapshot(meeting)).toMatchObject({
    unexpectedMembers: 1,
    rejectedMessages: 1,
    rejectedAttachments: 2,
    state: "contaminated",
  });
  detach();
  expect(client.listenerCount("messageCreate")).toBe(0);
});
test("provenance preserves distinct actual prompt versions and missing or overflowing observations", async () => {
  const meeting = await verified();
  const observe = fixtureGenerationObserver(meeting)!;
  observe("transcription-audio-slow", "audio-alias", null)(null);
  observe("notes", "requested", { name: "notes", version: 2 })("returned");
  observe("notes", "requested", { name: "notes", version: 3 })("returned");
  observe("summary", "requested", undefined)(null);
  observe("notes", "requested", { name: "notes", version: 3 });
  for (let i = 0; i < 65; i++) observe("notes", `model-${i}`, null)("returned");
  const output = fixtureOutputSnapshot(meeting);
  expect(output.fixtureGeneration).toMatchObject({
    submitted: 70,
    acknowledged: 69,
    missing: 2,
    overflow: true,
  });
  expect(output.fixtureGeneration?.tuples).toHaveLength(64);
  expect(output.fixtureGeneration?.tuples[0]).toMatchObject({
    prompt: { kind: "none" },
    returnedModel: null,
    providerRevision: "unavailable",
  });
  expect(JSON.stringify(output)).not.toContain("private input");
});
test("manifest validation refuses erased failures, changed owner or a manufactured closed state", async () => {
  const meeting = await verified();
  const provenance = capture(meeting);
  observeFixtureMessage(meeting, 1);
  const previous = fixtureInputSnapshot(meeting)!;
  close(meeting);
  const current = fixtureInputSnapshot(meeting)!;
  expect(() =>
    validateFixtureCapture(provenance, current, previous),
  ).not.toThrow();
  expect(() =>
    validateFixtureCapture(
      provenance,
      { ...current, rejectedMessages: 0 },
      previous,
    ),
  ).toThrow();
  expect(() =>
    validateFixtureCapture({ ...provenance, ownerInstanceId: "new" }, current),
  ).toThrow();
  expect(() =>
    validateFixtureCapture(provenance, { ...current, state: "closed" }),
  ).toThrow();
});

test("PCM counters saturate and remain incomplete after overflow", async () => {
  const meeting = await verified();
  capture(meeting);
  acceptedFixturePcm(meeting, Number.MAX_SAFE_INTEGER);
  acceptedFixturePcm(meeting, 1);
  close(meeting);
  expect(fixtureInputSnapshot(meeting)).toMatchObject({
    acceptedPcmBytes: Number.MAX_SAFE_INTEGER,
    overflow: true,
    state: "incomplete",
    failureReasons: ["counter_overflow"],
  });
});

test("incidental context.instructions config row never enters fixture prompts, context artifacts or evidence", async () => {
  const sentinel = "DO_NOT_INCLUDE_SCOPE_INSTRUCTIONS_837461";
  jest.mocked(resolveConfigSnapshot).mockResolvedValue({
    values: { "context.instructions": { value: sentinel } },
  } as never);
  const runtimeConfig = await resolveMeetingRuntimeConfig({
    guildId: "guild",
    channelId: "voice",
    userId: "actor",
  });
  expect(JSON.stringify(runtimeConfig)).not.toContain(sentinel);
  const carrier = await verified();
  const artifacts: unknown[] = [];
  const forbidden = () => {
    throw new Error("unrelated Discord metadata read");
  };
  const meeting = {
    ...carrier,
    isAutoRecording: false,
    guildId: "guild",
    meetingId: "meeting",
    channelId: "voice",
    creator: { id: "actor" },
    startTime: new Date(),
    captureStartedAt: new Date(),
    transcribeMeeting: true,
    generateNotes: true,
    runtimeConfig,
    ownershipSignal: new AbortController().signal,
    guild: {
      id: "guild",
      get name() {
        return forbidden();
      },
      get roles() {
        return forbidden();
      },
    },
    voiceChannel: {
      id: "voice",
      get name() {
        return forbidden();
      },
    },
    participants: new Map([["actor", { id: "actor", username: sentinel }]]),
    attendance: new Set(["actor"]),
    chatLog: [],
    audioData: { audioFiles: [] },
    finalTranscript: "Synthetic spoken transcript",
    recordingCapture: {
      queueContent: (item: { bytes: Buffer }) => {
        artifacts.push(JSON.parse(item.bytes.toString()));
        return true;
      },
    },
  } as unknown as MeetingData;
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const notes = await prepareLiveNotesPrompt(meeting);
  const transcription = await getTranscriptionPrompt(meeting);
  const cleanup = await getTranscriptionCleanupPrompt(
    meeting,
    "Synthetic transcript",
  );
  const input = liveMeetingNotesInput(meeting);
  const data = JSON.stringify({
    notes,
    transcription,
    cleanup,
    artifacts,
    input,
    evidence: fixtureOutputSnapshot(meeting),
  });
  expect(data).not.toContain(sentinel);
  expect(data).toContain("Fixture speaker");
  expect(getLangfuseChatPrompt).toHaveBeenCalled();
  expect(getLangfuseTextPrompt).toHaveBeenCalled();
  expect(fetchChannelContext).not.toHaveBeenCalled();
  expect(resolveConfigSnapshot).toHaveBeenCalledTimes(1);
});

test.each(["acknowledged", "lost", "wrong-key"])(
  "fixture final upload and owned history preserve %s direct receipt without readback",
  async (outcome) => {
    const carrier = await verified();
    const captured = capture(carrier);
    close(carrier);
    const meeting = {
      ...carrier,
      meetingId: "meeting",
      guildId: "guild",
      channelId: "voice",
      voiceChannel: { id: "voice" },
      textChannel: { id: "text" },
      guild: { id: "guild" },
      creator: { id: "actor" },
      startTime: new Date(reservation.reservedAt),
      endTime: new Date(),
      transcribeMeeting: true,
      generateNotes: true,
      isAutoRecording: false,
      notesText: "Synthetic notes",
      summaryLabel: "Lantern",
      summarySentence: "Synthetic summary",
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "generated",
      },
      chatLog: [],
      audioData: {
        audioFiles: [
          {
            userId: "actor",
            timestamp: 1,
            transcript: "Synthetic speech",
            processing: false,
          },
        ],
      },
      participants: new Map([
        ["actor", { id: "actor", username: "SECRET_LABEL_SENTINEL" }],
      ]),
      attendance: new Set(),
    } as unknown as MeetingData;
    const bucket = jest.replaceProperty(
      config.storage,
      "transcriptBucket",
      "synthetic-bucket",
    );
    jest
      .mocked(uploadObjectToS3)
      .mockImplementation(async (key, _body, _type, options) => {
        if (outcome !== "lost")
          options?.onAcknowledged?.({
            key: outcome === "wrong-key" ? "other" : key,
            versionId: "direct-version",
          });
        return key;
      });
    try {
      await uploadMeetingArtifacts(meeting, {
        transcriptText: "Synthetic speech",
      });
      const [key, body] = jest.mocked(uploadObjectToS3).mock.calls.at(-1)!;
      const receipt = fixtureOutputSnapshot(meeting).fixtureTranscript;
      expect(receipt).toMatchObject({
        key,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
        byteLength: Buffer.byteLength(body as string),
        acknowledgment:
          outcome === "acknowledged"
            ? { state: "acknowledged", versionId: "direct-version" }
            : { state: "unknown" },
      });
      expect(String(body)).not.toContain("SECRET_LABEL_SENTINEL");
      await saveMeetingHistoryToDatabase(meeting);
      const row = jest
        .mocked(saveOwnedMeetingHistoryService)
        .mock.calls.at(-1)![1];
      expect(row.fixtureTranscript).toEqual(receipt);
      expect(row.fixtureInput?.state).toBe("closed");
      expect(row.notesVersion).toBe(1);
      expect(JSON.stringify(row)).not.toContain("SECRET_LABEL_SENTINEL");
      const owned = {
        ...row,
        ...ownership,
        status: "processing",
        checkpoint: { capture: captured },
      };
      const transitionOwned = jest.fn(async () => "applied");
      const getOwned = jest.fn(async () => owned);
      const repository = jest
        .spyOn(historyRepository, "getMeetingHistoryRepository")
        .mockReturnValue({
          getOwned,
          transitionOwned,
        } as never);
      const index = jest
        .spyOn(historyIndex, "writeMeetingUserIndexForMeetingService")
        .mockResolvedValue(undefined);
      const actual = jest.requireActual<
        typeof import("../../src/services/meetingHistoryService")
      >("../../src/services/meetingHistoryService");
      try {
        const changed = structuredClone(row);
        changed.fixtureTranscript!.checksumSha256 = "f".repeat(64);
        await expect(
          actual.saveOwnedMeetingHistoryService(meeting, changed),
        ).rejects.toThrow("live original evidence");
        await expect(
          actual.saveOwnedMeetingHistoryService(
            { ...meeting, reservation: { ...reservation } },
            row,
          ),
        ).rejects.toThrow();
        expect(transitionOwned).not.toHaveBeenCalled();
        const saved = await actual.saveOwnedMeetingHistoryService(meeting, row);
        expect(transitionOwned).toHaveBeenCalledTimes(1);
        for (const field of [
          "updateDelivery",
          "publicationRepair",
          "contentMutation",
        ] as const)
          expect(saved[field]).toBeUndefined();
        expect(saved.contentRevision ?? 0).toBe(0);
        const edited = {
          ...owned,
          contentRevision: 1,
          contentMutation: {
            id: "edit",
            fingerprint: "a".repeat(64),
            fieldRevisions: { meetingName: 1 },
          },
          meetingName: "Synthetic edit",
          updateDelivery: requestMeetingUpdateDelivery({
            history: owned,
            mutation: { kind: "rename", meetingName: "Synthetic edit" },
            revision: "edit-delivery",
            now: 100,
            policy: { kind: "held", reason: "initial_publication_unsettled" },
          }),
        };
        for (const forged of [false, true]) {
          getOwned
            .mockReset()
            .mockResolvedValueOnce(owned)
            .mockResolvedValueOnce({
              ...edited,
              ...(forged
                ? {
                    fixtureInput: {
                      ...edited.fixtureInput!,
                      scriptSha256: "b".repeat(64),
                    },
                  }
                : {}),
            });
          transitionOwned.mockClear().mockResolvedValueOnce("stale");
          const retried = actual.saveOwnedMeetingHistoryService(meeting, row);
          if (forged) {
            await expect(retried).rejects.toThrow(
              "Fixture identity cannot change",
            );
            expect(transitionOwned).toHaveBeenCalledTimes(1);
          } else {
            await expect(retried).resolves.toMatchObject({
              meetingName: "Synthetic edit",
              fixtureInput: row.fixtureInput,
            });
            expect(transitionOwned).toHaveBeenCalledTimes(2);
          }
        }
      } finally {
        repository.mockRestore();
        index.mockRestore();
      }
    } finally {
      bucket.restore();
    }
  },
);
