/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { createPreparationCapture } from "../../scripts/deployment/private-capture.cjs";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
function setup() {
  const f = privateCaptureFixture();
  return {
    ...f,
    preparation: {
      kind: "production-introduction-preparation",
      operationId: f.options.m.binding.operationId,
      sourceSha: f.options.m.binding.sourceSha,
      evidenceStoreId: f.options.m.evidenceStoreId,
      validUntil: f.options.m.validUntil,
    },
  };
}
test("preparation retains original versioned bytes in a fixed non-circular namespace", async () => {
  const f = setup();
  const store = createPreparationCapture({
    ...f.options,
    preparation: f.preparation,
  });
  const value = {
    kind: "synthetic-native-projection",
    operationId: f.preparation.operationId,
  };
  const ref = await store.capture(value);
  expect(ref.namespace).toBe(
    `production-introduction-preparation/${f.preparation.operationId}/${f.preparation.sourceSha}`,
  );
  expect(await store.readCapture(ref)).toEqual(value);
  expect(
    f.calls
      .filter((c) => c.constructor.name === "GetObjectCommand")
      .every((c) => c.input.VersionId === ref.versionId),
  ).toBe(true);
});
test.each(["kind", "operationId", "sourceSha", "evidenceStoreId"])(
  "foreign preparation %s cannot read an existing capture",
  async (field) => {
    const f = setup();
    const ref = await createPreparationCapture({
      ...f.options,
      preparation: f.preparation,
    }).capture({ a: 1 });
    const replacements = {
      kind: "rehearsal-introduction-preparation",
      operationId: "11111111-1111-4111-8111-111111111111",
      sourceSha: "e".repeat(40),
      evidenceStoreId: "different-store",
    };
    await expect(async () => {
      const store = createPreparationCapture({
        ...f.options,
        preparation: { ...f.preparation, [field]: replacements[field] },
      });
      await store.readCapture(ref);
    }).rejects.toThrow();
  },
);
test.each([
  { namespace: "arbitrary" },
  { validUntil: 7000 },
  { kind: "sandbox-preparation" },
])("invalid preparation identity refuses before a provider read", (extra) => {
  const f = setup();
  expect(() =>
    createPreparationCapture({
      ...f.options,
      preparation: { ...f.preparation, ...extra },
    }),
  ).toThrow();
  expect(f.calls).toHaveLength(0);
});
