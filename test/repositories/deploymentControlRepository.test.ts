/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import {
  createMockDeploymentControlRepository,
  classifyDeploymentTransactionError,
} from "../../src/repositories/deploymentControlRepository";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import { parseDeploymentControlRecord } from "../../src/types/deploymentControl";

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

test("suppression writes are versioned compare-and-swap", async () => {
  const repository = createMockDeploymentControlRepository();
  const record = {
    pk: "SUPPRESS#guild",
    sk: "CHANNEL#channel",
    recordType: "suppression" as const,
    protocolVersion: 1 as const,
    guildId: "guild",
    channelId: "channel",
    meetingId: "meeting",
    createdAt: 100,
    version: 1,
    suppressed: true,
    reason: "explicit_end" as const,
  };
  expect(await repository.writeSuppression({ record })).toBe("applied");
  expect(await repository.writeSuppression({ record })).toBe("stale");
  await expect(
    repository.writeSuppression({ record, expectedVersion: 1 }),
  ).rejects.toThrow("Invalid suppression version");
  expect(
    await repository.writeSuppression({
      record: { ...record, version: 2, suppressed: false },
      expectedVersion: 1,
    }),
  ).toBe("applied");
  expect(await repository.getRecord(record.pk, record.sk)).toMatchObject({
    version: 2,
    suppressed: false,
  });
});
