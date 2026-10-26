/** @jest-environment node */
import {
  verifyFixtureReservation,
  isFixture,
  fixtureParticipant,
  allowFixtureActor,
} from "../src/services/fixtureInputService";
import {
  observeFixtureChannel,
  observeFixtureConnection,
} from "../src/services/fixtureObservationService";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { DiscordAPIError } from "discord.js";
import { createMockDeploymentControlRepository } from "../src/repositories/deploymentControlRepository";
import type { MeetingData } from "../src/types/meeting-data";
import {
  tryAcquireMeetingLease,
  attachMeetingReservation,
  getReservationSignal,
  unwindSessionInitialization,
  releaseSessionReservation,
  getOwnedSessionReservations,
} from "../src/services/activeMeetingLeaseService";
import {
  getActiveMeetingLease,
  releaseActiveMeetingLease,
  renewActiveMeetingLease,
  getDeploymentControlRepository,
  transitionMeetingHistory,
} from "../src/db";
import {
  runMeetingNoticeMutation,
  stopMeetingProcessing,
  areMeetingNoticesSettled,
} from "../src/services/meetingProcessingLifetime";
import {
  runOwnedMeetingFinalization,
  assertMeetingFinalizationActive,
} from "../src/services/meetingFinalizationService";
import { settleOwnedVoiceSession } from "../src/services/guildVoiceOperationService";

jest.mock("../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  releaseActiveMeetingLease: jest.fn(),
  renewActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: jest.fn(),
  transitionMeetingHistory: jest.fn(),
}));
jest.mock("../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(() => ({
    settle: jest.fn(),
    transition: jest.fn(),
  })),
  getRuntimeAdmissionContext: async () => ({
    instanceId: "synthetic-owner",
    observedEpoch: 1,
    protocolVersion: 1,
  }),
}));
jest.mock("../src/services/guildVoiceOperationService", () => ({
  prepareOwnedVoiceSession: jest.fn(),
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
}));
jest.mock("../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-owner",
}));

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

