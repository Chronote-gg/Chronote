/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { createMeetingRecoveryWorker } from "../../src/services/meetingRecoveryWorkerService";
import { recoverMeeting } from "../../src/services/meetingRecoveryService";
import { recoverTranscript } from "../../src/services/meetingRecoveryContent";
import { createRuntimeLifecycle } from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
  fenceRuntimeWorkAdmissions,
} from "../../src/services/runtimeWorkAdmissionService";
import { recoveryFixture } from "./meetingRecoveryFixtures";
import { runtime, control } from "../deployment/controlFixtures";
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function workerFixture(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  content: Parameters<typeof createMeetingRecoveryWorker>[0]["content"],
) {
  return {
    repository: f.repository,
    recover: recoverMeeting,
    now: () => Math.floor(Date.now() / 1000),
    content: {
      nowMs: Date.now,
      autoExport: async () => "skipped" as const,
      reader: f.reader,
      upload: f.upload,
      transcript: recoverTranscript,
      summaries: async (input: Parameters<typeof recoverTranscript>[0]) => {
        input.summarySentence = "Saved summary";
        input.processing = { ...input.processing, summary: "generated" };
        return { summarySentence: input.summarySentence };
      },
      ...content,
    },
  };
}
function scanWorker(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  now = () => Math.floor(Date.now() / 1000),
  begin = beginRuntimeWorkClaim,
) {
  return createMeetingRecoveryWorker({
    repository: f.repository,
    begin,
    recover: recoverMeeting,
    now,
    content: {
      nowMs: Date.now,
      autoExport: async () => "skipped",
      reader: f.reader,
      upload: f.upload,
      transcript: recoverTranscript,
      notes: async () => undefined,
      summaries: async () => ({}),
      send: async () => {
        throw new Error("Unexpected scan delivery");
      },
    },
  });
}
async function verifyNewWorkerCursorContinuation(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
) {
  const original = f.histories.get("guild")!;
  const rows = Array.from({ length: 2101 }, (_, index) => ({
    ...original[0],
    channelId_timestamp: `scan#${String(index).padStart(4, "0")}`,
    status: index === 2100 ? ("processing" as const) : ("complete" as const),
    recovery: undefined,
  }));
  f.histories.set("guild", rows);
  const reads = jest
    .spyOn(f.repository, "getMeetingHistory")
    .mockResolvedValue(undefined);
  const pages = jest.spyOn(f.repository, "discoverRecordingRecoveries");
  const first = scanWorker(f);
  await first.poll();
  await first.stop();
  expect(pages).toHaveBeenCalledTimes(20);
  expect(reads).not.toHaveBeenCalled();
  expect(await f.repository.getRecord("ENV", "CONTROL")).toMatchObject({
    recoveryScanCursor: { channelId_timestamp: "scan#1999" },
  });
  const restarted = scanWorker(f);
  await restarted.poll();
  await restarted.stop();
  expect(pages).toHaveBeenCalledTimes(22);
  expect(reads).toHaveBeenCalledWith(
    { guildId: "guild", channelId_timestamp: "scan#2100" },
    expect.any(AbortSignal),
  );
  expect(await f.repository.getRecord("ENV", "CONTROL")).not.toHaveProperty(
    "recoveryScanCursor",
    expect.anything(),
  );
  pages.mockRestore();
  reads.mockRestore();
  f.histories.set("guild", original);
}
async function verifyScanSchedulingBounds(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
) {
  const original = f.histories.get("guild")!;
  const initial = structuredClone(
    f.records.get(JSON.stringify(["ENV", "CONTROL"])),
  );
  f.histories.set(
    "guild",
    Array.from({ length: 301 }, (_, index) => ({
      ...original[0],
      channelId_timestamp: `budget#${String(index).padStart(3, "0")}`,
      status: "complete" as const,
      recovery: undefined,
    })),
  );
  const discover = f.repository.discoverRecordingRecoveries.bind(f.repository);
  let clock = f.now;
  const pages = jest
    .spyOn(f.repository, "discoverRecordingRecoveries")
    .mockImplementation(async (cursor) => {
      const page = await discover(cursor);
      clock += 5;
      return page;
    });
  const first = scanWorker(f, () => clock);
  await first.poll();
  await first.stop();
  expect(pages).toHaveBeenCalledTimes(2);
  expect(await f.repository.getRecord("ENV", "CONTROL")).toMatchObject({
    recoveryScanCursor: { channelId_timestamp: "budget#199" },
  });
  const second = scanWorker(f, () => clock);
  await second.poll();
  await second.stop();
  expect(pages).toHaveBeenCalledTimes(4);
  pages.mockRestore();
  f.records.set(JSON.stringify(["ENV", "CONTROL"]), structuredClone(initial));
  const writes = jest
    .spyOn(f.repository, "saveRecoveryCursor")
    .mockResolvedValueOnce(false);
  const rejectedPages = jest.spyOn(f.repository, "discoverRecordingRecoveries");
  const rejected = scanWorker(f);
  await rejected.poll();
  await rejected.stop();
  expect(rejectedPages).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await f.repository.getRecord("ENV", "CONTROL")).toEqual(initial);
  writes.mockRestore();
  rejectedPages.mockRestore();
  const stopped = scanWorker(f);
  const stoppingPages = jest
    .spyOn(f.repository, "discoverRecordingRecoveries")
    .mockImplementationOnce(async (cursor) => {
      const page = await discover(cursor);
      void stopped.stop();
      return page;
    });
  await stopped.poll();
  await stopped.stop();
  expect(stoppingPages).toHaveBeenCalledTimes(1);
  expect(await f.repository.getRecord("ENV", "CONTROL")).toEqual(initial);
  stoppingPages.mockRestore();
  let lost = false;
  const losing = scanWorker(
    f,
    () => f.now,
    (...args) => {
      const work = beginRuntimeWorkClaim(...args);
      return {
        ...work,
        authority: async () => {
          if (lost) throw new Error("serving admission lost");
          return work.authority();
        },
      };
    },
  );
  const lostPages = jest
    .spyOn(f.repository, "discoverRecordingRecoveries")
    .mockImplementationOnce(async (cursor) => {
      const page = await discover(cursor);
      lost = true;
      return page;
    });
  await losing.poll();
  await losing.stop();
  expect(lostPages).toHaveBeenCalledTimes(1);
  expect(await f.repository.getRecord("ENV", "CONTROL")).not.toHaveProperty(
    "recoveryScanCursor",
    expect.anything(),
  );
  lostPages.mockRestore();
  f.histories.set("guild", original);
  f.records.set(JSON.stringify(["ENV", "CONTROL"]), initial);
}

