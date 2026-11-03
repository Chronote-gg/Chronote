import { randomUUID } from "node:crypto";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoArtifactSafetyRepository } from "../../src/repositories/artifactSafetyRepository";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { history } from "./controlFixtures";
import type { ArtifactAuthority } from "../../src/types/artifactCleanup";
import {
  introductionClient as client,
  createIntroductionTable,
} from "./fixtures/introductionStore";

const prefix = `artifact-test-${randomUUID()}-`;
const tables = {
  deploymentControl: prefix + "control",
  meetingHistory: prefix + "history",
};
const repository = createDynamoArtifactSafetyRepository(client, tables);
beforeAll(async () => {
  await createIntroductionTable(tables.deploymentControl);
  await createIntroductionTable(tables.meetingHistory, [
    "guildId",
    "channelId_timestamp",
  ]);
});
async function setup() {
  const f = artifactSafetyFixture();
  f.ctl.coordinatorToken = randomUUID();
  f.ctl.deployment!.runToken = f.ctl.coordinatorToken;
  f.expected.request.coordinatorToken = f.ctl.coordinatorToken;
  const row = {
    ...history,
    status: "complete" satisfies "complete",
    audioS3Key: "fixture/audio",
  };
  const authority: ArtifactAuthority = {
    owner: {
      guildId: row.guildId,
      meetingId: row.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
    },
    historyKey: row.channelId_timestamp,
    checkpoint: null,
    status: "complete",
    completionDecision: null,
    audioS3Key: row.audioS3Key,
    chatS3Key: null,
    transcriptS3Key: null,
  };
  f.expected.proof.snapshot.authorities = [authority];
  for (const Item of [f.ctl, f.source, f.expected])
    await client.send(
      new PutItemCommand({
        TableName: tables.deploymentControl,
        Item: marshall(Item),
      }),
    );
  await client.send(
    new PutItemCommand({
      TableName: tables.meetingHistory,
      Item: marshall(row),
    }),
  );
  const write = {
    purpose: "consume" satisfies "consume",
    expected: f.expected,
    next: {
      ...f.expected,
      revision: 3,
      state: "consumed" satisfies "consumed",
      consumedAt: 120,
    },
    context: {
      kind: "preparing" satisfies "preparing",
      control: f.ctl,
      runtime: f.source,
    },
    now: 120,
  };
  return { ...f, row, write };
}
async function controlRow() {
  const result = await client.send(
    new GetItemCommand({
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: "CONTROL" }),
      ConsistentRead: true,
    }),
  );
  return unmarshall(result.Item!);
}
test("native transaction consumes the proof and advances warming atomically", async () => {
  const f = await setup();
  expect(await repository.write(f.write)).toBe("applied");
  expect(await repository.read(f.source.identity)).toMatchObject({
    state: "consumed",
    consumedAt: 120,
  });
  expect((await controlRow()).deployment.phase).toBe("warming");
  expect(await repository.write(f.write)).toBe("applied");
});
test.each(["history_owner", "source_generation", "coordinator"])(
  "changed %s refuses every transaction write",
  async (reason) => {
    const f = await setup();
    if (reason === "history_owner")
      await client.send(
        new PutItemCommand({
          TableName: tables.meetingHistory,
          Item: marshall({ ...f.row, ownerInstanceId: "other" }),
        }),
      );
    else
      await client.send(
        new PutItemCommand({
          TableName: tables.deploymentControl,
          Item: marshall(
            reason === "source_generation"
              ? { ...f.source, authorizedGeneration: 99 }
              : { ...f.ctl, coordinatorToken: "other" },
          ),
        }),
      );
    expect(await repository.write(f.write)).toBe("stale");
    expect((await repository.read(f.source.identity))?.state).toBe("sealed");
    expect((await controlRow()).deployment.phase).toBe("preparing");
  },
);
