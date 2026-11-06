/** @jest-environment node */
import { isDeepStrictEqual } from "node:util";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { createAwsCaller } from "../../scripts/deployment/coordinator-aws.cjs";
import {
  fixture,
  oldIdentity,
  candidateIdentity,
} from "../deployment/fixtures/coordinatorFixture";

test.each([
  ["warming", "unchanged"],
  ["promoting", "unchanged"],
  ["promoting", "epoch"],
  ["promoting", "members"],
  ["promoting", "candidate"],
  ["promoting", "image"],
])(
  "rechecks a late startup proof in %s with %s authority",
  async (phase, change) => {
    const f = fixture();
    await f.coordinator.prepare();
    let clock = f.options.now();
    let crossed = false;
    const original = f.aws.getMockImplementation()!;
    f.aws.mockImplementation(async (service, operation, input) => {
      if (
        !crossed &&
        f.state.ctl.deployment?.phase === phase &&
        operation === "get-item" &&
        typeof input === "object" &&
        input !== null &&
        "Key" in input &&
        isDeepStrictEqual(
          input.Key,
          marshall({ pk: "ENV", sk: "ARTIFACTS#new/STATE" }),
        )
      ) {
        clock += 41;
        crossed = true;
      }
      return original(service, operation, input);
    });
    const sleep = jest.fn(async () => {
      clock++;
      f.refreshArtifactProofs(clock);
      for (const row of Object.values(f.state.rows)) {
        row.readiness.provenAt = clock;
        row.readiness.expiresAt = clock + 30;
      }
      if (change === "epoch") f.state.ctl.coordinatorEpoch++;
      if (change === "members") f.state.ctl.servingMembers = {};
      if (change === "candidate")
        f.state.ctl.deployment!.candidate = oldIdentity;
      if (change === "image") f.state.ctl.deployment!.image = "changed";
    });
    const coordinator = createCoordinator({
      ...f.options,
      now: () => clock,
      sleep,
    });
    if (change === "unchanged") {
      await expect(coordinator.promote()).resolves.toEqual({
        kind: "promoted",
      });
      expect(f.state.ctl.servingMembers).toEqual({ new: candidateIdentity });
      expect(f.state.ctl.servingGeneration).toBe(2);
    } else {
      await expect(coordinator.promote()).rejects.toMatchObject({
        category: "coordinator_authority_changed",
      });
      expect(f.state.ctl.servingGeneration).toBe(1);
      expect(f.state.rows.new.role).toBe("candidate");
    }
    expect(crossed).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(f.state.rows.old.retirementRequest).toBeUndefined();
    expect(
      f.calls.some((call) =>
        ["stop-task", "update-task-protection"].includes(call.operation),
      ),
    ).toBe(false);
  },
);

test("a missing source preservation commitment never grants candidate admission", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.artifacts.delete("old");
  await expect(f.coordinator.promote()).rejects.toMatchObject({
    category: "artifact_preservation_unconfirmed",
  });
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(f.state.rows.new.role).toBe("candidate");
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
});

test("lost promotion acknowledgment is observed once without replaying admission", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.losePromotionResponse = true;
  await expect(f.coordinator.promote()).resolves.toEqual({ kind: "promoted" });
  expect(f.state.ctl.servingGeneration).toBe(2);
  expect(f.state.ctl.servingMembers).toEqual({ new: candidateIdentity });
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
});

test("an unknown promotion write outcome is not retried", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  const original = f.aws.getMockImplementation()!;
  let writes = 0;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "transact-write-items") {
      writes++;
      throw new Error("unknown write outcome");
    }
    return original(service, operation, input);
  });
  await expect(f.coordinator.promote()).rejects.toMatchObject({
    category: "control_store_operation_failed",
  });
  expect(writes).toBe(1);
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(f.state.rows.new.role).toBe("candidate");
});

test.each(["active", "future"])(
  "a genuinely invalid %s startup proof is refused",
  async (kind) => {
    const f = fixture();
    await f.coordinator.prepare();
    const artifact = f.state.artifacts.get("new");
    if (!artifact || artifact.startup.kind !== "sealed")
      throw new Error("Missing sealed candidate fixture");
    if (kind === "active")
      artifact.startup = { kind: "active", activatedAt: f.options.now() };
    else {
      artifact.startup.proof.provenAt++;
      artifact.startup.proof.expiresAt++;
    }
    await expect(f.coordinator.promote()).rejects.toMatchObject({
      category: "artifact_preservation_unconfirmed",
    });
    expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  },
);

test("a stopped source leaves the running replacement fenced until guarded recovery", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.outgoingTask = "stopped";
  f.state.protected = false;
  await expect(f.coordinator.promote()).rejects.toMatchObject({
    category: "native_protection_unconfirmed",
  });
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(f.state.launched).toBe(true);
  expect(f.state.outgoingTask).toBe("stopped");
  expect(
    f.state.ctl.servingMembers[candidateIdentity.instanceId],
  ).toBeUndefined();
  expect(f.state.rows.new.role).toBe("candidate");
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "recovery_required",
  });
});

test.each(["preservation", "protection"])(
  "a pending candidate proof cannot mask source %s failure",
  async (failure) => {
    const f = fixture();
    await f.coordinator.prepare();
    const artifact = f.state.artifacts.get("new");
    if (!artifact || artifact.startup.kind !== "sealed")
      throw new Error("Missing sealed candidate fixture");
    artifact.startup.proof.expiresAt = f.options.now() + 20;
    if (failure === "preservation") f.state.artifacts.delete("old");
    else f.state.protected = false;
    const sleep = jest.fn(async () => {
      throw new Error("Source failure must refuse before retry wait");
    });
    const coordinator = createCoordinator({ ...f.options, sleep });
    await expect(coordinator.promote()).rejects.toMatchObject({
      category:
        failure === "preservation"
          ? "artifact_preservation_unconfirmed"
          : "native_protection_unconfirmed",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
    expect(f.state.rows.new.role).toBe("candidate");
  },
);

test.each([
  {
    name: "SDK conditional cancellation",
    error: Object.assign(new Error("private provider details"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed" },
      ],
    }),
  },
  {
    name: "CLI conditional cancellation",
    error: Object.assign(new Error("private provider details"), {
      stderr:
        "An error occurred (TransactionCanceledException) when calling the TransactWriteItems operation: Transaction cancelled, please refer cancellation reasons for specific reasons [None, ConditionalCheckFailed]",
    }),
  },
])(
  "recognizes only a confirmed $name as safe to recheck",
  async ({ error }) => {
    const call = createAwsCaller(async () => {
      throw error;
    }, {});
    await expect(
      call("dynamodb", "transact-write-items", {}),
    ).rejects.toMatchObject({
      category: "control_store_condition_failed",
      operation: "dynamodb.transact-write-items",
      message: "Conditional control transaction refused",
    });
  },
);

test.each(["AccessDeniedException", "TransactionConflict", "unknown outcome"])(
  "does not classify %s as a confirmed conditional refusal",
  async (name) => {
    const call = createAwsCaller(async () => {
      throw Object.assign(new Error("private provider details"), { name });
    }, {});
    await expect(
      call("dynamodb", "transact-write-items", {}),
    ).rejects.toMatchObject({
      category: "control_store_operation_failed",
      message: "Coordinator AWS operation failed",
    });
  },
);