async function verifyCursorFailurePolling(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  lifecycle: ReturnType<typeof createRuntimeLifecycle>,
  mode: "exact" | "unavailable" | "different" | "read",
) {
  const original = f.histories.get("guild")!;
  const control = await f.repository.getRecord("ENV", "CONTROL");
  if (control?.recordType !== "control") throw new Error("fixture");
  const baseline = lifecycle.getWorkCounts().pending_admission;
  f.histories.set(
    "guild",
    Array.from({ length: 211 }, (_, index) => ({
      ...original[0],
      channelId_timestamp: `cursor-${mode}#${String(index).padStart(3, "0")}`,
      status: "processing" as const,
      recovery: undefined,
    })),
  );
  const reads = jest
    .spyOn(f.repository, "getMeetingHistory")
    .mockResolvedValue(undefined);
  if (mode === "read")
    reads.mockRejectedValueOnce(new Error("read failed before mutation"));
  const readback = jest.spyOn(f.repository, "getRecord");
  const save = f.repository.saveRecoveryCursor.bind(f.repository);
  const writes = jest.spyOn(f.repository, "saveRecoveryCursor");
  if (mode !== "read")
    writes.mockImplementationOnce(async (...args) => {
      expect(await save(...args)).toBe(true);
      if (mode === "unavailable")
        readback.mockRejectedValueOnce(new Error("unavailable"));
      if (mode === "different")
        f.records.get(JSON.stringify(["ENV", "CONTROL"])).coordinatorToken =
          "later";
      throw new Error("cursor committed but ACK lost");
    });
  const worker = scanWorker(f);
  try {
    await worker.poll();
    expect(reads).toHaveBeenCalledTimes(
      mode === "exact" ? 211 : mode === "read" ? 1 : 100,
    );
    expect(lifecycle.getWorkCounts().pending_admission).toBe(
      baseline + (["unavailable", "different"].includes(mode) ? 1 : 0),
    );
    if (mode !== "exact") await worker.poll();
    expect(
      new Set(reads.mock.calls.map(([key]) => key.channelId_timestamp)).size,
    ).toBe(211);
    if (mode === "read") expect(reads).toHaveBeenCalledTimes(212);
    if (mode === "different") expect(writes).toHaveBeenCalledTimes(1);
  } finally {
    await worker.stop();
    reads.mockRestore();
    writes.mockRestore();
    readback.mockRestore();
    f.histories.set("guild", original);
    f.records.set(JSON.stringify(["ENV", "CONTROL"]), control);
  }
}

