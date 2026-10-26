/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { introduceProduction } from "../../scripts/deployment/introduce-production.cjs";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";

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
    aws: jest.fn(),
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
    expect(options.aws).not.toHaveBeenCalled();
  },
);

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
