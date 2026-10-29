/** @jest-environment node */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  candidateDefinition,
  runCli,
} from "../../scripts/deployment/coordinator.cjs";

import {
  fixture,
  oldIdentity,
  candidateIdentity,
  env,
  counts,
} from "../deployment/fixtures/coordinatorFixture";

test("CLI reports unsupported capability before mutation without provider output", async () => {
  const f = fixture();
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "validate-update-service")
      throw new Error("RAW_PROVIDER_SECRET_AND_PAYLOAD");
    return original(service, operation, input);
  });
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(await runCli("prepare", f.options, output)).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({
    requestedPhase: "prepare",
    knownPhase: "none",
    operation: "ecs.validate-update-service",
    category: "cli_capability_unsupported",
    nativeProtection: "not_checked",
    taskAction: "no_stop_or_unprotect_requested",
  });
  expect(output.error.mock.calls[0][0]).not.toContain("RAW_PROVIDER");
  expect(output.error.mock.calls[0][0].length).toBeLessThan(512);
  expect(
    f.calls.some((call) =>
      ["put-item", "register-task-definition", "update-service"].includes(
        call.operation,
      ),
    ),
  ).toBe(false);
});

test("process CLI exits nonzero with bounded configuration diagnostics", () => {
  const child = spawnSync(
    process.execPath,
    [resolve("scripts/deployment/coordinator.cjs"), "prepare"],
    {
      env: { SECRETS_PREFIX: "PRIVATE/INVALID/PREFIX" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(JSON.parse(child.stderr)).toMatchObject({
    category: "configuration_invalid",
    operation: "configuration",
    knownPhase: "unknown",
    nativeProtection: "not_checked",
    taskAction: "no_stop_or_unprotect_requested",
  });
  expect(child.stderr).not.toContain("PRIVATE");
  expect(child.stderr.length).toBeLessThan(512);
});

test("CLI labels a positive native proof only as the last completed check", async () => {
  const f = fixture();
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "register-task-definition")
      throw new Error("PRIVATE_PROVIDER_DETAIL");
    return original(service, operation, input);
  });
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(await runCli("prepare", f.options, output)).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({
    knownPhase: "preparing",
    operation: "ecs.register-task-definition",
    category: "provider_operation_failed",
    nativeProtection: "last_check_confirmed",
    taskAction: "no_stop_or_unprotect_requested",
  });
  expect(output.error.mock.calls[0][0]).not.toContain(
    "PRIVATE_PROVIDER_DETAIL",
  );
  expect(f.calls.some((call) => call.operation === "update-service")).toBe(
    false,
  );
});

test("CLI reports rejected native protection truthfully without replacement writes", async () => {
  const f = fixture();
  f.state.protected = false;
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(await runCli("prepare", f.options, output)).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({
    requestedPhase: "prepare",
    knownPhase: "none",
    operation: "verify_native_protection",
    category: "native_protection_unconfirmed",
    nativeProtection: "unconfirmed",
    taskAction: "no_stop_or_unprotect_requested",
  });
  expect(output.error.mock.calls[0][0]).not.toContain(
    "Protected work is preserved",
  );
  expect(
    f.calls.some((call) =>
      [
        "put-item",
        "register-task-definition",
        "update-service",
        "stop-task",
        "update-task-protection",
      ].includes(call.operation),
    ),
  ).toBe(false);
});

test("CLI identifies a control-store failure without guessing availability or logging details", async () => {
  const f = fixture();
  f.aws.mockRejectedValue(new Error("PRIVATE_DATABASE_PAYLOAD"));
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(await runCli("prepare", f.options, output)).toBe(1);
  expect(JSON.parse(output.error.mock.calls[0][0])).toMatchObject({
    operation: "dynamodb.get-item",
    category: "control_store_operation_failed",
    knownPhase: "unknown",
    nativeProtection: "not_checked",
  });
  expect(output.error.mock.calls[0][0]).not.toContain(
    "PRIVATE_DATABASE_PAYLOAD",
  );
  expect(f.aws).toHaveBeenCalledTimes(1);
});