async function readyWorkerFixture(guildId?: string) {
  const { createRuntimeLifecycle, installRuntimeLifecycle } =
    await import("../../src/services/runtimeLifecycleService");
  const f = await recoveryFixture(undefined, { guildId });
  const history = f.histories.get(guildId ?? "guild")![0];
  history.ownerInstanceId = "old";
  history.executionVersion = 1;
  history.recovery = undefined;
  f.leases.clear();
  const old = runtime("old");
  old.readiness.expiresAt = f.now - 1;
  old.workCounts = {
    recording: 1,
    pending_admission: 0,
    finalization: 0,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 1,
    ancillary_delivery: 0,
  };
  const candidate = runtime("replacement", "candidate");
  if (candidate.identity.kind !== "ecs" || old.identity.kind !== "ecs")
    throw new Error("fixture");
  candidate.identity.candidateId = old.identity.candidateId;
  const state = {
    ...control,
    coordinatorExpiresAt: f.now - 1,
    deployment: {
      runToken: "completed-rollout",
      cluster: "fixture",
      service: "fixture",
      family: "fixture",
      tablePrefix: "fixture",
      candidateId: "old",
      image: "fixture",
      runtimeMode: "all" as const,
      phase: "complete" as const,
      originalGeneration: 6,
      originalMembers: [runtime("previous").identity],
      outgoing: runtime("previous").identity,
      previousTaskDefinition: "fixture:1",
      taskDefinition: "fixture:2",
      candidate: old.identity,
      updatedAt: f.now - 10,
    },
  };
  f.records.set(JSON.stringify(["ENV", "CONTROL"]), structuredClone(state));
  f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), structuredClone(old));
  const protection = createRuntimeProtectionService({
    identity: candidate.identity,
    agentUri: "http://fixture.invalid",
    request: async () =>
      new Response(
        JSON.stringify({
          protection: {
            TaskArn:
              candidate.identity.kind === "ecs"
                ? candidate.identity.taskArn
                : "",
            ProtectionEnabled: true,
            ExpirationDate: new Date((f.now + 600) * 1000).toISOString(),
          },
        }),
      ),
    onUnsafe: () => {},
    now: () => Math.floor(Date.now() / 1000),
  });
  const lifecycle = createRuntimeLifecycle({
    identity: candidate.identity,
    repository: f.repository,
    protection,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  installRuntimeLifecycle(lifecycle);
  await lifecycle.start();
  return { f, lifecycle };
}

test("actual compatible replacement discovers recovery, owns renewal tails, seals synchronously and retains unknown delivery", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00Z") });
  const { f, lifecycle } = await readyWorkerFixture();
  await verifyNewWorkerCursorContinuation(f);
  await verifyScanSchedulingBounds(f);
  expect(
    (await lifecycle.getRuntimeAdmissionContext()).authorizedGeneration,
  ).toBe(8);
  expect(await f.repository.getRecord("ENV", "RUNTIME#old")).toMatchObject({
    role: "draining",
    workCounts: { recording: 1, voice_operation: 1 },
  });
  const entered = barrier(),
    generation = barrier(),
    renewed = barrier(),
    renewal = barrier();
  const originalRenew = f.repository.renewRecordingRecovery;
  jest
    .spyOn(f.repository, "renewRecordingRecovery")
    .mockImplementationOnce(async (...args) => {
      renewed.resolve();
      await renewal.promise;
      return originalRenew(...args);
    });
  const send = jest.fn(async () => {
    throw new Error("unknown send ACK");
  });
  const worker = createMeetingRecoveryWorker({
    begin: beginRuntimeWorkClaim,
    ...workerFixture(f, {
      send,
      notes: async (input) => {
        entered.resolve();
        await generation.promise;
        input.notesText = "Verified saved conversation";
        input.processing = { ...input.processing, notes: "generated" };
        return input.notesText;
      },
    }),
  });
  const polling = worker.poll();
  expect(lifecycle.getWorkCounts().pending_admission).toBe(1);
  await entered.promise;
  expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
  await jest.advanceTimersByTimeAsync(10000);
  await renewed.promise;
  const stopped = worker.stop();
  let finished = false;
  void stopped.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  generation.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  renewal.resolve();
  await polling;
  await stopped;
  expect(send).toHaveBeenCalledTimes(1);
  expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
  expect(
    getRuntimeWorkAdmissionCheckpoints().filter(
      (row) => row.domain === "recovery",
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ fenced: true, localSettled: true }),
    ]),
  );
  await worker.poll();
  expect(send).toHaveBeenCalledTimes(1);
  for (const mode of ["exact", "unavailable", "read", "different"] as const)
    await verifyCursorFailurePolling(f, lifecycle, mode);
  fenceRuntimeWorkAdmissions();
  await lifecycle.shutdown();
  jest.useRealTimers();
});

