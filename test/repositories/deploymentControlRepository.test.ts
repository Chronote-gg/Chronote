/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import {
  createMockDeploymentControlRepository,
  classifyDeploymentTransactionError,
} from "../../src/repositories/deploymentControlRepository";
import { buildHistoryTransition } from "../../src/services/deploymentControlTransactions";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type {
  DeploymentControlRecord,
  HistoryTransition,
} from "../../src/types/deploymentControl";
import { parseDeploymentControlRecord } from "../../src/types/deploymentControl";
import {
  context,
  control,
  runtime,
  promotion,
  history,
} from "../deployment/controlFixtures";

test("paused draft markers are strict durable control records", async () => {
  const marker = buildPausedDesktopDraftMarker({
    uploadId: "synthetic-draft",
    ownerUserId: "synthetic-owner",
  });
  expect(parseDeploymentControlRecord(marker)).toEqual(marker);
  const records = new Map<string, DeploymentControlRecord>();
  const repository = createMockDeploymentControlRepository(records);
  const key = JSON.stringify([marker.pk, marker.sk]);
  for (const patch of [
    { pk: "UPLOAD#other" },
    { manifestSha256: "bad" },
    { expiresAt: 200 },
    { ownerUserId: "" },
  ]) {
    const invalid = { ...marker, ...patch };
    expect(() => parseDeploymentControlRecord(invalid)).toThrow();
    records.set(key, invalid);
    await expect(repository.getRecord(marker.pk, marker.sk)).rejects.toThrow();
  }
});

test("runtime read snapshots preserve retirement compare-and-swap authority", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({ ...control, servingMembers: {} });
  const row = runtime("old", "candidate");
  await repository.writeRuntime(row);
  const request = {
    identity: row.identity,
    authorizedGeneration: row.authorizedGeneration,
    coordinatorToken: control.coordinatorToken,
    coordinatorEpoch: control.coordinatorEpoch,
  };
  expect(
    await repository.requestRetirement({ record: row, request, now: 100 }),
  ).toBe("applied");
  const snapshot = await repository.getRecord(row.pk, row.sk);
  if (snapshot?.recordType !== "runtime")
    throw new Error("Runtime fixture missing");
  expect(snapshot.retirementRequest).toEqual(request);
  expect(
    await repository.transitionRuntimeRole({
      record: { ...snapshot, role: "draining" },
      expectedRole: snapshot.role,
      expectedGeneration: snapshot.authorizedGeneration,
      retirementEpoch: control.coordinatorEpoch,
      expectedRetirementRequest: snapshot.retirementRequest,
    }),
  ).toBe("applied");
  expect(await repository.getRecord(row.pk, row.sk)).toMatchObject({
    role: "draining",
    retirementRequest: request,
  });
});

test("missingControlRejectsAdmission", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.writeRuntime(runtime("old"));
  expect(await repository.checkAdmission(context)).toEqual({
    kind: "blocked",
    reason: "not_serving",
  });
});

test("promotionAndOldAdmissionHaveOnlyTwoLegalOrders", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(control);
  await repository.writeRuntime(runtime("old"));
  await repository.writeRuntime(runtime("new", "candidate"));
  expect((await repository.checkAdmission(context)).kind).toBe("admitted");
  expect(await repository.promote(promotion)).toBe("applied");
  expect((await repository.checkAdmission(context)).kind).toBe("blocked");
  expect(
    (
      await repository.checkAdmission({
        ...context,
        instanceId: "new",
        identity: runtime("new").identity,
        authorizedGeneration: 8,
      })
    ).kind,
  ).toBe("admitted");
});

test("staleEpochCannotPromote", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(control);
  await repository.writeRuntime(runtime("new", "candidate"));
  expect(await repository.promote({ ...promotion, coordinatorEpoch: 2 })).toBe(
    "stale",
  );
});

test("coordinator warmup does not seal healthy serving generation", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({ ...control, coordinatorEpoch: 4 });
  await repository.writeRuntime(runtime("old"));
  expect((await repository.checkAdmission(context)).kind).toBe("admitted");
  const candidate = runtime("new", "candidate");
  await repository.writeRuntime(candidate);
  expect(await repository.promote({ ...promotion, coordinatorEpoch: 4 })).toBe(
    "stale",
  );
  await repository.writeRuntime({
    ...candidate,
    readiness: { ...candidate.readiness, observedEpoch: 4 },
  });
  expect(await repository.promote({ ...promotion, coordinatorEpoch: 4 })).toBe(
    "applied",
  );
  expect((await repository.checkAdmission(context)).kind).toBe("blocked");
});

