/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { fixture } from "../fixtures/productionManifest.js";
import { pausedPreparationFixture } from "../fixtures/productionPausedPreparation.js";
import {
  pausedDesktopDraftsSchema,
  readAuthenticatedPausedPreparation,
  readDraftBinding,
} from "../../scripts/deployment/production-paused-draft-binding.cjs";
import {
  parseRequest,
  objectSchema,
} from "../../scripts/deployment/production-paused-contract.cjs";
function requestFixture() {
  const m = fixture();
  m.operationId = "00000000-0000-4000-8000-000000000001";
  return pausedPreparationFixture(m);
}
test("strict shared request accepts complete original scope and rejects unsupported authority fields", () => {
  const f = requestFixture();
  expect(parseRequest(f.request)).toEqual(f.request);
  for (const token of [{}, { verified: true }, JSON.parse("{}")]) {
    expect(() => readAuthenticatedPausedPreparation(token)).toThrow();
    expect(() => readDraftBinding(token)).toThrow();
  }
  for (const mutate of [
    (r) => r.cohort.push({ ...r.cohort[0], uploadId: "three" }),
    (r) => (r.cohort[1].uploadId = "one"),
    (r) => (r.sourceObjects[1] = r.sourceObjects[0]),
    (r) => (r.resourceArns.personalJob += "-wrong"),
    (r) => (r.storeBinding.accountId = "999999999999"),
    (r) => (r.closure = { noStorageMutation: true }),
  ]) {
    const r = structuredClone(f.request);
    mutate(r);
    expect(() => parseRequest(r)).toThrow();
  }
});
test("capture reference requires complete native store reference and new preparation workflow", () => {
  expect(() =>
    pausedDesktopDraftsSchema.parse({
      capture: { bucket: "old", key: "old", byteLength: 1 },
    }),
  ).toThrow();
});
test("checksum maps cannot fake byte evidence with metadata fields or conflicting predicates", () => {
  const object = {
    uploadId: "one",
    ownerUserId: "owner",
    key: "original",
    size: 1,
    contentType: "audio/wav",
    versionId: "v1",
    checksumType: "FULL_OBJECT",
    checksums: { ChecksumSHA256: "checksum" },
  };
  expect(objectSchema.parse(object)).toEqual(object);
  expect(() =>
    objectSchema.parse({ ...object, checksums: { VersionId: "v1" } }),
  ).toThrow();
  expect(() =>
    objectSchema.parse({
      ...object,
      requiredChecksums: {
        ChecksumSHA256: { value: "other", source: "approved" },
      },
    }),
  ).toThrow();
});
