import { randomUUID } from "node:crypto";
import { ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  readRetainedMetadata,
  classifyRetainedWork,
  retainedGuardFields,
  projections,
} from "../../scripts/deployment/retained-work.cjs";
import {
  buildFinalAcceptanceTransaction,
  finalState,
  type FinalAcceptanceInput,
} from "../../src/services/productionAcceptanceTransactions";
import { finalFixture } from "../fixtures/productionFinalAcceptance";
import {
  createIntroductionTable,
  putIntroductionDocument as put,
  readIntroductionDocument as read,
  writeIntroduction as write,
  introductionClient,
} from "./fixtures/introductionStore";

test.each([
  { updateDelivery: "malformed" },
  { updateDelivery: {} },
  { updateDelivery: { unexpected: true } },
  { publicationRepair: {} },
  { contentMutation: {} },
  { contentRevision: 1 },
  { updateDeliveryQueue: "meeting-update:v1" },
  { updateDeliveryDueAt: 1 },
])(
  "native final acceptance refuses newly introduced publication metadata %j",
  async (addition) => {
    const table = "acceptance-" + randomUUID();
    const historyTable = "history-" + randomUUID();
    await createIntroductionTable(table);
    await createIntroductionTable(historyTable, [
      "guildId",
      "channelId_timestamp",
    ]);
    const row = {
      guildId: "g",
      channelId_timestamp: "synthetic",
      meetingId: "m",
      status: "complete",
      checkpoint: { schemaVersion: 1 },
      recovery: { disposition: "done" },
      contentRevision: 0,
    };
    await put(historyTable, row);
    const snapshot = await readRetainedMetadata({
      tables: Object.fromEntries(
        Object.keys(projections).map((category) => [
          category,
          category === "meetingHistory" ? historyTable : category,
        ]),
      ),
      now: 150,
      read: async (_operation, request) =>
        request.TableName === historyTable
          ? introductionClient.send(new ScanCommand(request))
          : { Items: [] },
    });
    expect(classifyRetainedWork(snapshot).reopeningBlockers).toEqual([]);
    const input = finalFixture("reopen_admission", table);
    await seed(input);
    input.guards.push({
      table: historyTable,
      key: snapshot.records[0].key,
      row: snapshot.records[0].metadata,
      fields: retainedGuardFields("meetingHistory"),
      maximumItemBytes: 400 * 1024,
    });
    await put(historyTable, { ...row, ...addition });
    await expect(
      write(buildFinalAcceptanceTransaction(input)),
    ).rejects.toThrow();
    expect(
      (await read(table, { pk: "ENV", sk: "CONTROL" }))?.maintenance,
    ).toBeDefined();
  },
);

test.each(["updateDelivery", "publicationRepair", "contentMutation"])(
  "malformed %s is hidden by leaf projection but cannot pass final native absence",
  async (field) => {
    const table = "acceptance-" + randomUUID();
    const input = finalFixture("reopen_admission", table);
    await createIntroductionTable(table);
    await seed(input);
    const row = { pk: "retained", sk: field, status: "complete", [field]: {} };
    await put(table, row);
    const projection = await introductionClient.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "retained" } },
        ProjectionExpression: "pk, sk, #parent.#leaf",
        ExpressionAttributeNames: { "#parent": field, "#leaf": "kind" },
      }),
    );
    expect(projection.Items).toEqual([
      { pk: { S: "retained" }, sk: { S: field } },
    ]);
    input.guards.push({
      table,
      key: { pk: row.pk, sk: row.sk },
      row: { pk: row.pk, sk: row.sk },
      fields: [field],
      maximumItemBytes: 400 * 1024,
    });
    await expect(
      write(buildFinalAcceptanceTransaction(input)),
    ).rejects.toThrow();
  },
);
async function seed(input: FinalAcceptanceInput) {
  for (const row of [
    input.hold,
    input.control,
    input.authority,
    input.action,
    ...input.guards.map((g) => g.row),
  ])
    await put(input.table, row);
  if (input.purpose !== "persist_acceptance")
    await put(input.table, input.acceptance);
}
test.each([
  "persist_acceptance",
  "reopen_admission",
  "release_deployment",
] as const)("native %s changes exactly its own boundary", async (purpose) => {
  const table = "acceptance-" + randomUUID();
  await createIntroductionTable(table);
  const input = finalFixture(purpose, table);
  await seed(input);
  await write(buildFinalAcceptanceTransaction(input));
  const next = finalState(input);
  expect(await read(table, { pk: "ENV", sk: "INTRODUCTION" })).toEqual(
    next.hold,
  );
  expect(await read(table, { pk: "ENV", sk: "CONTROL" })).toEqual(next.control);
  expect(
    await read(table, { pk: input.acceptance.pk, sk: "ACCEPTANCE" }),
  ).toEqual(input.acceptance);
});
test.each([
  "pending_owner",
  "serving_generation",
  "hold",
  "runtime_absence",
  "proof",
  "retirement",
  "original_authority",
  "acceptance",
])("native changed %s rejects without partial reopening", async (change) => {
  const table = "acceptance-" + randomUUID();
  await createIntroductionTable(table);
  const input = finalFixture("reopen_admission", table);
  await seed(input);
  const next = structuredClone(input.guards[1].row);
  if (change === "pending_owner")
    await put(table, {
      ...next,
      workCounts: { ...Object(next.workCounts), billing: 1 },
    });
  if (change === "runtime_absence")
    await put(table, { pk: next.pk, sk: next.sk, recordType: "unknown" });
  if (change === "proof")
    await put(table, {
      ...next,
      protection: { ...Object(next.protection), expiresAt: 319 },
    });
  if (change === "retirement")
    await put(table, { ...input.guards[0].row, retirementAcknowledgment: {} });
  if (change === "serving_generation")
    await put(table, { ...input.control, servingGeneration: 8 });
  if (change === "hold") await put(table, { ...input.hold, revision: 2 });
  if (change === "original_authority")
    await put(table, { ...input.authority, actor: "other" });
  if (change === "acceptance")
    await put(table, { ...input.acceptance, supplementHash: "9".repeat(64) });
  await expect(write(buildFinalAcceptanceTransaction(input))).rejects.toThrow();
  expect(
    (await read(table, { pk: "ENV", sk: "CONTROL" }))?.maintenance,
  ).toBeDefined();
  expect(
    (await read(table, { pk: "ENV", sk: "INTRODUCTION" }))?.admission.state,
  ).toBe("held");
});
test("capacity excess is deterministic and leaves both holds unchanged", async () => {
  const table = "acceptance-" + randomUUID();
  await createIntroductionTable(table);
  const input = finalFixture("reopen_admission", table);
  await seed(input);
  input.guards.push(
    ...Array.from({ length: 11 }, (_, i) => ({
      table,
      key: { pk: "retained", sk: String(i) },
      row: { state: "complete" },
      fields: ["state"],
      maximumItemBytes: 400 * 1024,
    })),
  );
  expect(() => buildFinalAcceptanceTransaction(input)).toThrow(
    "acceptance_capacity_refused",
  );
  expect(await read(table, { pk: "ENV", sk: "INTRODUCTION" })).toEqual(
    input.hold,
  );
  input.guards = input.guards.slice(0, 2);
  input.now = input.authority.validUntil;
  expect(() => buildFinalAcceptanceTransaction(input)).toThrow();
  expect(await read(table, { pk: "ENV", sk: "CONTROL" })).toEqual(
    input.control,
  );
});
