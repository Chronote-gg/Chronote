/** @jest-environment node */
import { randomUUID } from "node:crypto";
import {
  DeleteTableCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { localControlTable } from "./fixtures/localControlTable";
import { carryforwardFixture } from "./fixtures/carryforwardFixture";
import { carryforwardSandbox } from "../../scripts/deployment/carryforward-sandbox.cjs";
import {
  buildCarryforward,
  commitCarryforward,
} from "../../scripts/deployment/carryforward-state.cjs";
const { client, createTable, records, transact } = localControlTable();
afterAll(() => client.destroy());
test.each([
  "success",
  "lost_ack",
  "control_race",
  "recovery_race",
  "source_proof_race",
  "already_consumed",
  "before_commit",
  "wrong_archive",
  "cursor_progress",
])("native append-only carryforward transaction: %s", async (scenario) => {
  const f = carryforwardFixture();
  const inspected = await carryforwardSandbox({
    ...f.options,
    mode: "inspect",
  });
  const claim = buildCarryforward({
    manifest: f.manifest,
    manifestSha256: f.options.env.CARRYFORWARD_MANIFEST_SHA256,
    bindingSha256: inspected.bindingSha256,
    observed: {
      control: structuredClone(f.state.ctl),
      recovery: f.carry.recovery,
      source: f.oldIdentity,
      routing: f.routing,
      runtimeMode: "all",
    },
    runToken: "901-1",
    actorArn: "actual-test-actor",
    now: 1000,
    types: f.options.types,
    builders: f.options.builders,
  });
  const table = "carryforward-" + randomUUID();
  const { put, read, invalidateReadiness, progress } = records(table);
  const voice = {
    pk: "VOICE#guild",
    sk: "STATE",
    ownerInstanceId: "lost",
    state: "uncertain",
    executionVersion: 3,
  };
  await createTable(table);
  try {
    await put(f.state.ctl);
    await put(f.state.rows.old);
    await put(f.carry.historical);
    await put(f.carry.recovery);
    await put(voice);
    if (scenario === "control_race")
      await put({ ...f.state.ctl, coordinatorEpoch: 99 });
    if (scenario === "recovery_race")
      await put({ ...f.carry.recovery, updatedAt: 999 });
    if (scenario === "source_proof_race")
      await invalidateReadiness(f.state.rows.old.sk);
    if (scenario === "already_consumed") await put(claim.archive);
    if (scenario === "cursor_progress")
      await progress({ guildId: "guild", channelId_timestamp: "progress" });
    const aws = async (
      _service: string,
      operation: string,
      input: TransactWriteItemsCommandInput,
    ) => {
      expect(operation).toBe("transact-write-items");
      if (scenario === "before_commit")
        throw new Error("request not committed");
      const response = await transact(table, input);
      if (scenario === "wrong_archive") {
        await put({ ...claim.archive, bindingSha256: "0".repeat(64) });
        throw new Error("uncertain response");
      }
      if (scenario === "lost_ack")
        throw new Error("response lost after commit");
      return response;
    };
    const inspector = {
      read,
      control: () => read("ENV", "CONTROL"),
      archiveKey: claim.archive.pk,
    };
    const commit = commitCarryforward({ aws, inspector, claim });
    const accepted = ["success", "lost_ack", "cursor_progress"].includes(
      scenario,
    );
    if (accepted) await expect(commit).resolves.toBeUndefined();
    else await expect(commit).rejects.toThrow();
    const current = await read("ENV", "CONTROL");
    if (accepted) {
      expect(current).toMatchObject({
        coordinatorToken: "901-1",
        coordinatorEpoch: 2,
        servingMembers: f.state.ctl.servingMembers,
        deployment: { phase: "preparing", outgoing: f.oldIdentity },
      });
      expect(await read(claim.archive.pk, "ARCHIVE")).toEqual(claim.archive);
      if (scenario === "cursor_progress")
        expect(current!.recoveryScanCursor).toEqual({
          guildId: "guild",
          channelId_timestamp: "progress",
        });
    } else if (!["wrong_archive", "already_consumed"].includes(scenario))
      expect(await read(claim.archive.pk, "ARCHIVE")).toBeUndefined();
    expect(await read("ENV", "RUNTIME#lost")).toEqual(f.carry.historical);
    expect(await read("VOICE#guild", "STATE")).toEqual(voice);
    expect(await read(f.carry.recovery.pk, "RECOVERY")).toEqual(
      scenario === "recovery_race"
        ? { ...f.carry.recovery, updatedAt: 999 }
        : f.carry.recovery,
    );
    expect(
      (await read("ENV", "RUNTIME#old"))!.retirementAcknowledgment,
    ).toBeUndefined();
  } finally {
    await client.send(new DeleteTableCommand({ TableName: table }));
  }
});