test("oldAdmissionStaysOpenDuringWarmup", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(f.state.rows.old.role).toBe("serving");
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(
    f.calls.findIndex((call) => call.operation === "get-task-protection"),
  ).toBeLessThan(
    f.calls.findIndex((call) => call.operation === "update-service"),
  );
});
test.each(["future_readiness", "future_protection"])(
  "prepare refuses an invalid old proof before mutation: %s",
  async (kind) => {
    const f = fixture();
    if (kind === "future_readiness") f.state.rows.old.readiness.provenAt = 2000;
    if (kind === "future_protection")
      f.state.rows.old.protection.provenAt = 2000;
    await expect(f.coordinator.prepare()).rejects.toThrow(
      "not a ready compatible",
    );
    expect(
      f.calls.some((call) =>
        ["put-item", "update-service", "register-task-definition"].includes(
          call.operation,
        ),
      ),
    ).toBe(false);
  },
);
test("deferredCleanupCapabilityIsValidatedBeforeMutationAndPreservesSettings", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  const validation = f.calls.findIndex(
    (call) => call.operation === "validate-update-service",
  );
  expect(validation).toBeLessThan(
    f.calls.findIndex((call) => call.operation === "update-item"),
  );
  const update = f.calls.find((call) => call.operation === "update-service");
  expect(update?.input).toMatchObject({
    deploymentConfiguration: {
      minimumHealthyPercent: 100,
      maximumPercent: 200,
      earlySuccessCriteria: {
        enable: true,
        healthyPercent: 100,
        sourceServiceRevisionCleanup: "DEFERRED",
      },
      alarms: { enable: true, rollback: true, alarmNames: ["fixture"] },
    },
  });
  expect(update?.input).not.toHaveProperty("desiredCount");
});
test("unsupportedRunnerCannotRequestReplacement", async () => {
  const f = fixture();
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "validate-update-service")
      throw new Error("unsupported CLI");
    return original(service, operation, input);
  });
  await expect(f.coordinator.prepare()).rejects.toMatchObject({
    category: "cli_capability_unsupported",
  });
  expect(
    f.calls.some((call) =>
      ["update-service", "register-task-definition", "put-item"].includes(
        call.operation,
      ),
    ),
  ).toBe(false);
});
test("candidateWithoutBotReadinessCannotPromote", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.rows.new.readiness.gatewayReady = false;
  await expect(f.coordinator.promote()).rejects.toThrow("readiness timeout");
  expect(f.state.ctl.servingGeneration).toBe(1);
});
test("failedWarmupDoesNotDrainOld", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.rows.new.readiness.dependenciesReady = false;
  await expect(f.coordinator.promote()).rejects.toThrow("readiness timeout");
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "recovery_required",
  });
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(f.state.rows.old.role).toBe("serving");
});
test("runnerLossReadsBackPromotion", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.losePromotionResponse = true;
  expect(await f.coordinator.promote()).toEqual({ kind: "promoted" });
  expect(f.state.ctl.servingMembers).toEqual({ new: candidateIdentity });
  expect(f.state.ctl.servingGeneration).toBe(2);
});
test("rollbackKeepsCandidateRecordingProtected", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.refreshProofs();
  f.state.rows.new.workCounts = counts(1);
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "rolled_back",
    candidatePreserved: true,
    recoveryRequired: true,
  });
  expect(f.state.ctl.servingGeneration).toBe(3);
  expect(f.state.rows.new.workCounts.recording).toBe(1);
  expect(f.state.rows.new.retirementRequest).toBeUndefined();
  expect(
    f.calls.some((call) =>
      ["stop-task", "update-task-protection"].includes(call.operation),
    ),
  ).toBe(false);
});
test("twoBusyProtectedTasksDoNotGetKilledForCapacity", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.state.protected = false;
  await expect(f.coordinator.promote()).rejects.toThrow("DEPLOYMENT_BLOCKED");
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(
    f.calls.some((call) =>
      ["stop-task", "update-task-protection"].includes(call.operation),
    ),
  ).toBe(false);
});
test("retirementRequiresExactRuntimeAckAndProviderConvergence", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.state.retirementAcknowledged = true;
  expect(await f.coordinator.retire()).toEqual({ kind: "complete" });
  expect(f.state.rows.old.retirementAcknowledgment?.request).toMatchObject({
    coordinatorEpoch: 2,
    authorizedGeneration: 1,
    identity: oldIdentity,
  });
});
test("earlyProviderCompletionDoesNotHidePromotedApplicationFailure", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.refreshProofs();
  f.state.rows.new.readiness.dependenciesReady = false;
  f.state.rows.new.workCounts = counts(1);
  await expect(f.coordinator.retire()).rejects.toThrow("readiness lost");
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "rolled_back",
  });
  expect(f.state.ctl.servingMembers).toEqual({ old: oldIdentity });
  expect(f.state.rows.new.workCounts.recording).toBe(1);
});
test("retirementWithoutAckPreservesProtectedBusyOwner", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.state.rows.old.workCounts = counts(1);
  await expect(f.coordinator.retire()).rejects.toThrow("incomplete");
  expect(f.state.rows.old.workCounts!.recording).toBe(1);
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "recovery_required",
    phase: "retiring",
  });
});
test("ambiguousEcsUpdateIsReadBack", async () => {
  const f = fixture();
  f.state.loseUpdateResponse = true;
  expect(await f.coordinator.prepare()).toEqual({ kind: "warming" });
});
test("taskDefinitionPreservesFieldsAndPinsStopTimeoutAndIdentity", () => {
  const f = fixture();
  const result = candidateDefinition(f.definition, {
    tablePrefix: "fixture-",
    image: env.CANDIDATE_IMAGE,
    candidateId: "run-2",
  });
  expect(result.taskRoleArn).toBe("task-role");
  expect(result.volumes).toEqual(f.definition.volumes);
  expect(result.containerDefinitions[0].secrets).toEqual(
    f.definition.containerDefinitions[0].secrets,
  );
  expect(result.containerDefinitions[0].stopTimeout).toBe(120);
  expect(result.containerDefinitions[0].environment).toContainEqual({
    name: "DEPLOYMENT_CANDIDATE_ID",
    value: "run-2",
  });
  expect(result.taskDefinitionArn).toBeUndefined();
});

