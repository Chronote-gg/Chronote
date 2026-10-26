/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: async () => undefined,
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: async () => undefined,
}));
import { randomUUID } from "node:crypto";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { buildPersonalMediaClaimTransaction } from "../../src/services/deploymentControlTransactions";
import { mockCanonicalWritersAllowEdit } from "../../src/repositories/meetingCanonicalWriterAdmission";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import type { MeetingHistory } from "../../src/types/db";
import { context, control, runtime } from "./controlFixtures";
import { history, key } from "../types/meetingUpdateDelivery.fixture";
import {
  featurePersonalRow,
  mixedVersionFixture,
  personalClaim,
  personalJob,
  promoteWithRetainedPeer,
  type MixedVersionFixture,
} from "./mixedVersionCanonical.fixture";

let fixture: MixedVersionFixture;
beforeEach(async () => {
  fixture = await mixedVersionFixture();
});
afterEach(async () => {
  await fixture.close();
});
function rename() {
  return createMeetingUpdateService({
    repository: fixture.updates,
    ready: async () => undefined,
    syncNotes: async () => undefined,
  })({
    key,
    actor: { editedBy: "synthetic-user" },
    mutation: { kind: "rename", meetingName: "Acknowledged manual name" },
  });
}
function interrupted(): MeetingHistory {
  return {
    ...history(),
    status: "interrupted",
    ownerInstanceId: "pre-feature-original",
    executionVersion: 1,
    recovery: {
      disposition: "pending",
      attempt: 0,
      executionVersion: 1,
      stage: "verification",
      retry: { maxAttempts: 4, nextAttemptAt: null },
    },
  };
}

test("outgoing old runtime cannot take a feature personal claim after a saved edit", async () => {
  const now = Math.floor(Date.now() / 1000);
  await promoteWithRetainedPeer(fixture, now, true);
  const claim = { ...personalClaim(), instanceId: "new" };
  await fixture.put(fixture.tables.personalMediaUpload, {
    ...personalJob(claim),
    claimExpiresAt: now + 1,
  });
  await fixture.put(fixture.tables.meetingHistory, featurePersonalRow(claim));
  expect((await rename()).kind).toBe("saved");
  const takeover = {
    ...claim,
    instanceId: "old",
    claimId: randomUUID(),
    attempt: 2,
    nowEpochSeconds: now + 2,
  };
  await expect(
    fixture.client.send(
      new TransactWriteItemsCommand(
        buildPersonalMediaClaimTransaction(
          {
            job: personalJob(takeover),
            context: { ...context, authorizedGeneration: 8, now: now + 2 },
            expectedAttempts: 1,
            maxAttempts: 4,
            claimId: takeover.claimId,
          },
          fixture.tables,
        ),
      ),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  expect(await fixture.read()).toMatchObject({
    meetingName: "Acknowledged manual name",
    contentRevision: 1,
  });
});

test("outgoing old runtime cannot acquire recording recovery after a saved feature edit", async () => {
  const now = Math.floor(Date.now() / 1000);
  await promoteWithRetainedPeer(fixture, now, true);
  const row: MeetingHistory = {
    ...history(),
    status: "processing",
    ownerInstanceId: "new",
    executionVersion: 1,
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId: "new",
      executionVersion: 1,
    },
  };
  await fixture.put(fixture.tables.meetingHistory, row);
  expect((await rename()).kind).toBe("saved");
  const saved = await fixture.read();
  if (!saved) throw new Error("Missing saved history");
  const pending: MeetingHistory = {
    ...saved,
    status: "interrupted",
    recovery: interrupted().recovery,
  };
  await fixture.put(fixture.tables.meetingHistory, pending);
  expect(
    await fixture.original.claimRecordingRecovery({
      history: pending,
      lease: undefined,
      context: { ...context, authorizedGeneration: 8, now },
      attemptId: randomUUID(),
    }),
  ).toBeUndefined();
  expect(await fixture.read()).toMatchObject({
    meetingName: "Acknowledged manual name",
    executionVersion: 1,
  });
});

test("feature recovery acquisition persists capability for the advanced execution", async () => {
  const now = Math.floor(Date.now() / 1000);
  await promoteWithRetainedPeer(fixture, now, true);
  const row = interrupted();
  await fixture.put(fixture.tables.meetingHistory, row);
  const claim = await fixture.original.claimRecordingRecovery({
    history: row,
    lease: undefined,
    context: {
      ...context,
      instanceId: "new",
      identity: runtime("new").identity,
      authorizedGeneration: 8,
      now,
    },
    attemptId: randomUUID(),
  });
  expect(claim?.history.canonicalWriter).toEqual({
    kind: "recording",
    ownerInstanceId: "new",
    executionVersion: 2,
  });
  expect(await fixture.read()).toMatchObject({
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId: "new",
      executionVersion: 2,
    },
  });
});

test.each(["missing", "unknown", "identity"] as const)(
  "a %s peer capability cannot authorize processing edits",
  async (kind) => {
    const now = Math.floor(Date.now() / 1000);
    const peers = await promoteWithRetainedPeer(fixture, now, true);
    const claim = { ...personalClaim(), instanceId: "new" };
    await fixture.put(fixture.tables.personalMediaUpload, personalJob(claim));
    await fixture.put(fixture.tables.meetingHistory, featurePersonalRow(claim));
    await fixture.put(fixture.tables.deploymentControl, {
      ...peers.retainedWithoutCapability,
      ...(kind === "missing"
        ? {}
        : { canonicalContentWriter: kind === "unknown" ? 2 : 1 }),
      ...(kind === "identity"
        ? { identity: runtime("different-runtime").identity }
        : {}),
    });
    expect((await rename()).kind).toBe("conflict");
    expect(await fixture.read()).not.toHaveProperty("contentRevision");
  },
);

test("transaction capacity reserves space for history and the personal claim", () => {
  const records = new Map<string, DeploymentControlRecord>();
  const members: typeof control.servingMembers = {};
  for (let index = 0; index < 98; index++) {
    const worker = {
      ...runtime("feature-" + index),
      canonicalContentWriter: 1 as const,
    };
    members[worker.identity.instanceId] = worker.identity;
    records.set(JSON.stringify(["ENV", worker.sk]), worker);
  }
  records.set(JSON.stringify(["ENV", "CONTROL"]), {
    ...control,
    servingMembers: members,
  });
  expect(mockCanonicalWritersAllowEdit(records, 1)).toBe(true);
  expect(mockCanonicalWritersAllowEdit(records, 2)).toBe(false);
});
