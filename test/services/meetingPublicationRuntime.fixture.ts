import type { MeetingHistory } from "../../src/types/db";
import { getDeploymentControlRepository } from "../../src/db";
import * as runtime from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import {
  initializeLocalControl,
  bootstrapLocalRuntime,
} from "../../src/services/runtimeLocalBootstrapService";
import {
  tryAcquireMeetingLease,
  releaseSessionReservation,
} from "../../src/services/activeMeetingLeaseService";

export async function reserveFeaturePublication(history: MeetingHistory) {
  const repository = getDeploymentControlRepository();
  const identity = {
    kind: "local" as const,
    localId: "publication-fixture",
    instanceId: "original-owner",
    protocolVersion: 1 as const,
  };
  const now = () => Math.floor(Date.now() / 1000);
  const lifecycle = runtime.createRuntimeLifecycle({
    identity,
    repository,
    checkpointAndFence: async () => {},
    protection: createRuntimeProtectionService({
      identity,
      onUnsafe: () => {},
    }),
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  await initializeLocalControl(repository, identity, now());
  await lifecycle.start();
  await bootstrapLocalRuntime(
    repository,
    identity,
    lifecycle.refreshRuntimeReadiness,
    now,
  );
  await lifecycle.refreshRuntimeReadiness();
  const work = jest
    .spyOn(runtime, "beginRuntimeWork")
    .mockImplementation(lifecycle.beginRuntimeWork);
  const admitted = await tryAcquireMeetingLease({
    sessionMode: "meeting",
    guildId: history.guildId,
    meetingId: history.meetingId,
    voiceChannelId: "voice",
    textChannelId: "text",
    isAutoRecording: false,
    reservedAt: Date.now(),
    admissionContext: await lifecycle.getRuntimeAdmissionContext(),
    history,
  });
  if (
    admitted.kind !== "admitted" ||
    admitted.reservation.sessionMode !== "meeting"
  ) {
    work.mockRestore();
    await lifecycle.shutdown();
    throw new Error("Feature publication reservation was refused");
  }
  const reservation = admitted.reservation;
  await repository.transitionMeetingHistory({
    key: reservation.historyKey,
    expectedMeetingId: reservation.meetingId,
    expectedOwnerInstanceId: reservation.ownerInstanceId,
    expectedExecutionVersion: reservation.executionVersion,
    expectedStatus: "starting",
    patch: { status: "processing" },
  });
  const row = await repository.getMeetingHistory(reservation.historyKey);
  if (!row) throw new Error("Reserved publication history missing");
  return {
    row,
    reservation,
    async close() {
      try {
        expect(await releaseSessionReservation(reservation)).toBe(true);
      } finally {
        work.mockRestore();
        await lifecycle.shutdown();
      }
    },
  };
}
