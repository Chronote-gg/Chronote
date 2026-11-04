import { artifactSafetyRecordSchema } from "../../src/types/artifactSafety";
import { runtime } from "../deployment/controlFixtures";

const identity = runtime("source").identity;
const request = {
  source: identity,
  coordinatorToken: "coordinator",
  coordinatorEpoch: 3,
  servingGeneration: 7,
  requestedAt: 100,
  expiresAt: 300,
};
const proof = {
  provenAt: 110,
  expiresAt: 170,
  snapshot: {
    inventoryDigest: "a".repeat(64),
    fileCount: 0,
    byteLength: 0,
    pendingDirectories: 0,
    authorities: [],
  },
};
const record = {
  pk: "ENV",
  sk: "ARTIFACTS#source/STATE",
  recordType: "artifact_safety",
  schemaVersion: 1,
  identity,
  revision: 1,
  heartbeatAt: 110,
  freshUntil: 170,
  startup: { kind: "active", activatedAt: 90 },
  state: "sealed",
  request,
  proof,
};

test("the separate artifact row binds exact source identity and bounded request/proof lifetimes", () => {
  expect(artifactSafetyRecordSchema.parse(record)).toMatchObject({
    state: "sealed",
    request,
  });
  expect(
    artifactSafetyRecordSchema.safeParse({
      ...record,
      identity: runtime("other").identity,
    }).success,
  ).toBe(false);
  expect(
    artifactSafetyRecordSchema.safeParse({
      ...record,
      proof: { ...proof, expiresAt: 301 },
    }).success,
  ).toBe(false);
  expect(
    artifactSafetyRecordSchema.safeParse({
      ...record,
      request: { ...request, expiresAt: 1000 },
    }).success,
  ).toBe(false);
  expect(
    artifactSafetyRecordSchema.safeParse({ ...record, schemaVersion: 2 })
      .success,
  ).toBe(false);
});

test("unknown fields and a mismatched row key cannot masquerade as capability", () => {
  expect(
    artifactSafetyRecordSchema.safeParse({ ...record, sk: "CONTROL" }).success,
  ).toBe(false);
  expect(
    artifactSafetyRecordSchema.safeParse({ ...record, bypassStorage: true })
      .success,
  ).toBe(false);
});
