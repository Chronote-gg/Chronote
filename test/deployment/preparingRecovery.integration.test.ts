/** @jest-environment node */
import { randomUUID } from "node:crypto";
import {
  DeleteTableCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { localControlTable } from "./fixtures/localControlTable";
import { preparingRecoveryFixture } from "./fixtures/preparingRecoveryFixture";
import { recoverPreparingSandbox } from "../../scripts/deployment/recover-preparing-sandbox.cjs";
import {
  buildPreparingRecovery,
  commitPreparingRecovery,
} from "../../scripts/deployment/preparing-recovery-state.cjs";
const { client, createTable, records, transact } = localControlTable();
afterAll(() => client.destroy());

test.each([
  "success",
  "lost_ack",
  "control_race",
  "archive_race",
  "recovery_race",
  "source_proof_race",
  "already_consumed",
  "before_commit",
  "wrong_receipt",
  "cursor_progress",
])("native one-use preparing recovery: %s", async (scenario) => {
  const f = await preparingRecoveryFixture();
  const inspected = await recoverPreparingSandbox({
    ...f.options,
    mode: "inspect",
  });
  const observed = {
    control: structuredClone(f.state.ctl),
    archive: f.archive,
    recovery: f.recovery,
    source: f.oldIdentity,
    bindingSha256: inspected.bindingSha256,
  };
  const claim = buildPreparingRecovery({
    observed,
    proof: f.proof,
    proofSha256: f.options.env.PREPARING_RECOVERY_PROOF_SHA256,
    executionRunToken: "902-1",
    actorArn: "actual-test-actor",
    now: f.options.now(),
    types: f.options.types,
    builders: f.options.builders,
  });
  const table = "preparing-" + randomUUID();
  const { put, read, invalidateReadiness, progress } = records(table);
  await createTable(table);
  try {
    for (const row of [
      f.state.ctl,
      f.state.rows.old,
      f.archive,
      f.recovery,
      f.carry.historical,
    ])
      await put(row);
    if (scenario === "control_race")
      await put({ ...f.state.ctl, coordinatorEpoch: 99 });
    if (scenario === "archive_race")
      await put({ ...f.archive, bindingSha256: "0".repeat(64) });
    if (scenario === "recovery_race")
      await put({ ...f.recovery, updatedAt: 9999 });
    if (scenario === "source_proof_race")
      await invalidateReadiness(f.state.rows.old.sk);
    if (scenario === "already_consumed") await put(claim.receipt);
    if (scenario === "cursor_progress")
      await progress({ guildId: "guild", channelId_timestamp: "progress" });
    let writes = 0;
    const aws = async (
      _service: string,
      operation: string,
      input: TransactWriteItemsCommandInput,
    ) => {
      expect(operation).toBe("transact-write-items");
      writes++;
      if (scenario === "before_commit") throw Error("not committed");
      const response = await transact(table, input);
      if (scenario === "wrong_receipt") {
        await put({ ...claim.receipt, definitionArn: "wrong" });
        throw Error("uncertain");
      }
      if (scenario === "lost_ack") throw Error("response lost");
      return response;
    };
    const commit = commitPreparingRecovery({
      aws,
      inspector: { read, control: () => read("ENV", "CONTROL") },
      claim,
    });
    const accepted = ["success", "lost_ack", "cursor_progress"].includes(
      scenario,
    );
    if (accepted) await commit;
    else await expect(commit).rejects.toThrow();
    expect(writes).toBe(1);
    const current = await read("ENV", "CONTROL");
    if (accepted) {
      expect(current).toMatchObject({
        coordinatorToken: "901-1",
        coordinatorEpoch: claim.next.coordinatorEpoch,
        servingGeneration: observed.control.servingGeneration,
        servingMembers: observed.control.servingMembers,
        deployment: {
          phase: "preparing",
          taskDefinition: "definition:new",
          runToken: "901-1",
        },
      });
      expect(await read(claim.receipt.pk, claim.receipt.sk)).toEqual(
        claim.receipt,
      );
      if (scenario === "cursor_progress")
        expect(current!.recoveryScanCursor).toEqual({
          guildId: "guild",
          channelId_timestamp: "progress",
        });
    } else if (!["wrong_receipt", "already_consumed"].includes(scenario))
      expect(await read(claim.receipt.pk, claim.receipt.sk)).toBeUndefined();
    expect(await read(f.archive.pk, f.archive.sk)).toEqual(
      scenario === "archive_race"
        ? { ...f.archive, bindingSha256: "0".repeat(64) }
        : f.archive,
    );
    expect(await read(f.recovery.pk, f.recovery.sk)).toEqual(
      scenario === "recovery_race"
        ? { ...f.recovery, updatedAt: 9999 }
        : f.recovery,
    );
    expect(await read("ENV", "RUNTIME#lost")).toEqual(f.carry.historical);
  } finally {
    await client.send(new DeleteTableCommand({ TableName: table }));
  }
});
