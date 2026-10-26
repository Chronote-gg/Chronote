/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { introduceProduction } from "../../scripts/deployment/introduce-production.cjs";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import { meetingUpdateIndexMetadata } from "../fixtures/productionMeetingUpdateIndex.js";

function initial(rows, paused = false) {
  const manifest = completeManifest();
  const marker = buildPausedDesktopDraftMarker({
    uploadId: "draft",
    ownerUserId: "owner",
  });
  const next = new Error("reached candidate inspection");
  const options = {
    binding: bound(manifest),
    now: () => 150,
    scan: jest.fn(async (_operation, input) => ({
      Items: (
        rows[
          Object.keys(manifest.resources.tables).find(
            (key) => manifest.resources.tables[key] === input.TableName,
          )
        ] ?? []
      ).map(marshall),
    })),
    read: jest.fn(async (key) =>
      paused && key.pk === marker.pk ? marker : undefined,
    ),
    candidate: {
      definitions: jest.fn(async () => {
        throw next;
      }),
    },
    aws: jest.fn(async (service, operation, input) => {
      if (
        service !== "dynamodb" ||
        operation !== "describe-table" ||
        input.TableName !== manifest.resources.tables.meetingHistory
      )
        throw new Error("Unexpected preflight read");
      return meetingUpdateIndexMetadata(manifest);
    }),
    write: jest.fn(),
  };
  return { options, next };
}

test.each([
  ...[
    "pending_upload",
    "queued",
    "processing",
    "failed",
    "complete",
    "unknown",
  ].flatMap((status) =>
    [false, true].map((paused) => ({
      table: "personalJob",
      row: { uploadId: "draft", ownerUserId: "owner", status },
      paused,
    })),
  ),
  ...["pending_upload", "uploaded", "submitted", "processed", "unknown"].map(
    (status) => ({
      table: "personalSegment",
      row: { uploadId: "draft", segmentKey: "mic#0", status },
      paused: true,
    }),
  ),
])(
  "initial $table $row.status paused=$paused refuses before hold or stop",
  async ({ table, row, paused }) => {
    const { options } = initial({ [table]: [row] }, paused);
    await expect(introduceProduction(options, "introduce")).rejects.toThrow(
      "personal_retained_prerequisite",
    );
    expect(options.candidate.definitions).not.toHaveBeenCalled();
    expect(options.read).not.toHaveBeenCalled();
    expect(options.aws).not.toHaveBeenCalled();
    expect(options.write).not.toHaveBeenCalled();
  },
);

test.each([
  {
    personalJob: [{ uploadId: "done", status: "complete", completedAt: "now" }],
  },
  {
    personalSegment: [
      {
        uploadId: "done",
        segmentKey: "mic#0",
        status: "processed",
        processedAt: "now",
      },
    ],
  },
  {
    activeMeeting: [
      { guildId: "active", status: "recording", leaseExpiresAt: 500 },
    ],
  },
])(
  "safe completed personal rows or other active legacy work pass the narrow screen: %p",
  async (rows) => {
    const { options, next } = initial(rows);
    await expect(introduceProduction(options, "introduce")).rejects.toBe(next);
    expect(options.candidate.definitions).toHaveBeenCalledTimes(1);
    expect(options.aws).toHaveBeenCalledWith("dynamodb", "describe-table", {
      TableName: options.binding.manifest.resources.tables.meetingHistory,
    });
  },
);

function assertIndexReadOnlyRefusal(options) {
  expect(options.candidate.definitions).not.toHaveBeenCalled();
  expect(options.read.mock.calls).toEqual(
    options.binding.manifest.handoff.grants.map((grant) => [
      { pk: `FIXTURE#${grant.grantId}`, sk: "AUTHORITY" },
    ]),
  );
  expect(options.write).not.toHaveBeenCalled();
  expect(options.aws).toHaveBeenCalledTimes(1);
}

test.each([
  ["missing index", (t) => (t.GlobalSecondaryIndexes = [])],
  ...["CREATING", "UPDATING", "DELETING"].map((status) => [
    status,
    (t) => (t.GlobalSecondaryIndexes[0].IndexStatus = status),
  ]),
  ["inactive table", (t) => (t.TableStatus = "UPDATING")],
  ["foreign name", (t) => (t.TableName = "other-history")],
  [
    "foreign account",
    (t) => (t.TableArn = t.TableArn.replace(/:\d{12}:/, ":999999999999:")),
  ],
  [
    "foreign region",
    (t) => (t.TableArn = t.TableArn.replace(":us-east-1:", ":us-west-2:")),
  ],
  [
    "duplicate index",
    (t) => t.GlobalSecondaryIndexes.push(t.GlobalSecondaryIndexes[0]),
  ],
  [
    "duplicate key",
    (t) =>
      (t.GlobalSecondaryIndexes[0].KeySchema[1] =
        t.GlobalSecondaryIndexes[0].KeySchema[0]),
  ],
  [
    "wrong key",
    (t) => (t.GlobalSecondaryIndexes[0].KeySchema[0].AttributeName = "other"),
  ],
  ["wrong type", (t) => (t.AttributeDefinitions[1].AttributeType = "S")],
  [
    "duplicate definition",
    (t) => t.AttributeDefinitions.push(t.AttributeDefinitions[0]),
  ],
  [
    "wrong projection",
    (t) => (t.GlobalSecondaryIndexes[0].Projection.ProjectionType = "ALL"),
  ],
  ["malformed schema", (t) => (t.GlobalSecondaryIndexes[0].KeySchema = null)],
])(
  "index preflight %s refuses before hold, journal or stop",
  async (_name, mutate) => {
    const { options } = initial({});
    const metadata = meetingUpdateIndexMetadata(options.binding.manifest);
    mutate(metadata.Table);
    options.aws.mockResolvedValue(metadata);
    await expect(introduceProduction(options, "introduce")).rejects.toThrow(
      "meeting_update_index_prerequisite",
    );
    assertIndexReadOnlyRefusal(options);
  },
);

test("unreadable index refuses before hold, journal or stop without a row fallback", async () => {
  const { options } = initial({});
  options.aws.mockRejectedValue(new Error("synthetic access denied"));
  await expect(introduceProduction(options, "introduce")).rejects.toThrow(
    "synthetic access denied",
  );
  assertIndexReadOnlyRefusal(options);
});

test.each(["unavailable", "malformed"])(
  "initial personal metadata %s refuses before any write",
  async (kind) => {
    const { options } = initial({ personalJob: [{ status: "queued" }] });
    if (kind === "unavailable")
      options.scan.mockRejectedValue(new Error("synthetic read unavailable"));
    await expect(introduceProduction(options, "introduce")).rejects.toThrow();
    expect(options.candidate.definitions).not.toHaveBeenCalled();
    expect(options.aws).not.toHaveBeenCalled();
    expect(options.write).not.toHaveBeenCalled();
  },
);