test("membership input rejects duplicate and unselected retained runtimes", async () => {
  const repository = createMockDeploymentControlRepository();
  await expect(
    repository.promote({
      ...promotion,
      retainedMembers: [runtime("unknown").identity],
    }),
  ).rejects.toThrow();
  await expect(
    repository.promote({
      ...promotion,
      retainedMembers: [runtime("old").identity, runtime("old").identity],
    }),
  ).rejects.toThrow();
  await expect(
    repository.promote({
      ...promotion,
      expectedServingMembers: [runtime("new").identity],
      retainedMembers: [runtime("new").identity],
    }),
  ).rejects.toThrow();
});

test("membership order is irrelevant and retained API requires no gateway", async () => {
  const repository = createMockDeploymentControlRepository();
  const api = runtime("api");
  api.readiness.runtimeMode = "api";
  api.readiness.gatewayReady = false;
  await repository.initializeControl({
    ...control,
    servingMembers: { old: runtime("old").identity, api: api.identity },
  });
  await repository.writeRuntime(runtime("old"));
  await repository.writeRuntime(runtime("new", "candidate"));
  await repository.writeRuntime(api);
  expect(
    await repository.promote({
      ...promotion,
      expectedServingMembers: [api.identity, runtime("old").identity],
      retainedMembers: [api.identity],
    }),
  ).toBe("applied");
  expect(
    (
      await repository.checkAdmission({
        ...context,
        instanceId: "api",
        identity: api.identity,
        authorizedGeneration: 8,
      })
    ).kind,
  ).toBe("admitted");
});

test("API readiness cannot satisfy combined runtime mode", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(control);
  const candidate = runtime("new", "candidate");
  candidate.readiness.runtimeMode = "api";
  candidate.readiness.gatewayReady = false;
  await repository.writeRuntime(candidate);
  expect(await repository.promote(promotion)).toBe("stale");
  expect(
    await repository.promote({ ...promotion, candidateRuntimeMode: "api" }),
  ).toBe("applied");
});

test("lateInitialHistoryCannotOverwriteProgress", async () => {
  const repository = createMockDeploymentControlRepository();
  expect(await repository.createInitialMeetingHistory(history)).toBe("applied");
  const transition = {
    key: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
    expectedMeetingId: "meeting",
    expectedOwnerInstanceId: "old",
    expectedExecutionVersion: 1,
    expectedStatus: "starting" as const,
    patch: { status: "processing" as const },
  };
  expect(await repository.transitionMeetingHistory(transition)).toBe("applied");
  expect(await repository.createInitialMeetingHistory(history)).toBe("stale");
  expect(await repository.transitionMeetingHistory(transition)).toBe("stale");
  expect((await repository.getMeetingHistory(transition.key))?.status).toBe(
    "processing",
  );
});

test("ordinary history progress preserves the execution attempt fence", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.createInitialMeetingHistory(history);
  const key = {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
  for (const [expectedStatus, status] of [
    ["starting", "in_progress"],
    ["in_progress", "processing"],
  ] as const) {
    const transition = {
      key,
      expectedMeetingId: "meeting",
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus,
      patch: { status },
    };
    expect(
      await repository.transitionMeetingHistory({
        ...transition,
        expectedExecutionVersion: 2,
      }),
    ).toBe("stale");
    expect(
      await repository.transitionMeetingHistory({
        ...transition,
        expectedOwnerInstanceId: "former-owner",
      }),
    ).toBe("stale");
    expect(await repository.transitionMeetingHistory(transition)).toBe(
      "applied",
    );
    expect(await repository.getMeetingHistory(key)).toMatchObject({
      status,
      executionVersion: 1,
      ownerInstanceId: "old",
    });
    expect(await repository.transitionMeetingHistory(transition)).toBe("stale");
  }
});

test("ttlNeverDeletesUnsettledVoice", () => {
  const voice = {
    pk: "VOICE#guild",
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: "guild",
    ownerInstanceId: "old",
    meetingId: "meeting",
    attemptId: "attempt",
    state: "uncertain",
    updatedAt: 100,
  };
  expect(parseDeploymentControlRecord(voice)).not.toHaveProperty("expiresAt");
  expect(() =>
    parseDeploymentControlRecord({ ...voice, expiresAt: 200 }),
  ).toThrow();
  expect(() =>
    parseDeploymentControlRecord({ ...control, expiresAt: 200 }),
  ).toThrow();
  expect(() =>
    parseDeploymentControlRecord({ ...runtime("old"), expiresAt: 200 }),
  ).toThrow();
});

