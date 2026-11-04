/** @jest-environment node */
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { buildArtifactSafetyTransaction } from "../../src/services/artifactSafetyTransactions";
import {
  buildLegacyArtifactTransaction,
  type LegacyArtifactWrite,
} from "../../src/services/legacyArtifactAttestation";
import {
  artifactSafetyBaseSchema,
  artifactSafetyRecordSchema,
} from "../../src/types/artifactSafety";
import { counts } from "./fixtures/coordinatorFixture";
import { legacyArtifactFixture as fixture } from "./fixtures/legacyArtifactFixture";

const items = (
  input: LegacyArtifactWrite,
  tables: { deploymentControl: string; meetingHistory: string },
) => buildLegacyArtifactTransaction(input, tables).TransactItems!;

test("attestation inserts the row only where none exists, bound to a quiet runtime and exact Control", () => {
  const f = fixture();
  const [put, runtime, control] = items(
    f.write("attest", undefined, f.attested),
    f.tables,
  );
  expect(put.Put!.ConditionExpression).toBe(
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  const check = runtime.ConditionCheck!;
  expect(Object.values(check.ExpressionAttributeNames!)).toEqual(
    expect.arrayContaining(["workCounts", "recording", "pending_admission"]),
  );
  expect(check.ConditionExpression).toContain("heartbeatAt > :legacyFresh");
  expect(control.ConditionCheck!.ConditionExpression).not.toContain(
    "coordinatorExpiresAt",
  );
});

test.each([
  ["recording", { ...counts(1) }],
  ["pending_admission", { ...counts(), pending_admission: 1 }],
  ["no counters", undefined],
])("attestation refuses a source reporting %s", (_reason, workCounts) => {
  const f = fixture();
  const input = f.write("attest", undefined, f.attested);
  input.runtime = { ...f.source, workCounts };
  expect(() => buildLegacyArtifactTransaction(input, f.tables)).toThrow(
    /quiet/,
  );
});

test("a runtime-written row cannot be overwritten by an attestation", () => {
  const f = fixture();
  expect(() =>
    buildLegacyArtifactTransaction(
      f.write("attest", f.expected, { ...f.attested, revision: 3 }),
      f.tables,
    ),
  ).toThrow();
});

test("an expired attestation cannot open a preparation", () => {
  const f = fixture();
  const input = f.write("request", f.attested, f.requested);
  input.now = 3600;
  expect(() => buildLegacyArtifactTransaction(input, f.tables)).toThrow(
    /expired/,
  );
});

test("a seal must carry exactly the attested inventory", () => {
  const f = fixture();
  expect(() =>
    buildLegacyArtifactTransaction(
      f.write("seal", f.requested, f.sealed),
      f.tables,
    ),
  ).not.toThrow();
  const forged = artifactSafetyRecordSchema.parse({
    ...f.sealed,
    proof: { ...f.sealed.proof, snapshot: f.expected.proof.snapshot },
  });
  expect(() =>
    buildLegacyArtifactTransaction(
      f.write("seal", f.requested, forged),
      f.tables,
    ),
  ).toThrow(/derived/);
});

test.each([
  ["consume", "warming"],
  ["cancel", "complete"],
] as const)(
  "%s moves preparing to %s in the same transaction",
  (purpose, phase) => {
    const f = fixture();
    const next =
      purpose === "consume"
        ? artifactSafetyRecordSchema.parse({
            ...f.sealed,
            revision: 3,
            state: "consumed",
            consumedAt: 120,
          })
        : artifactSafetyRecordSchema.parse({
            ...artifactSafetyBaseSchema.parse(f.sealed),
            revision: 3,
            state: "attested_legacy",
          });
    const input = f.write(purpose, f.sealed, next);
    if (purpose === "cancel")
      input.runtime = { ...f.source, workCounts: counts(1) };
    const update = items(input, f.tables).find((item) => item.Update)!.Update!;
    expect(update.ConditionExpression).toContain("coordinatorExpiresAt");
    expect(
      unmarshall(update.ExpressionAttributeValues!)[":nextDeployment"],
    ).toEqual({ ...f.ctl.deployment, phase, updatedAt: 120 });
  },
);

test("the runtime protocol refuses every write on an attested row", () => {
  const f = fixture();
  expect(() =>
    buildArtifactSafetyTransaction(
      {
        purpose: "heartbeat",
        expected: f.attested,
        next: { ...f.attested, revision: 1 },
        context: { kind: "runtime", runtime: f.source },
        now: 120,
      },
      f.tables,
    ),
  ).toThrow(/coordinator-owned/);
});
