import { randomUUID } from "node:crypto";
import {
  GetItemCommand,
  type GetItemCommandInput,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import * as artifactTypes from "../../src/types/artifactSafety";
import * as artifactBuilders from "../../src/services/artifactSafetyTransactions";
import {
  controlRecordSchema,
  runtimeRecordSchema,
} from "../../src/types/deploymentControl";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { createArtifactHandoff } from "../../scripts/deployment/artifact-handoff.cjs";
import {
  introductionClient,
  createIntroductionTable,
  readIntroductionDocument,
  putIntroductionDocument,
  writeIntroduction,
} from "./fixtures/introductionStore";

const table = `handoff-retry-${randomUUID()}`;
beforeAll(() => createIntroductionTable(table));

async function fixture() {
  const f = artifactSafetyFixture();
  const idle = artifactTypes.artifactSafetyRecordSchema.parse({
    ...artifactTypes.artifactSafetyBaseSchema.parse(f.expected),
    state: "idle",
  });
  const put = (row: object) => putIntroductionDocument(table, row);
  for (const row of [idle, f.ctl, f.source]) await put(row);
  const readControl = async () =>
    controlRecordSchema.parse(
      await readIntroductionDocument(table, { pk: "ENV", sk: "CONTROL" }),
    );
  const readArtifact = async () =>
    artifactTypes.artifactSafetyRecordSchema.parse(
      await readIntroductionDocument(
        table,
        artifactTypes.artifactSafetyKey(f.source.identity),
      ),
    );
  let beforeWrite = async () => {};
  let loseResponse = false;
  const aws = jest.fn(
    async (
      _service: string,
      _operation: string,
      input: GetItemCommandInput & TransactWriteItemsCommandInput,
    ) => {
      if (!input.TransactItems)
        return introductionClient.send(new GetItemCommand(input));
      await beforeWrite();
      const result = await writeIntroduction(input);
      if (loseResponse) throw new Error("lost response");
      return result;
    },
  );
  const helper = createArtifactHandoff({
    artifactTypes,
    artifactBuilders,
    tables: { deploymentControl: table, meetingHistory: "unused-history" },
    aws,
    now: () => 120,
    control: readControl,
    runtime: async () =>
      runtimeRecordSchema.parse(
        await readIntroductionDocument(table, { pk: "ENV", sk: "RUNTIME#old" }),
      ),
    renew: readControl,
    protectedTask: async () => ({
      expirationDate: new Date(600_000).toISOString(),
    }),
    sleep: async () => {
      throw new Error("request written");
    },
    assertWriter: async () => {},
    own: () => {},
    service: async () => ({ taskDefinition: "previous" }),
    tasks: async () => [],
  });
  return {
    ...f,
    idle,
    helper,
    aws,
    put,
    readControl,
    readArtifact,
    beforeWrite: (callback: () => Promise<void>) => {
      beforeWrite = callback;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

test("native request retries a real revision conflict and never reads history", async () => {
  const f = await fixture();
  let attempts = 0;
  f.beforeWrite(async () => {
    if (++attempts === 1)
      await f.put({
        ...f.idle,
        revision: f.idle.revision + 1,
        heartbeatAt: 120,
        freshUntil: 180,
      });
  });
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow("request written");
  expect(attempts).toBe(2);
  expect((await f.readArtifact()).state).toBe("requested");
  expect((await f.readControl()).deployment?.phase).toBe("preparing");
});

test.each([false, true])(
  "native idle cancellation completes atomically, lost response=%s",
  async (lost) => {
    const f = await fixture();
    if (lost) f.loseResponse();
    await expect(f.helper.cancelPreparation()).resolves.toEqual({
      kind: "cancelled",
    });
    expect((await f.readControl()).deployment?.phase).toBe("complete");
    expect(await f.readArtifact()).toEqual(f.idle);
  },
);

test.each([
  "heartbeat",
  "request",
  "warming",
  "epoch",
  "runtime",
  "protection",
])("native idle cancellation fences a concurrent %s change", async (change) => {
  const f = await fixture();
  let attempts = 0;
  f.beforeWrite(async () => {
    if (++attempts > 1) return;
    if (change === "heartbeat")
      await f.put({ ...f.idle, revision: f.idle.revision + 1 });
    if (change === "request")
      await f.put({
        ...f.idle,
        state: "requested",
        request: f.expected.request,
      });
    if (change === "warming")
      await f.put({
        ...f.ctl,
        deployment: { ...f.ctl.deployment, phase: "warming" },
      });
    if (change === "epoch")
      await f.put({ ...f.ctl, coordinatorEpoch: f.ctl.coordinatorEpoch + 1 });
    if (change === "runtime")
      await f.put({
        ...f.source,
        authorizedGeneration: f.source.authorizedGeneration! + 1,
      });
    if (change === "protection")
      await f.put({
        ...f.source,
        protection: { ...f.source.protection, expiresAt: 119 },
      });
  });
  if (change === "heartbeat") {
    await expect(f.helper.cancelPreparation()).resolves.toEqual({
      kind: "cancelled",
    });
    expect(attempts).toBe(2);
  } else {
    await expect(f.helper.cancelPreparation()).rejects.toThrow();
    expect((await f.readControl()).deployment?.phase).toBe(
      change === "warming" ? "warming" : "preparing",
    );
  }
});
