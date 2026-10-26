import { randomUUID } from "node:crypto";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import {
  buildPersonalMediaClaimTransaction,
  buildPersonalClaimCheck,
} from "../../src/services/deploymentControlTransactions";
import { personalClaimMatches } from "../../src/types/meetingCanonicalWriter";
import {
  beforeCanonicalWrite,
  featurePersonalRow,
  promoteWithRetainedPeer,
} from "./mixedVersionCanonical.fixture";
/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: async () => undefined,
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: async () => undefined,
}));
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import type {
  MeetingHistory,
  PersonalMediaUploadJobRecord,
} from "../../src/types/db";
import { history, key } from "../types/meetingUpdateDelivery.fixture";
import {
  mixedVersionFixture,
  oldRecordingTerminal,
  oldPersonalTerminal,
  oldGenerated,
  personalClaim,
  personalJob,
  type MixedVersionFixture,
} from "./mixedVersionCanonical.fixture";

let fixture: MixedVersionFixture;
beforeEach(async () => {
  fixture = await mixedVersionFixture();
});
afterEach(async () => {
  await fixture.close();
});
const edit = () =>
  createMeetingUpdateService({
    repository: fixture.updates,
    ready: async () => undefined,
    syncNotes: async () => undefined,
  })({
    key,
    mutation: { kind: "notes", notes: "Acknowledged manual notes" },
    actor: { editedBy: "synthetic-user" },
    notesEdit: { expectedNotesVersion: 1 },
  });

test.each(["processing", "cancelled"] as const)(
  "old recording %s cannot overwrite an acknowledged canonical edit",
  async (status) => {
    const row: MeetingHistory = {
      ...history(),
      status,
      ownerInstanceId: "pre-feature-original",
      executionVersion: 1,
    };
    await fixture.put(fixture.tables.meetingHistory, row);
    const result = await edit();
    await oldRecordingTerminal(fixture, row);
    expect(await fixture.read()).toMatchObject(oldGenerated);
    expect(result.kind).toBe("conflict");
  },
);

test("old personal generated-field transaction cannot overwrite an acknowledged canonical edit", async () => {
  const claim = { ...personalClaim(), instanceId: "pre-feature-personal" };
  const row: MeetingHistory = {
    ...history(),
    status: "processing",
    ownershipScope: "personal",
    ownerUserId: "synthetic-user",
  };
  await fixture.put(fixture.tables.personalMediaUpload, personalJob(claim));
  await fixture.put(fixture.tables.meetingHistory, row);
  const result = await edit();
  await oldPersonalTerminal(fixture, row, claim);
  expect(await fixture.read()).toMatchObject(oldGenerated);
  expect(result.kind).toBe("conflict");
});

test("personal takeover between producer read and commit invalidates the former writer proof", async () => {
  await promoteWithRetainedPeer(fixture, Math.floor(Date.now() / 1000), true);
  const claim = personalClaim();
  const row = {
    ...history(),
    status: "processing",
    ownershipScope: "personal",
    ownerUserId: "synthetic-user",
    canonicalWriter: {
      kind: "personal",
      uploadId: claim.uploadId,
      instanceId: claim.instanceId,
      attempt: claim.attempt,
      claimId: claim.claimId,
    },
  };
  await fixture.put(fixture.tables.personalMediaUpload, personalJob(claim));
  await fixture.put(fixture.tables.meetingHistory, row);
  const replacement = {
    ...claim,
    instanceId: "pre-feature-replacement",
    attempt: 2,
    claimId: "replacement-claim",
  };
  const isArmed = beforeCanonicalWrite(
    fixture,
    "syntheticPersonalTakeover",
    async () => {
      await fixture.put(
        fixture.tables.personalMediaUpload,
        personalJob(replacement),
      );
    },
  );
  const result = await edit();
  expect(isArmed()).toBe(false);
  expect(result.kind).toBe("conflict");
  expect(await fixture.read()).toMatchObject({ notes: history().notes });
});

test("completed legacy canonical content remains editable without a writer proof", async () => {
  await fixture.put(fixture.tables.meetingHistory, {
    ...history(),
    status: "complete",
  });
  expect((await edit()).kind).toBe("saved");
  expect(await fixture.read()).toMatchObject({
    notes: "Acknowledged manual notes",
    contentRevision: 1,
  });
});

