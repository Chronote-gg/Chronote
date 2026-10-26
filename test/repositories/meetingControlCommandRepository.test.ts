/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { getMockStore } from "../../src/repositories/mockStore";
import { context, control, runtime } from "../deployment/controlFixtures";
import {
  getMeetingControlCommandRepository,
  resetMeetingControlCommandMemoryRepository,
} from "../../src/repositories/meetingControlCommandRepository";
import type { MeetingControlCommand } from "../../src/types/meetingControl";

const makeCommand = (
  overrides?: Partial<MeetingControlCommand>,
): MeetingControlCommand => ({
  requestId: "request-1",
  queueStatus: "pending",
  commandType: "start_meeting",
  userId: "user-1",
  input: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: 1_767_225_600,
  ...overrides,
});

describe("meetingControlCommandRepository", () => {
  beforeEach(() => {
    const store = getMockStore();
    store.deploymentControlRecords.clear();
    for (const row of [control, runtime("old")])
      store.deploymentControlRecords.set(
        JSON.stringify([row.pk, row.sk]),
        structuredClone(row),
      );
  });
  test("noClaimAfterRetiringAcknowledgment", async () => {
    const records = getMockStore().deploymentControlRecords;
    for (const row of [
      control,
      { ...runtime("old"), role: "retired" as const },
    ])
      records.set(JSON.stringify([row.pk, row.sk]), row);
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());
    expect(
      await repository.claimCommand({
        requestId: "request-1",
        instanceId: "old",
        nowEpochSeconds: 100,
        claimExpiresAt: 160,
        updatedAt: "now",
        claimId: "fixture-claim",
        authority: { kind: "serving", context },
      }),
    ).toBeUndefined();
  });
  afterEach(() => {
    resetMeetingControlCommandMemoryRepository();
  });

  test("lists and claims unowned pending commands", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());

    await expect(
      repository.listClaimablePendingCommands({
        instanceId: "old",
        nowEpochSeconds: 100,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);

    const claimed = await repository.claimCommand({
      requestId: "request-1",
      instanceId: "old",
      nowEpochSeconds: 100,
      claimExpiresAt: 160,
      updatedAt: "2026-01-01T00:00:01.000Z",
      claimId: "synthetic-claim",
      authority: { kind: "serving", context },
    });

    expect(claimed).toMatchObject({
      requestId: "request-1",
      claimedByInstanceId: "old",
      claimExpiresAt: 160,
    });
  });

  test("only lists targeted commands for the owner instance", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(
      makeCommand({ requestId: "request-1", targetOwnerInstanceId: "owner-1" }),
    );
    await repository.writeCommand(
      makeCommand({ requestId: "request-2", targetOwnerInstanceId: "owner-2" }),
    );

    await expect(
      repository.listClaimablePendingCommands({
        instanceId: "owner-1",
        nowEpochSeconds: 100,
        limit: 10,
      }),
    ).resolves.toMatchObject([{ requestId: "request-1" }]);
  });

  test("does not claim commands targeted to another owner instance", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(
      makeCommand({ requestId: "request-1", targetOwnerInstanceId: "owner-1" }),
    );

    await expect(
      repository.claimCommand({
        requestId: "request-1",
        instanceId: "owner-2",
        nowEpochSeconds: 100,
        claimExpiresAt: 160,
        updatedAt: "2026-01-01T00:00:01.000Z",
        claimId: "synthetic-claim",
        authority: { kind: "serving", context },
      }),
    ).resolves.toBeUndefined();
  });

  test("does not list or claim expired pending commands", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(
      makeCommand({ requestId: "request-1", expiresAt: 100 }),
    );

    await expect(
      repository.listClaimablePendingCommands({
        instanceId: "old",
        nowEpochSeconds: 101,
        limit: 10,
      }),
    ).resolves.toHaveLength(0);

    await expect(
      repository.claimCommand({
        requestId: "request-1",
        instanceId: "old",
        nowEpochSeconds: 101,
        claimExpiresAt: 160,
        updatedAt: "2026-01-01T00:00:01.000Z",
        claimId: "synthetic-claim",
        authority: { kind: "serving", context },
      }),
    ).resolves.toBeUndefined();
  });

  test("completes commands claimed by the same worker", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());
    await repository.claimCommand({
      requestId: "request-1",
      instanceId: "old",
      nowEpochSeconds: 100,
      claimExpiresAt: 160,
      updatedAt: "2026-01-01T00:00:01.000Z",
      claimId: "synthetic-claim",
      authority: { kind: "serving", context },
    });

    await expect(
      repository.completeCommand({
        requestId: "request-1",
        instanceId: "old",
        updatedAt: "2026-01-01T00:00:02.000Z",
        claimId: "synthetic-claim",
        nowEpochSeconds: 102,
        result: {
          status: "started",
          serverId: "guild-1",
          meetingId: "meeting-1",
          voiceChannelId: "voice-1",
          textChannelId: "text-1",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
    ).resolves.toBe(true);

    await expect(repository.getCommand("request-1")).resolves.toMatchObject({
      queueStatus: "completed",
      result: { status: "started", meetingId: "meeting-1" },
    });
  });
});
