/** @jest-environment node */
import * as artifactTypes from "../../src/types/artifactSafety";
import * as artifactBuilders from "../../src/services/artifactSafetyTransactions";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { createArtifactHandoff } from "../../scripts/deployment/artifact-handoff.cjs";

function fixture() {
  const f = artifactSafetyFixture();
  let row: artifactTypes.ArtifactSafetyRecord | undefined = f.expected;
  const aws = jest.fn(async (_service, operation, input) => {
    if (operation === "get-item")
      return { Item: row ? marshall(row) : undefined };
    row = artifactTypes.artifactSafetyRecordSchema.parse(
      unmarshall(input.TransactItems[0].Put.Item),
    );
    if (row.state === "consumed")
      f.ctl = artifactBuilders.artifactConsumeControl(f.ctl, 120);
    return {};
  });
  const helper = createArtifactHandoff({
    artifactTypes,
    artifactBuilders,
    aws,
    tables: f.tables,
    now: () => 120,
    runtime: async () => f.source,
    control: async () => f.ctl,
    renew: async () => f.ctl,
    protectedTask: async () => ({
      expirationDate: new Date(600_000).toISOString(),
    }),
    sleep: async () => {
      throw new Error("unexpected wait");
    },
    production: undefined,
  });
  return {
    ...f,
    helper,
    aws,
    setRow: (value: artifactTypes.ArtifactSafetyRecord | undefined) => {
      row = value;
    },
  };
}

test("consumes the exact sealed proof together with warming before launch", async () => {
  const f = fixture();
  expect((await f.helper.prepare(f.ctl)).deployment.phase).toBe("warming");
  expect(
    f.aws.mock.calls.filter((call) => call[1] === "transact-write-items"),
  ).toHaveLength(1);
  await expect(
    f.helper.committed(
      await f.helper.prepare({
        ...f.ctl,
        deployment: { ...f.ctl.deployment, phase: "warming" },
      }),
    ),
  ).resolves.toBeDefined();
});

test("legacy capability refuses, including an emergency quiet override", async () => {
  const f = fixture();
  f.setRow(undefined);
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow(/capability/);
  expect(
    f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
  ).toBe(false);
});

test("cancel is only legal before atomic proof consumption", async () => {
  const f = fixture();
  const warming = await f.helper.prepare(f.ctl);
  await expect(f.helper.cancel(warming)).rejects.toThrow();
});

test("a candidate needs its own fresh sealed startup proof", async () => {
  const f = fixture();
  await expect(f.helper.candidate(f.source.identity)).rejects.toThrow(
    /startup/,
  );
});