// Run the production initialization and cleanup functions with real reservation/unwind
// and processing ownership. Only external SDK, storage and audio output are fixtures.
function startFailedInitialization(
  mode: "meeting" | "tts_only",
  audioCloses = Promise.resolve(true),
) {
  const source = parseMeetingsSource();
  const functions = selectMeetingFunctions(source, [
    "initializeMeeting",
    "initializeNewMeeting",
    "initializeReservedMeeting",
    "disposeFailedInitialization",
  ]);
  const connection = new EventEmitter();
  Object.assign(connection, { receiver: {} });
  const notification = held<void>();
  const issued = held<MeetingData>();
  const send = jest.fn(() => notification.promise);
  const closeOutput = jest.fn(() => audioCloses);
  const failure = new Error("synthetic participant initialization failure");
  const warn = jest.fn();
  const id: string = randomUUID();
  let currentMeeting!: MeetingData;
  const context = vm.createContext({
    meetingInitializations: new Map(),
    initializationsClosed: false,
    meetings: new Map(),
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    clearInterval,
    uuidv4: () => id,
    reservationTimingReceipt: () => undefined,
    tryAcquireMeetingLease,
    getReservationSignal,
    unwindSessionInitialization,
    attachMeetingReservation: (
      meeting: MeetingData,
      reservation: Parameters<typeof attachMeetingReservation>[1],
    ) => {
      attachMeetingReservation(meeting, reservation);
      currentMeeting = meeting;
    },
    verifyFixtureReservation,
    isFixture,
    fixtureParticipant,
    allowFixtureActor,
    observeFixtureChannel,
    observeFixtureConnection,
    joinOwnedVoiceSession: async () => connection,
    resolveMeetingRuntimeConfig: async () => undefined,
    freezeCompletionPolicy: jest.fn(),
    config: { liveVoice: { mode: "off" } },
    MEETING_START_REASONS: { MANUAL_COMMAND: "manual" },
    DEFAULT_PREFIX_MODE: "none",
    openOutputFile: jest.fn(),
    closeFailedInitializationOutput: closeOutput,
    runMeetingNoticeMutation,
    stopMeetingProcessing,
    areMeetingNoticesSettled,
    DiscordAPIError,
    buildParticipantSnapshot: async () => {
      connection.emit("error", new Error("synthetic connection fault"));
      issued.resolve(currentMeeting);
      throw failure;
    },
    console: { warn, error: jest.fn() },
    options: {
      guild: { id },
      creator: { id: "synthetic-user" },
      textChannel: { id: "synthetic-text", send },
      voiceChannel: {
        id: "synthetic-voice",
        guild: {},
        members: [{ user: { id: "synthetic-user" } }],
      },
      sessionMode: mode,
    },
  });
  vm.runInContext(
    ts.transpileModule(
      functions
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n"),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    context,
  );
  const initialization: Promise<MeetingData> = vm.runInContext(
    "initializeMeeting(options)",
    context,
  );
  const result = initialization.catch((error) => error);
  return {
    issued: issued.promise,
    result,
    failure,
    connection,
    send,
    notification,
    closeOutput,
    warn,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  const repository = createMockDeploymentControlRepository();
  jest
    .spyOn(repository, "reserveSession")
    .mockResolvedValue({ kind: "admitted" });
  jest.mocked(getDeploymentControlRepository).mockReturnValue(repository);
  jest.mocked(renewActiveMeetingLease).mockResolvedValue(true);
  jest.mocked(releaseActiveMeetingLease).mockResolvedValue(true);
  jest.mocked(getActiveMeetingLease).mockResolvedValue(undefined);
  jest.mocked(transitionMeetingHistory).mockResolvedValue("applied");
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

for (const mode of ["meeting", "tts_only"] as const) {
  test.each([
    "acknowledged",
    "definitely-rejected",
    "unknown",
    "timeout",
  ] as const)(
    `${mode} failed initialization retains its original notification through %s`,
    async (outcome) => {
      const f = startFailedInitialization(mode);
      const meeting = await f.issued;
      const original = meeting.reservation!;
      await jest.advanceTimersByTimeAsync(0);
      expect(meeting.ownershipSignal).toBeDefined();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.closeOutput).toHaveBeenCalledTimes(mode === "meeting" ? 1 : 0);
      expect(settleOwnedVoiceSession).toHaveBeenCalledWith(original);
      expect(transitionMeetingHistory).toHaveBeenCalledTimes(
        mode === "meeting" ? 1 : 0,
      );
      expect(original.workHandle.settle).not.toHaveBeenCalled();
      expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
      if (outcome === "timeout") {
        await jest.advanceTimersByTimeAsync(4999);
        expect(original.workHandle.settle).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
      } else if (outcome === "unknown")
        f.notification.reject(new Error("synthetic lost notification ACK"));
      else if (outcome === "acknowledged") f.notification.resolve();
      else
        f.notification.reject(
          new DiscordAPIError(
            { code: 50013, message: "Synthetic denied" },
            50013,
            403,
            "POST",
            "http://localhost",
            { body: {}, files: [] },
          ),
        );
      expect(await f.result).toBe(f.failure);
      const releasable =
        outcome === "acknowledged" || outcome === "definitely-rejected";
      expect(original.workHandle.settle).toHaveBeenCalledTimes(
        releasable ? 1 : 0,
      );
      expect(releaseActiveMeetingLease).toHaveBeenCalledTimes(
        releasable ? 1 : 0,
      );
      if (!releasable)
        expect(getOwnedSessionReservations()).toContainEqual(
          expect.objectContaining({
            reservation: original,
            initializationUnresolved: true,
          }),
        );
      f.connection.emit(
        "error",
        new Error("synthetic callback after cleanup seal"),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(f.send).toHaveBeenCalledTimes(1);
      if (outcome === "timeout") {
        f.notification.resolve();
        await jest.advanceTimersByTimeAsync(0);
        await unwindSessionInitialization(original);
        expect(original.workHandle.settle).not.toHaveBeenCalled();
      }
    },
  );
}

test("failed recording initialization closes its encoder concurrently and shares the five-second notice allowance", async () => {
  const audio = held<boolean>();
  const f = startFailedInitialization("meeting", audio.promise);
  const meeting = await f.issued;
  const original = meeting.reservation!;
  await jest.advanceTimersByTimeAsync(0);
  expect(f.closeOutput).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(4000);
  audio.resolve(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(await f.result).toBe(f.failure);
  expect(original.workHandle.settle).not.toHaveBeenCalled();
  f.notification.resolve();
  await jest.advanceTimersByTimeAsync(0);
  await unwindSessionInitialization(original);
  expect(original.workHandle.settle).not.toHaveBeenCalled();
});

async function startTtsStop() {
  const id: string = randomUUID();
  const admission = await tryAcquireMeetingLease({
    guildId: id,
    meetingId: id,
    voiceChannelId: "voice",
    textChannelId: "text",
    isAutoRecording: false,
    sessionMode: "tts_only",
    reservedAt: Date.now(),
  });
  if (admission.kind !== "admitted")
    throw new Error("synthetic TTS admission failed");
  const reservation = admission.reservation;
  const session: Pick<
    MeetingData,
    | "meetingId"
    | "guildId"
    | "reservation"
    | "finishing"
    | "finished"
    | "setFinished"
  > = {
    meetingId: id,
    guildId: id,
    reservation,
    finishing: false,
    finished: false,
    setFinished: jest.fn(),
  };
  const meeting = session as MeetingData;
  attachMeetingReservation(meeting, reservation);
  const notice = held<void>();
  const send = jest.fn(() => notice.promise);
  const connection = new EventEmitter();
  const source = parseMeetingsSource();
  const functions = selectMeetingFunctions(source, [
    "endTtsOnlySession",
    "finalizeTtsOnlySession",
    "clearTtsOnlyIdleTimeout",
  ]);
  const registrations: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "connection" &&
      node.expression.name.text === "on" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "error"
    )
      registrations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(registrations).toHaveLength(1);
  const context = vm.createContext({
    meeting,
    connection,
    textChannel: { send },
    isAutoRecording: false,
    DiscordAPIError,
    meetings: new Map([[id, meeting]]),
    clearTimeout,
    clearInterval,
    runMeetingNoticeMutation,
    runOwnedMeetingFinalization,
    assertMeetingFinalizationActive,
    settleOwnedVoiceSession,
    releaseSessionReservation,
    restoreVoiceSessionNickname: async () => true,
    console: { error: jest.fn(), warn: jest.fn() },
  });
  vm.runInContext(
    ts.transpileModule(
      functions
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n") +
        "\n" +
        registrations[0].getText(source),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  connection.emit("error", new Error("synthetic connection fault"));
  return {
    meeting,
    reservation,
    notice,
    send,
    connection,
    stop: () =>
      vm.runInContext("endTtsOnlySession(meeting)", context) as Promise<void>,
  };
}

test.each([
  "pending",
  "unknown",
  "acknowledged",
  "definitely-rejected",
] as const)(
  "normal TTS stop preserves a %s connection-error notification outcome",
  async (outcome) => {
    const f = await startTtsStop();
    if (outcome === "acknowledged") f.notice.resolve();
    else if (outcome === "unknown")
      f.notice.reject(new Error("synthetic lost notification ACK"));
    else if (outcome === "definitely-rejected")
      f.notice.reject(
        new DiscordAPIError(
          { code: 50013, message: "Synthetic denied" },
          50013,
          403,
          "POST",
          "http://localhost",
          { body: {}, files: [] },
        ),
      );
    await jest.advanceTimersByTimeAsync(0);
    const releasable =
      outcome === "acknowledged" || outcome === "definitely-rejected";
    const stopping = f.stop();
    if (releasable) await expect(stopping).resolves.toBeUndefined();
    else
      await expect(stopping).rejects.toThrow(
        "TTS voice ownership remains unresolved",
      );
    expect(releaseActiveMeetingLease).toHaveBeenCalledTimes(releasable ? 1 : 0);
    expect(f.reservation.workHandle.settle).toHaveBeenCalledTimes(
      releasable ? 1 : 0,
    );
    f.connection.emit("error", new Error("synthetic callback after TTS stop"));
    await jest.advanceTimersByTimeAsync(0);
    expect(f.send).toHaveBeenCalledTimes(1);
    if (outcome === "pending") {
      f.notice.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(f.reservation.workHandle.settle).not.toHaveBeenCalled();
    }
  },
);

function parseMeetingsSource() {
  const file = path.join(__dirname, "../src/meetings.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return source;
}

function selectMeetingFunctions(source: ts.SourceFile, selected: string[]) {
  const names = new Set([
    ...selected,
    "assertFixtureStartOptions",
    "assertVerifiedFixture",
    "resolveVoiceFeatures",
    "shouldLoadMeetingDictionary",
    "getMeeting",
    "deleteMeeting",
  ]);
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""),
  );
  expect(functions).toHaveLength(names.size);
  return functions;
}
