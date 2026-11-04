import { randomUUID } from "node:crypto";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  buildLegacyArtifactTransaction,
  type LegacyArtifactWrite,
} from "../../src/services/legacyArtifactAttestation";
import { artifactSafetyRecordSchema } from "../../src/types/artifactSafety";
import { counts } from "./fixtures/coordinatorFixture";
import { legacyArtifactFixture } from "./fixtures/legacyArtifactFixture";
import {
  introductionClient as client,
  createIntroductionTable,
} from "./fixtures/introductionStore";

const prefix = `legacy-artifact-test-${randomUUID()}-`;
const tables = {
  deploymentControl: prefix + "control",
  meetingHistory: prefix + "history",
};
beforeAll(() => createIntroductionTable(tables.deploymentControl));
async function put(item: object) {
  await client.send(
    new PutItemCommand({
      TableName: tables.deploymentControl,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
}
async function get(sk: string) {
  const result = await client.send(
    new GetItemCommand({
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk }),
      ConsistentRead: true,
    }),
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}
const transact = (input: LegacyArtifactWrite) =>
  client.send(
    new TransactWriteItemsCommand(
      buildLegacyArtifactTransaction(input, tables),
    ),
  );
/** Each call differs, so DynamoDB never answers it as an idempotent replay. */
function attestation(f: ReturnType<typeof legacyArtifactFixture>) {
  return f.write(
    "attest",
    undefined,
    artifactSafetyRecordSchema.parse({
      ...f.attested,
      attestation: { ...f.attested.attestation, reason: randomUUID() },
    }),
  );
}
async function setup(storedCounts = counts()) {
  const f = legacyArtifactFixture();
  await put(f.ctl);
  await put({ ...f.source, workCounts: storedCounts });
  await client.send(
    new DeleteItemCommand({
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: f.attested.sk }),
    }),
  );
  return f;
}

test("attest, request, seal and consume commit natively and advance warming", async () => {
  const f = await setup();
  await transact(f.write("attest", undefined, f.attested));
  await expect(transact(attestation(f))).rejects.toThrow();
  await transact(f.write("request", f.attested, f.requested));
  await transact(f.write("seal", f.requested, f.sealed));
  const consumed = artifactSafetyRecordSchema.parse({
    ...f.sealed,
    revision: 3,
    state: "consumed",
    consumedAt: 120,
  });
  await transact(f.write("consume", f.sealed, consumed));
  expect((await get(f.attested.sk))?.state).toBe("consumed");
  expect((await get("CONTROL"))?.deployment.phase).toBe("warming");
});

test.each([
  ["recording", counts(1)],
  ["changed pending_admission", { ...counts(), pending_admission: 1 }],
])("a stored %s count refuses attestation natively", async (_kind, stored) => {
  const f = await setup(stored);
  await expect(transact(attestation(f))).rejects.toThrow();
  expect(await get(f.attested.sk)).toBeUndefined();
});

test("a lapsed published native protection refuses attestation natively", async () => {
  const f = await setup();
  await put({
    ...f.source,
    protection: { ...f.source.protection, expiresAt: 120 },
  });
  await expect(transact(attestation(f))).rejects.toThrow();
  expect(await get(f.attested.sk)).toBeUndefined();
});

test("cancellation closes preparing natively even while the source records", async () => {
  const f = await setup(counts(1));
  await put(f.sealed);
  await transact({
    ...f.write(
      "cancel",
      f.sealed,
      artifactSafetyRecordSchema.parse({
        ...f.attested,
        revision: f.sealed.revision + 1,
      }),
    ),
    runtime: { ...f.source, workCounts: counts(1) },
  });
  expect((await get(f.attested.sk))?.state).toBe("attested_legacy");
  expect((await get("CONTROL"))?.deployment.phase).toBe("complete");
});