test("both workflows use the shared coordinator without lease scans or unconditional rollback", () => {
  for (const name of ["deploy.yml", "deploy-staging.yml"]) {
    const workflow = readFileSync(resolve(".github/workflows", name), "utf8");
    for (const phase of ["prepare", "promote", "retire", "reconcile"])
      expect(workflow).toContain(
        `node scripts/deployment/coordinator.cjs ${phase}`,
      );
    expect(workflow).not.toContain("Wait for active meetings to finish");
    expect(workflow).not.toContain("aws ecs update-service");
    expect(workflow).toContain("cancel-in-progress: false");
  }
});

test("native protection accepts AWS short task ARN responses", async () => {
  const f = fixture();
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    if (operation === "get-task-protection") {
      result.protectedTasks = result.protectedTasks.map(
        (proof: { taskArn: string }) => ({
          ...proof,
          taskArn: proof.taskArn.replace("task/fixture/", "task/"),
        }),
      );
    }
    return result;
  });
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(await runCli("prepare", f.options, output)).toBe(0);
  expect(f.calls.some((call) => call.operation === "update-service")).toBe(
    true,
  );
});

test("ordinary prepare refuses missing legacy Control before any provider mutation", async () => {
  const f = fixture();
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "get-item" && input.Key?.sk?.S === "CONTROL") return {};
    return original(service, operation, input);
  });
  await expect(f.coordinator.prepare()).rejects.toThrow(
    "Compatible ECS control required",
  );
  expect(f.aws).toHaveBeenCalledTimes(2);
  expect(f.aws).toHaveBeenCalledWith(
    "dynamodb",
    "get-item",
    expect.objectContaining({ ConsistentRead: true }),
  );
});
