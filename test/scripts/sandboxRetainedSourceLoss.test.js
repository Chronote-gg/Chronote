/** @jest-environment node */
import process from "node:process";
import { test, expect, jest } from "@jest/globals";
import { recoverRetainedSandbox } from "../../scripts/deployment/recover-retained-sandbox.cjs";
import { retainedSourceLossFixture } from "../deployment/fixtures/retainedSourceLossFixture";
import { recoverSandbox } from "../../scripts/deployment/recover-sandbox.cjs";
import { sourceLossFixture } from "../deployment/fixtures/sourceLossFixture";

test("retained path requires an approved private packet before any recovery write", async () => {
  const f = await sourceLossFixture();
  f.loss.missing = true;
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(
    f.calls
      .slice(f.before)
      .filter((c) =>
        ["transact-write-items", "modify-listener"].includes(c.operation),
      ),
  ).toEqual([]);
});

const writes = (f) =>
  f.calls
    .slice(f.before)
    .filter((c) =>
      [
        "transact-write-items",
        "modify-listener",
        "update-item",
        "register-task-definition",
        "update-service",
        "stop-task",
        "update-task-protection",
      ].includes(c.operation),
    );
async function reviewed(f) {
  const inspection = await recoverRetainedSandbox({
    ...f.options,
    mode: "inspect",
  });
  f.options.env.SOURCE_LOSS_BINDING_SHA256 = inspection.bindingSha256;
  return inspection;
}
test.each([false, true])(
  "retained proof restores same candidate, native missing %s",
  async (missing) => {
    const f = await retainedSourceLossFixture();
    f.loss.missing = missing;
    const old = structuredClone(f.state.rows.old);
    const inspection = await reviewed(f);
    expect(inspection.binding.kind).toBe("sandbox_retained_source_loss");
    expect(inspection.binding.terminal.terminalProof).toMatchObject({
      provenance: "operator_captured_provider_response",
      nativeObservation: missing ? "MISSING" : "STOPPED",
    });
    expect(writes(f)).toEqual([]);
    expect(
      await recoverRetainedSandbox({ ...f.options, mode: "recover" }),
    ).toMatchObject({
      kind: "availability_restored",
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.loss.receipt).toMatchObject({
      version: 2,
      terminalProof: {
        packetSha256: f.options.env.SOURCE_LOSS_TERMINAL_PROOF_SHA256,
        originalSnapshotSha256: f.packet.originalSnapshotSha256,
        nativeObservation: missing ? "MISSING" : "STOPPED",
      },
      stage: "availability_restored",
    });
    expect(f.state.rows.old).toEqual(old);
    expect(writes(f).map((c) => c.operation)).toEqual([
      "transact-write-items",
      "transact-write-items",
      "modify-listener",
      "transact-write-items",
    ]);
  },
);
test("native STOPPED path still refuses MISSING even when private retained packet is present", async () => {
  const f = await retainedSourceLossFixture();
  f.loss.missing = true;
  await expect(
    recoverSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test.each([
  "checksum",
  "extra",
  "source_arn",
  "definition",
  "digest",
  "cluster",
  "account",
  "region",
  "future_capture",
  "stop_after_capture",
  "not_stopped",
  "provenance",
  "version",
  "binding",
  "capture_missing",
])("retained path rejects %s before writes", async (kind) => {
  const f = await retainedSourceLossFixture();
  f.loss.missing = true;
  if (kind === "checksum")
    f.options.env.SOURCE_LOSS_TERMINAL_PROOF_SHA256 = "0".repeat(64);
  else {
    const mutations = {
      extra: (p) => {
        p.notes = "PRIVATE";
      },
      source_arn: (p) => {
        p.sourceTask.taskArn += "foreign";
      },
      definition: (p) => {
        p.sourceTask.taskDefinitionArn = "foreign";
      },
      digest: (p) => {
        p.sourceTask.containers[0].imageDigest = "sha256:" + "d".repeat(64);
      },
      cluster: (p) => {
        p.sourceTask.clusterArn += "foreign";
      },
      account: (p) => {
        p.accountId = "999999999999";
      },
      region: (p) => {
        p.region = "us-west-2";
      },
      future_capture: (p) => {
        p.capturedAt = new Date(1001000).toISOString();
      },
      stop_after_capture: (p) => {
        p.sourceTask.stoppedAt = new Date(999900).toISOString();
      },
      not_stopped: (p) => {
        p.sourceTask.lastStatus = "RUNNING";
      },
      provenance: (p) => {
        p.provenance = "aws_signed";
      },
      version: (p) => {
        p.sourceTask.version = 0;
      },
      binding: (p) => {
        p.operationBinding.servingGeneration++;
      },
      capture_missing: (p) => {
        delete p.capturedAt;
      },
    };
    mutations[kind](f.packet);
    f.bindPacket();
  }
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test.each([
  "RUNNING",
  "denied",
  "wrong_missing",
  "multiple_missing",
  "candidate_missing",
  "transport",
])("retained proof never substitutes for current %s response", async (kind) => {
  const f = await retainedSourceLossFixture();
  if (kind === "RUNNING") f.loss.sourceStatus = "RUNNING";
  else f.loss.missing = true;
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "describe-tasks" && kind === "transport")
      throw new Error("transport failed");
    const response = await original(service, operation, input);
    if (
      operation === "describe-tasks" &&
      input.tasks.includes(f.oldIdentity.taskArn)
    ) {
      if (kind === "denied") response.failures[0].reason = "ACCESS_DENIED";
      if (kind === "wrong_missing") response.failures[0].arn += "foreign";
      if (kind === "multiple_missing")
        response.failures.push({
          reason: "MISSING",
          arn: f.candidateIdentity.taskArn,
        });
      if (kind === "candidate_missing") response.tasks = [];
    }
    return response;
  });
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("new retained path preserves submitted fence on unknown listener response", async () => {
  const f = await retainedSourceLossFixture();
  f.loss.missing = true;
  await reviewed(f);
  f.traffic.unknown = true;
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(1);
});

test("packet canonical hash permits formatting changes but never metadata changes", async () => {
  const f = await retainedSourceLossFixture();
  f.loss.missing = true;
  f.options.env.SOURCE_LOSS_TERMINAL_PROOF_JSON = JSON.stringify(
    Object.fromEntries(Object.entries(f.packet).reverse()),
    null,
    2,
  );
  expect((await reviewed(f)).kind).toBe("inspection");
  f.packet.sourceTask.version++;
  f.options.env.SOURCE_LOSS_TERMINAL_PROOF_JSON = JSON.stringify(f.packet);
  await expect(
    recoverRetainedSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("retained CLI errors never echo the private packet", () => {
  const { spawnSync } = jest.requireActual("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["scripts/deployment/recover-retained-sandbox.cjs", "inspect"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SOURCE_LOSS_TERMINAL_PROOF_JSON:
          '{"PRIVATE_PROVIDER_IDENTIFIERS":"PRIVATE"}',
        SOURCE_LOSS_TERMINAL_PROOF_SHA256: "a".repeat(64),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("PRIVATE");
  expect(result.stderr).toContain("retained_source_loss_recovery_failed");
});

test.each(["slow_native", "foreign_listener"])(
  "retained recovery preserves fence for %s",
  async (kind) => {
    const f = await retainedSourceLossFixture();
    f.loss.missing = true;
    await reviewed(f);
    if (kind === "foreign_listener")
      f.loss.afterWrite = (receipt) => {
        if (receipt.stage === "forward_submitted")
          f.traffic.actions = [
            { Type: "redirect", RedirectConfig: { Host: "foreign.example" } },
          ];
      };
    const original = f.aws.getMockImplementation();
    f.aws.mockImplementation(async (service, operation, input) => {
      const result = await original(service, operation, input);
      if (
        kind === "slow_native" &&
        operation === "get-task-protection" &&
        f.loss.receipt?.stage === "forward_submitted"
      )
        f.loss.clock += 31;
      return result;
    });
    await expect(
      recoverRetainedSandbox({ ...f.options, mode: "recover" }),
    ).rejects.toThrow();
    expect(f.loss.receipt.stage).toBe("forward_submitted");
    expect(
      writes(f).filter((c) => c.operation === "modify-listener"),
    ).toHaveLength(0);
  },
);
