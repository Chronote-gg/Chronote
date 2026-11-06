import { randomUUID } from "node:crypto";
import type { TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { fixture, candidateIdentity } from "./fixtures/coordinatorFixture";
import {
  createIntroductionTable,
  putIntroductionDocument,
  readIntroductionDocument,
  writeIntroduction,
} from "./fixtures/introductionStore";

const table = `promotion-preservation-${randomUUID()}`;
beforeAll(() => createIntroductionTable(table));

test("a real artifact heartbeat condition failure retries without partial admission", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  let attempts = 0;
  let refused = false;
  const coordinator = createCoordinator({
    ...f.options,
    sleep: async () => f.advanceTime(10),
    aws: async (
      service: string,
      operation: string,
      input: TransactWriteItemsCommandInput,
    ) => {
      if (
        operation !== "transact-write-items" ||
        !input.TransactItems?.[0].Update
      )
        return f.aws(service, operation, input);
      attempts++;
      if (attempts === 1) {
        const artifact = f.state.artifacts.get("new");
        if (!artifact) throw new Error("Missing candidate artifact fixture");
        artifact.revision++;
        artifact.heartbeatAt++;
        artifact.freshUntil++;
      }
      for (const row of [
        f.state.ctl,
        ...Object.values(f.state.rows),
        ...f.state.artifacts.values(),
      ])
        await putIntroductionDocument(table, row);
      const transaction = {
        TransactItems: input.TransactItems.map((item) => {
          if (item.Update)
            return { Update: { ...item.Update, TableName: table } };
          if (item.ConditionCheck)
            return {
              ConditionCheck: { ...item.ConditionCheck, TableName: table },
            };
          throw new Error("Unexpected promotion operation");
        }),
      };
      try {
        await writeIntroduction(transaction);
      } catch (error) {
        refused = true;
        expect(f.state.ctl.servingGeneration).toBe(1);
        expect(f.state.rows.new.role).toBe("candidate");
        expect(
          await readIntroductionDocument(table, { pk: "ENV", sk: "CONTROL" }),
        ).toMatchObject({
          servingGeneration: 1,
          servingMembers: { old: f.state.rows.old.identity },
        });
        expect(
          await readIntroductionDocument(table, {
            pk: "ENV",
            sk: "RUNTIME#new",
          }),
        ).toMatchObject({ role: "candidate", authorizedGeneration: 1 });
        throw error;
      }
      return f.aws(service, operation, input);
    },
  });
  await expect(coordinator.promote()).resolves.toEqual({ kind: "promoted" });
  expect(refused).toBe(true);
  expect(attempts).toBe(2);
  expect(f.state.ctl.servingGeneration).toBe(2);
  expect(f.state.ctl.servingMembers).toEqual({ new: candidateIdentity });
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(
    await readIntroductionDocument(table, { pk: "ENV", sk: "CONTROL" }),
  ).toMatchObject({
    servingGeneration: 2,
    servingMembers: { new: candidateIdentity },
  });
  expect(
    await readIntroductionDocument(table, { pk: "ENV", sk: "RUNTIME#new" }),
  ).toMatchObject({ role: "serving", authorizedGeneration: 2 });
});