test.each(["gatewayReady", "cacheReady", "dependenciesReady"] as const)(
  "admission rejects false %s proof",
  async (field) => {
    const repository = createMockDeploymentControlRepository();
    await repository.initializeControl(control);
    const row = runtime("old");
    row.readiness[field] = false;
    await repository.writeRuntime(row);
    expect((await repository.checkAdmission(context)).kind).toBe("blocked");
  },
);

test("errors distinguish conflicts, stale conditions and outages", () => {
  expect(
    classifyDeploymentTransactionError({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }],
    }),
  ).toBe("conflict");
  expect(
    classifyDeploymentTransactionError({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    }),
  ).toBe("stale");
  expect(
    classifyDeploymentTransactionError(new Error("connection refused")),
  ).toBe("unavailable");
  expect(
    classifyDeploymentTransactionError({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ValidationError" }],
    }),
  ).toBe("unavailable");
});

test("proofs cannot bind a local confirmation to an ECS runtime", () => {
  const row = runtime("old");
  expect(() =>
    parseDeploymentControlRecord({
      ...row,
      protection: {
        ...row.protection,
        identity: {
          kind: "local",
          localId: "fixture",
          instanceId: "old",
          protocolVersion: 1,
        },
      },
    }),
  ).toThrow();
});

test("voice CAS rejects stale settlement and replacing an unsettled attempt", async () => {
  const repository = createMockDeploymentControlRepository();
  const voice = {
    pk: "VOICE#guild",
    sk: "STATE" as const,
    recordType: "voice" as const,
    protocolVersion: 1 as const,
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "old",
    attemptId: "first",
    state: "uncertain" as const,
    updatedAt: 100,
  };
  expect(await repository.writeVoice(voice)).toBe("applied");
  expect(
    await repository.writeVoice({ ...voice, attemptId: "second" }, voice),
  ).toBe("stale");
  expect(
    await repository.writeVoice(
      { ...voice, state: "settled" },
      { ...voice, ownerInstanceId: "other" },
    ),
  ).toBe("stale");
  expect(
    await repository.writeVoice(
      { ...voice, state: "settled" },
      { ...voice, meetingId: "other" },
    ),
  ).toBe("stale");
  expect(
    await repository.writeVoice({ ...voice, state: "settled" }, voice),
  ).toBe("applied");
  expect(
    await repository.writeVoice({ ...voice, state: "connected" }, voice),
  ).toBe("stale");
  expect(
    await repository.writeVoice(
      { ...voice, attemptId: "second", state: "joining" },
      { ...voice, state: "settled" },
    ),
  ).toBe("applied");
});

test("stale runtime heartbeats cannot restore the prior generation", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(control);
  await repository.writeRuntime(runtime("new", "candidate"));
  await repository.promote(promotion);
  expect(await repository.writeRuntime(runtime("new", "candidate"))).toBe(
    "stale",
  );
});

test("history patch cannot replace unrelated data or rewind status", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.createInitialMeetingHistory(history);
  const transition = {
    key: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
    expectedMeetingId: "meeting",
    expectedOwnerInstanceId: "old",
    expectedExecutionVersion: 1,
    expectedStatus: "complete" as const,
    patch: { status: "starting" as const },
  };
  await expect(repository.transitionMeetingHistory(transition)).rejects.toThrow(
    "Illegal history status transition",
  );
  await expect(
    repository.transitionMeetingHistory({
      ...transition,
      patch: { status: "failed", ...{ ownerInstanceId: "unrelated" } },
    }),
  ).rejects.toThrow("not allowed");
});

function notesTimingFixture() {
  const timing = {
    kind: "first",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt: "2026-10-16T12:00:30.000Z",
  } as const;
  const recovery = {
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
    stage: "delivery",
    attempt: 0,
    executionVersion: 1,
    retry: { maxAttempts: 3, nextAttemptAt: null },
  } as const;
  const row: MeetingHistory = {
    ...history,
    status: "processing",
    notesDeliveryTiming: timing,
    recovery,
  };
  const ownership = {
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "voice",
    sessionMode: "meeting" as const,
  };
  const lease: ActiveMeetingLease = {
    ...ownership,
    voiceChannelId: "channel",
    textChannelId: "text",
    isAutoRecording: false,
    leaseExpiresAt: 200,
    expiresAt: 300,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  };
  const repository = createMockDeploymentControlRepository(
    new Map(),
    new Map([["guild", [row]]]),
    new Map([["guild", lease]]),
  );
  const input: HistoryTransition = {
    key: { guildId: row.guildId, channelId_timestamp: row.channelId_timestamp },
    expectedMeetingId: "meeting",
    expectedOwnerInstanceId: "old",
    expectedExecutionVersion: 1,
    expectedStatus: "processing",
    expectedCheckpointRevision: 0,
    signal: new AbortController().signal,
    recordingDelivery: {
      kind: "recording_delivery",
      phase: "acknowledgment",
      ownership,
      now: 100,
      previous: {
        recovery,
        summaryMessageId: undefined,
        notesMessageIds: undefined,
        notesChannelId: undefined,
        notesDeliveryTiming: timing,
      },
    },
    patch: {
      recovery,
      notesMessageIds: ["notes"],
      notesChannelId: "text",
      notesDeliveryTiming: {
        ...timing,
        kind: "complete",
        completeAcknowledgedAt: "2026-10-16T12:00:45.000Z",
      },
    },
  };
  return { timing, row, input, repository };
}

