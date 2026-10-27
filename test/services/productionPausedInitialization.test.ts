/** @jest-environment node */
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  buildPausedInitializationItems,
  pausedInitializationSchema,
} from "../../src/services/productionPausedInitialization";

import { pausedInitializationFixture as fixture } from "../fixtures/productionPausedInitialization";

const binding = { operationId: "op", manifestHash: "d".repeat(64) };
const tables = {
  deploymentControl: "control",
  personalJob: "jobs",
  personalSegment: "segments",
};

test("guards indexed structural metadata without reading or rewriting private fields", () => {
  const input = buildPausedInitializationItems(fixture(), binding, tables);
  expect(input).toHaveLength(4);
  expect(input.filter((item) => item.Put)).toHaveLength(2);
  const check = input[0].ConditionCheck!;
  expect(check.ConditionExpression).toContain(
    "attribute_type(#manifest, :listType)",
  );
  expect(check.ConditionExpression).toContain("size(#manifest) = :sourceCount");
  expect(check.ConditionExpression).toContain(
    "#manifest[0].#sourceId = :source0_sourceId",
  );
  expect(check.ExpressionAttributeNames).not.toHaveProperty("#label");
  expect(Object.values(check.ExpressionAttributeNames!)).not.toContain("title");
  expect(unmarshall(input[2].Put!.Item!)).toMatchObject({
    uploadId: "one",
    sk: "PAUSED_DRAFT",
  });
});

test.each(["processingClaimId", "meetingId", "completedAt"])(
  "refuses forbidden parent field %s",
  (field) => {
    const f = fixture();
    Object.assign(f.parents[0], { [field]: "present" });
    expect(() => pausedInitializationSchema.parse(f)).toThrow();
  },
);

test("refuses third or duplicated identities and mismatched marker capture", () => {
  const f = fixture();
  f.parents.push(f.parents[0]);
  expect(() => buildPausedInitializationItems(f, binding, tables)).toThrow();
  const mismatch = fixture();
  mismatch.markers[1].preservedCaptureSha256 = "e".repeat(64);
  expect(() =>
    buildPausedInitializationItems(mismatch, binding, tables),
  ).toThrow();
});