// Forward promotion can retain another old worker with fully valid new-work admission.
test("retained pre-feature serving peer cannot later overwrite an acknowledged personal edit", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { retainedContext } = await promoteWithRetainedPeer(
    fixture,
    now,
    false,
  );
  const claim = { ...personalClaim(), instanceId: "new" };
  const row = featurePersonalRow(claim);
  await fixture.put(fixture.tables.personalMediaUpload, {
    ...personalJob(claim),
    claimExpiresAt: now + 1,
  });
  await fixture.put(fixture.tables.meetingHistory, row);
  const result = await edit();
  const takeover = {
    ...claim,
    instanceId: "retained",
    claimId: randomUUID(),
    attempt: 2,
    nowEpochSeconds: now + 2,
  };
  await fixture.client.send(
    new TransactWriteItemsCommand(
      buildPersonalMediaClaimTransaction(
        {
          job: personalJob(takeover),
          context: { ...retainedContext, now: now + 2 },
          expectedAttempts: 1,
          maxAttempts: 4,
          claimId: takeover.claimId,
        },
        fixture.tables,
      ),
    ),
  );
  await oldPersonalTerminal(fixture, row, takeover);
  expect(await fixture.read()).toMatchObject(oldGenerated);
  expect(result.kind).toBe("conflict");
});

test("all feature-aware serving peers admit a new processing edit", async () => {
  await promoteWithRetainedPeer(fixture, Math.floor(Date.now() / 1000), true);
  const claim = { ...personalClaim(), instanceId: "new" };
  await fixture.put(fixture.tables.personalMediaUpload, personalJob(claim));
  await fixture.put(fixture.tables.meetingHistory, featurePersonalRow(claim));
  expect((await edit()).kind).toBe("saved");
});

test.each(["roster", "capability"] as const)(
  "peer %s change between admission read and commit fences the save",
  async (change) => {
    const now = Math.floor(Date.now() / 1000);
    const peers = await promoteWithRetainedPeer(fixture, now, true);
    const claim = { ...personalClaim(), instanceId: "new" };
    await fixture.put(fixture.tables.personalMediaUpload, personalJob(claim));
    await fixture.put(fixture.tables.meetingHistory, featurePersonalRow(claim));
    const isArmed = beforeCanonicalWrite(
      fixture,
      "syntheticPeerChange",
      async () => {
        await fixture.put(
          fixture.tables.deploymentControl,
          change === "roster"
            ? { ...peers.promotedControl, servingGeneration: 9 }
            : peers.retainedWithoutCapability,
        );
      },
    );
    expect((await edit()).kind).toBe("conflict");
    expect(isArmed()).toBe(false);
    expect(await fixture.read()).toMatchObject({ notes: history().notes });
  },
);

test.each([
  {
    label: "missing expiry at epoch zero",
    now: 0,
    expiry: undefined,
    mismatch: "none",
    expected: false,
  },
  {
    label: "missing expiry after epoch zero",
    now: 100,
    expiry: undefined,
    mismatch: "none",
    expected: false,
  },
  {
    label: "expired claim",
    now: 100,
    expiry: 99,
    mismatch: "none",
    expected: false,
  },
  {
    label: "exact expiry boundary",
    now: 100,
    expiry: 100,
    mismatch: "none",
    expected: true,
  },
  {
    label: "wrong owner",
    now: 100,
    expiry: 101,
    mismatch: "owner",
    expected: false,
  },
  {
    label: "wrong attempt",
    now: 100,
    expiry: 101,
    mismatch: "attempt",
    expected: false,
  },
  {
    label: "wrong claim nonce",
    now: 100,
    expiry: 101,
    mismatch: "claim",
    expected: false,
  },
  {
    label: "terminal job",
    now: 100,
    expiry: 101,
    mismatch: "status",
    expected: false,
  },
])(
  "personal domain ownership matches actual DynamoDB for $label",
  async ({ now, expiry, mismatch, expected }) => {
    const claim = { ...personalClaim(), nowEpochSeconds: now };
    const job: PersonalMediaUploadJobRecord = personalJob(claim);
    if (expiry === undefined) delete job.claimExpiresAt;
    else job.claimExpiresAt = expiry;
    if (mismatch === "owner") job.processingOwnerInstanceId = "different-owner";
    if (mismatch === "attempt") job.attempts = claim.attempt + 1;
    if (mismatch === "claim") job.processingClaimId = "different-claim";
    if (mismatch === "status") job.status = "complete";
    await fixture.put(fixture.tables.personalMediaUpload, job);
    expect(personalClaimMatches(job, claim)).toBe(expected);
    const actual = fixture.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          buildPersonalClaimCheck(claim, fixture.tables.personalMediaUpload),
        ],
      }),
    );
    if (expected) await expect(actual).resolves.toBeDefined();
    else
      await expect(actual).rejects.toMatchObject({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
  },
);