test("Dynamo timing condition compares the exact previous value and absence", () => {
  const { input, timing } = notesTimingFixture();
  const tables = { deploymentControl: "control", meetingHistory: "history" };
  const update = buildHistoryTransition(input, tables);
  expect(update.ExpressionAttributeNames).toMatchObject({
    "#delivery0": "recovery",
    "#delivery1": "summaryMessageId",
    "#delivery2": "notesMessageIds",
    "#delivery3": "notesChannelId",
    "#delivery4": "notesDeliveryTiming",
  });
  expect(update.ConditionExpression).toContain(" AND #delivery4 = :delivery4");
  expect(update.ExpressionAttributeValues?.[":delivery4"]).toEqual({
    M: {
      kind: { S: timing.kind },
      notesVersion: { N: "1" },
      path: { S: "live" },
      firstAcknowledgedAt: { S: timing.firstAcknowledgedAt },
    },
  });
  const absent = buildHistoryTransition(
    {
      ...input,
      recordingDelivery: {
        ...input.recordingDelivery!,
        previous: {
          ...input.recordingDelivery!.previous,
          notesDeliveryTiming: undefined,
        },
      },
    },
    tables,
  );
  expect(absent.ConditionExpression).toContain(
    " AND attribute_not_exists(#delivery4)",
  );
  expect(absent.ExpressionAttributeValues).not.toHaveProperty(":delivery4");
});

test("mock timing comparison rejects a stale prior value including missing proof field", async () => {
  const { input, row, repository } = notesTimingFixture();
  const stale: HistoryTransition = {
    ...input,
    recordingDelivery: {
      ...input.recordingDelivery!,
      previous: {
        ...input.recordingDelivery!.previous,
        notesDeliveryTiming: undefined,
      },
    },
  };
  expect(await repository.transitionMeetingHistory(stale)).toBe("stale");
  delete stale.recordingDelivery!.previous.notesDeliveryTiming;
  expect(await repository.transitionMeetingHistory(stale)).toBe("stale");
  expect(row.notesDeliveryTiming?.kind).toBe("first");
  expect(await repository.transitionMeetingHistory(input)).toBe("applied");
  expect(row.notesDeliveryTiming?.kind).toBe("complete");
});

test("timed notes acknowledgement retains the original lease owner fence", async () => {
  const { input, row, repository } = notesTimingFixture();
  expect(
    await repository.transitionMeetingHistory({
      ...input,
      expectedOwnerInstanceId: "former-owner",
      recordingDelivery: {
        ...input.recordingDelivery!,
        ownership: {
          ...input.recordingDelivery!.ownership,
          ownerInstanceId: "former-owner",
        },
      },
    }),
  ).toBe("stale");
  expect(row.notesDeliveryTiming?.kind).toBe("first");
});

test.each(["replace", "clear", "rewind"] as const)(
  "complete notes timing cannot %s on an acknowledgement",
  async (change) => {
    const { input, row, repository } = notesTimingFixture();
    const timing = input.patch.notesDeliveryTiming;
    if (timing?.kind !== "complete")
      throw new Error("Expected complete timing fixture");
    row.notesDeliveryTiming = timing;
    input.recordingDelivery!.previous.notesDeliveryTiming =
      row.notesDeliveryTiming;
    if (change === "replace")
      input.patch.notesDeliveryTiming = {
        ...timing,
        kind: "complete",
        completeAcknowledgedAt: "2026-10-16T12:01:00.000Z",
      };
    if (change === "clear")
      input.patch.notesDeliveryTiming = JSON.parse("null");
    if (change === "rewind")
      input.patch.notesDeliveryTiming = {
        kind: "first",
        notesVersion: 1,
        path: "live",
        firstAcknowledgedAt: "2026-10-16T12:00:30.000Z",
      };
    await expect(repository.transitionMeetingHistory(input)).rejects.toThrow();
  },
);