test.each(["retained", "active"] as const)(
  "an exactly owned %s recovery does not starve later keys or replay on the next poll",
  async (mode) => {
    await jest.isolateModulesAsync(async () => {
      const { createMeetingRecoveryWorker } =
        await import("../../src/services/meetingRecoveryWorkerService");
      const {
        beginRuntimeWorkClaim,
        getRuntimeWorkAdmissionCheckpoints,
        fenceRuntimeWorkAdmissions,
      } = await import("../../src/services/runtimeWorkAdmissionService");
      jest.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00Z") });
      const { f, lifecycle } = await readyWorkerFixture("n6-a");
      const second = await recoveryFixture(undefined, { guildId: "n6-b" });
      const later = second.histories.get("n6-b")![0];
      later.ownerInstanceId = "old";
      later.executionVersion = 1;
      later.recovery = undefined;
      later.textChannelId = "later-text";
      f.histories.set("n6-b", [later]);
      for (const [key, value] of second.objects) f.objects.set(key, value);
      f.histories.set(
        "n6-z",
        Array.from({ length: 99 }, (_, i) => ({
          ...later,
          guildId: "n6-z",
          channelId_timestamp: `filler#${i.toString().padStart(3, "0")}`,
          status: "complete",
          recovery: undefined,
        })),
      );
      const firstKey = {
        guildId: "n6-a",
        channelId_timestamp: f.histories.get("n6-a")![0].channelId_timestamp,
      };
      const firstId = `recovery:${firstKey.guildId}:${firstKey.channelId_timestamp}`;
      const writes = jest.spyOn(f.repository, "saveRecoveryCursor");
      let deliverySequence = 0;
      const send = jest.fn(async (channel: string) => {
        if (channel !== "later-text")
          throw new Error("actual first delivery ACK lost");
        return { id: `later-message-${++deliverySequence}` };
      });
      const entered = barrier(),
        gate = barrier();
      let active: Promise<boolean> | undefined;
      const generateNotes: typeof import("../../src/services/meetingNotesService").ensureMeetingNotes =
        async (input) => {
          if (mode === "active" && input.guildId === "n6-a") {
            entered.resolve();
            await gate.promise;
          }
          input.notesText = "Verified conversation.";
          input.processing = { ...input.processing, notes: "generated" };
          return input.notesText;
        };
      const notes = jest.fn(generateNotes);
      const worker = createMeetingRecoveryWorker({
        begin: beginRuntimeWorkClaim,
        ...workerFixture(f, { send, notes }),
      });
      try {
        const refused = scanWorker(
          f,
          () => f.now,
          (...args) => {
            if (args[1] === firstId)
              throw new Error("genuine admission refusal");
            return beginRuntimeWorkClaim(...args);
          },
        );
        await refused.poll();
        await refused.stop();
        expect(writes).not.toHaveBeenCalled();
        const unproved = beginRuntimeWorkClaim("recovery", firstId);
        const unknownOwner = scanWorker(f, () => f.now, beginRuntimeWorkClaim);
        await unknownOwner.poll();
        await unknownOwner.stop();
        expect(writes).not.toHaveBeenCalled();
        unproved.acknowledgeReadOnlyRecoveryPoll();
        await unproved.settle();
        if (mode === "active") {
          active = worker.process(firstKey);
          await entered.promise;
        }
        await worker.poll();
        if (active) {
          gate.resolve();
          await active;
        }
        expect(
          send.mock.calls.filter(([channel]) => channel !== "later-text"),
        ).toHaveLength(1);
        expect(
          send.mock.calls.filter(([channel]) => channel === "later-text"),
        ).toHaveLength(2);
        expect(f.histories.get("n6-b")![0].recovery).toMatchObject({
          disposition: "done",
        });
        expect(writes).toHaveBeenCalledTimes(2);
        expect(writes.mock.calls[0][2]).toMatchObject({
          guildId: "n6-z",
          channelId_timestamp: "filler#097",
        });
        const retained = getRuntimeWorkAdmissionCheckpoints().find(
          (entry) => entry.id === firstId,
        )!;
        expect(retained).toMatchObject({
          fenced: true,
          localSettled: true,
          stage: "unresolved",
        });
        const originalHistory = structuredClone(f.histories.get("n6-a")![0]);
        const originalLease = structuredClone(f.leases.get("n6-a"));
        expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
        await worker.poll();
        expect(send).toHaveBeenCalledTimes(3);
        expect(notes).toHaveBeenCalledTimes(2);
        expect(writes).toHaveBeenCalledTimes(4);
        expect(f.histories.get("n6-a")![0]).toEqual(originalHistory);
        expect(f.leases.get("n6-a")).toEqual(originalLease);
        expect(
          getRuntimeWorkAdmissionCheckpoints().find(
            (entry) => entry.id === firstId,
          )?.signal,
        ).toBe(retained.signal);
        expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
        const registry =
          await import("../../src/services/runtimeWorkAdmissionService");
        const snapshot = registry.getRuntimeWorkAdmissionCheckpoints();
        const stale = jest
          .spyOn(registry, "getRuntimeWorkAdmissionCheckpoints")
          .mockReturnValue(
            snapshot.map((entry) =>
              entry.id === firstId
                ? { ...entry, signal: new AbortController().signal }
                : entry,
            ),
          );
        try {
          await worker.poll();
          expect(writes).toHaveBeenCalledTimes(4);
          expect(send).toHaveBeenCalledTimes(3);
        } finally {
          stale.mockRestore();
        }
      } finally {
        gate.resolve();
        await active;
        await worker.stop();
        fenceRuntimeWorkAdmissions();
        await lifecycle.shutdown();
        jest.useRealTimers();
      }
    });
  },
);
