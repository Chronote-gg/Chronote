/** @jest-environment node */
import { introductionFixture } from "../fixtures/productionIntroduction";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  buildFixtureStartTransaction,
  resolveFixtureStartScope,
} from "../../src/services/productionFixtureCommandService";
import type { FixtureGrant } from "../../src/types/productionIntroduction";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
const maintenance = { holdId: "hold", introductionId: "intro", revision: 1 };
const hold = introductionFixture(maintenance);
const command: MeetingControlCommand = {
  requestId: "fixture:11111111-1111-4111-8111-111111111111",
  userId: "actor",
  commandType: "start_meeting",
  input: { serverId: "guild", voiceChannelId: "voice", textChannelId: "text" },
  queueStatus: "pending",
  createdAt: "now",
  updatedAt: "now",
  expiresAt: 200,
};
const grant: FixtureGrant = {
  pk: "FIXTURE#fixture:11111111-1111-4111-8111-111111111111",
  sk: "AUTHORITY",
  recordType: "fixture_grant",
  protocolVersion: 1,
  grantId: "fixture:11111111-1111-4111-8111-111111111111",
  ...maintenance,
  commandId: "fixture:11111111-1111-4111-8111-111111111111",
  meetingId: "meeting",
  guildId: "guild",
  voiceChannelId: "voice",
  textChannelId: "text",
  actorUserId: "actor",
  sessionMode: "meeting",
  state: "issued",
};
const tables = {
  deploymentControl: "control",
  meetingControlCommand: "commands",
};
const scope = {
  kind: "fixture",
  reference: {
    ...maintenance,
    grantId: "fixture:11111111-1111-4111-8111-111111111111",
  },
  commandId: "fixture:11111111-1111-4111-8111-111111111111",
  meetingId: "meeting",
  guildId: "guild",
  voiceChannelId: "voice",
  textChannelId: "text",
  actorUserId: "actor",
  sessionMode: "meeting",
};
test("private construction atomically binds an issued grant and queued command to the held introduction", () => {
  const tx = buildFixtureStartTransaction({ hold, grant, command, tables });
  expect(tx.TransactItems).toHaveLength(4);
  expect(
    tx.TransactItems?.filter((item) => item.Put).map((item) =>
      unmarshall(item.Put!.Item!),
    ),
  ).toEqual([grant, command]);
  expect(tx.TransactItems?.[0].ConditionCheck?.Key).toEqual(
    marshall({ pk: "ENV", sk: "CONTROL" }),
  );
});
test.each([
  { requestId: "copied" },
  { userId: "other" },
  { commandType: "stop_meeting" },
  { input: { ...command.input, voiceChannelId: "other" } },
  { input: { ...command.input, textChannelId: "other" } },
  { input: { ...command.input, fixture: true } },
])("constructor rejects a changed command binding %j", (change) => {
  expect(() =>
    buildFixtureStartTransaction({
      hold,
      grant,
      command: { ...command, ...change },
      tables,
    }),
  ).toThrow();
});
test("constructor refuses reopened admission and released deployment", () => {
  for (const changed of [
    { ...hold, admission: { state: "reopened", receiptId: "receipt" } },
    { ...hold, deployment: { state: "released", receiptId: "receipt" } },
  ]) {
    expect(() =>
      buildFixtureStartTransaction({ hold: changed, grant, command, tables }),
    ).toThrow();
  }
});
test("trusted resolution reads only the stored request authority and preserves its meeting identity", async () => {
  const getRecord = jest.fn(async () => grant);
  await expect(
    resolveFixtureStartScope(command, maintenance, { getRecord }),
  ).resolves.toEqual(scope);
  expect(getRecord).toHaveBeenCalledWith(
    "FIXTURE#fixture:11111111-1111-4111-8111-111111111111",
    "AUTHORITY",
  );
});
test("ordinary steady-state resolution does no grant read", async () => {
  const getRecord = jest.fn();
  await expect(
    resolveFixtureStartScope({ ...command, requestId: "ordinary" }, undefined, {
      getRecord,
    }),
  ).resolves.toEqual({ kind: "ordinary" });
  expect(getRecord).not.toHaveBeenCalled();
});
test.each([
  undefined,
  { ...grant, grantId: "copied", pk: "FIXTURE#copied" },
  { ...grant, actorUserId: "other" },
  { ...grant, textChannelId: "changed" },
  { ...grant, state: "consumed" },
  { ...grant, revision: 2 },
])(
  "held starts refuse missing or mismatched durable authority %j",
  async (record) => {
    await expect(
      resolveFixtureStartScope(command, maintenance, {
        getRecord: async () => record,
      }),
    ).rejects.toThrow();
  },
);

test("issuance appends one bounded discovery id without changing the revision", () => {
  const tx = buildFixtureStartTransaction({
    hold: { ...hold, fixtureGrantIds: ["first"] },
    grant,
    command,
    tables,
  });
  const update = tx.TransactItems?.[1].Update;
  expect(update?.UpdateExpression).toBe("SET fixtureGrantIds = :grants");
  expect(unmarshall(update!.ExpressionAttributeValues!)[":grants"]).toEqual([
    "first",
    "fixture:11111111-1111-4111-8111-111111111111",
  ]);
  expect(
    unmarshall(update!.ExpressionAttributeValues!)[":previousGrants"],
  ).toEqual(["first"]);
});
test.each([
  ["fixture:11111111-1111-4111-8111-111111111111"],
  ["first", "second"],
  ["same", "same"],
])("issuance refuses duplicate or third grant %j", (fixtureGrantIds) => {
  expect(() =>
    buildFixtureStartTransaction({
      hold: { ...hold, fixtureGrantIds },
      grant,
      command,
      tables,
    }),
  ).toThrow();
});

test("a pending fixture refuses after explicit release", async () => {
  const getRecord = jest.fn(async () => grant);
  await expect(
    resolveFixtureStartScope(command, undefined, { getRecord }),
  ).rejects.toThrow();
});
test("the privileged constructor requires an internal fixture request UUID", () => {
  expect(() =>
    buildFixtureStartTransaction({
      hold,
      command: { ...command, requestId: "ordinary" },
      grant: {
        ...grant,
        pk: "FIXTURE#ordinary",
        grantId: "ordinary",
        commandId: "ordinary",
      },
      tables,
    }),
  ).toThrow();
});
