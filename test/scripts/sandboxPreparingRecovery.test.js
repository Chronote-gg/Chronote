/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { preparingRecoveryFixture } from "../deployment/fixtures/preparingRecoveryFixture";
import { recoverPreparingSandbox } from "../../scripts/deployment/recover-preparing-sandbox.cjs";
import { readPreparingProof } from "../../scripts/deployment/preparing-recovery-proof.cjs";
import { bindingHash } from "../../scripts/deployment/binding-hash.cjs";

async function bind(f) {
  const result = await recoverPreparingSandbox({
    ...f.options,
    mode: "inspect",
  });
  f.options.env.CONTINUATION_BINDING_SHA256 = result.bindingSha256;
  return result;
}
function expectUnchangedHistory(f) {
  expect(f.carry.archive).toEqual(f.archive);
  expect(f.carry.recovery).toEqual(f.recovery);
}
test("preparing inspection is read-only and binds the existing registration and immutable history", async () => {
  const f = await preparingRecoveryFixture();
  expect(await bind(f)).toMatchObject({
    kind: "inspection",
    binding: { definitionArn: "definition:new", logicalRunToken: "901-1" },
  });
  expect(f.recoveryState.receipt).toBeUndefined();
  expect(f.state.ctl.deployment.taskDefinition).toBeUndefined();
  expect(f.carry.archive).toEqual(f.archive);
});
test.each([false, true])(
  "one recovery adopts without registering and genuinely retires source, lost response=%s",
  async (loseAck) => {
    const f = await preparingRecoveryFixture();
    await bind(f);
    f.recoveryState.loseAck = loseAck;
    const registrations = f.calls.filter(
      (c) => c.operation === "register-task-definition",
    ).length;
    expect(
      await recoverPreparingSandbox({ ...f.options, mode: "recover" }),
    ).toMatchObject({ kind: "preparing_recovery_complete" });
    expect(f.state.ctl.coordinatorToken).toBe("901-1");
    expect(f.state.ctl.deployment.phase).toBe("complete");
    expect(f.recoveryState.receipt.executionRunToken).toBe("902-1");
    expect(
      f.state.rows.old.retirementAcknowledgment.request.coordinatorToken,
    ).toBe("901-1");
    expect(
      f.calls.filter((c) => c.operation === "register-task-definition"),
    ).toHaveLength(registrations);
    expectUnchangedHistory(f);
    await expect(
      recoverPreparingSandbox({ ...f.options, mode: "recover" }),
    ).rejects.toThrow();
  },
);
test.each([
  "lease",
  "candidate",
  "acknowledged",
  "submitted",
  "pending",
  "receipt",
  "history",
  "registration_actor",
  "registration_time",
  "registration_value",
  "run_live",
  "proof",
  "competing",
])("refuses changed %s before claim", async (scenario) => {
  const f = await preparingRecoveryFixture();
  await bind(f);
  if (scenario === "lease")
    f.state.ctl.coordinatorExpiresAt = f.options.now() + 10;
  if (scenario === "candidate")
    f.state.ctl.deployment.candidate = f.state.rows.new.identity;
  if (scenario === "acknowledged")
    f.state.ctl.deployment.taskDefinition = "definition:new";
  if (scenario === "submitted")
    f.state.ctl.deployment.routing.state = "forward_submitted";
  if (scenario === "pending") f.svc.pendingCount = 1;
  if (scenario === "receipt") f.recoveryState.receipt = { foreign: true };
  if (scenario === "history") f.carry.recovery.updatedAt++;
  if (scenario === "registration_actor")
    f.carry.registered.registeredBy = "foreign";
  if (scenario === "registration_time")
    f.carry.registered.registeredAt = new Date(0).toISOString();
  if (scenario === "registration_value")
    f.carry.registered.containerDefinitions[0].stopTimeout = 30;
  if (scenario === "run_live") f.runProof.status = "in_progress";
  if (scenario === "proof")
    f.options.env.CONTINUATION_BINDING_SHA256 = "0".repeat(64);
  if (scenario === "competing")
    f.options.writerInventory.assertExclusive.mockRejectedValue(
      Error("competing"),
    );
  await expect(
    recoverPreparingSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  if (scenario !== "receipt") expect(f.recoveryState.receipt).toBeUndefined();
  expect(f.state.ctl.deployment.phase).not.toBe("complete");
});

test.each(["sourceGroup", "candidateGroup"])(
  "ALB health lag in %s does not consume another recovery or relax promotion checks",
  async (group) => {
    const f = await preparingRecoveryFixture();
    await bind(f);
    const original = f.aws.getMockImplementation();
    let initialReads = 0;
    f.aws.mockImplementation(async (service, operation, input) => {
      const result = await original(service, operation, input);
      if (
        operation === "describe-target-health" &&
        input.TargetGroupArn === f.state.ctl.deployment.routing[group] &&
        f.state.ctl.deployment.phase === "warming" &&
        result.TargetHealthDescriptions.length &&
        initialReads++ < 2
      ) {
        const waiting = structuredClone(result);
        waiting.TargetHealthDescriptions[0].TargetHealth.State = "initial";
        return waiting;
      }
      return result;
    });
    expect(
      await recoverPreparingSandbox({ ...f.options, mode: "recover" }),
    ).toMatchObject({ kind: "preparing_recovery_complete" });
    expect(initialReads).toBeGreaterThanOrEqual(3);
    expect(f.recoveryState.receipt.executionRunToken).toBe("902-1");
  },
);

test("host SDK dates and gated CLI timestamps produce the same private binding", async () => {
  const f = await preparingRecoveryFixture();
  f.carry.registered.registeredAt = "1970-01-01T00:16:40.000000+00:00";
  const cli = await bind(f);
  f.carry.registered.registeredAt = new Date("1970-01-01T00:16:40.000Z");
  const sdk = await bind(f);
  expect(sdk.bindingSha256).toBe(cli.bindingSha256);
  expect(sdk.binding.registration.registeredAt).toBe(
    "1970-01-01T00:16:40.000Z",
  );
});

test("family-prefix siblings are not read while exact-family pagination remains complete", async () => {
  const f = await preparingRecoveryFixture(),
    original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "list-task-definitions")
      return input.nextToken
        ? { taskDefinitionArns: ["definition:new"] }
        : { taskDefinitionArns: ["other-family:7"], nextToken: "own-family" };
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === "other-family:7"
    )
      throw Error("Sibling family must not be read");
    return original(service, operation, input);
  });
  expect(await bind(f)).toMatchObject({ kind: "inspection" });
});

test("registration discovery exhausts every page and rejects an additional same-operation registration", async () => {
  const f = await preparingRecoveryFixture();
  const original = f.aws.getMockImplementation();
  let ambiguous = false;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "list-task-definitions") {
      if (!input.nextToken)
        return { taskDefinitionArns: ["definition:new"], nextToken: "second" };
      return { taskDefinitionArns: ambiguous ? ["definition:foreign"] : [] };
    }
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === "definition:foreign"
    )
      return {
        taskDefinition: {
          ...f.carry.registered,
          taskDefinitionArn: "definition:foreign",
        },
      };
    return original(service, operation, input);
  });
  await bind(f);
  ambiguous = true;
  await expect(
    recoverPreparingSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(f.recoveryState.receipt).toBeUndefined();
});

test.each(["taskDefinition", "epoch", "source_epoch", "listener_ack"])(
  "late %s refusal preserves the consumed claim and never forces completion",
  async (scenario) => {
    const f = await preparingRecoveryFixture();
    await bind(f);
    if (scenario === "taskDefinition")
      f.recoveryState.afterClaim = () => {
        f.state.ctl.deployment.taskDefinition = "definition:foreign";
      };
    if (scenario === "epoch")
      f.recoveryState.afterClaim = () => {
        f.state.ctl.coordinatorEpoch++;
      };
    if (scenario === "source_epoch") f.options.sleep = async () => undefined;
    if (scenario === "listener_ack") f.traffic.unknown = true;
    await expect(
      recoverPreparingSandbox({ ...f.options, mode: "recover" }),
    ).rejects.toThrow();
    expect(f.recoveryState.receipt.executionRunToken).toBe("902-1");
    expect(f.state.ctl.deployment.phase).not.toBe("complete");
    expect(f.state.rows.old.retirementAcknowledgment).toBeUndefined();
    expectUnchangedHistory(f);
    await expect(
      recoverPreparingSandbox({ ...f.options, mode: "recover" }),
    ).rejects.toThrow();
  },
);

test.each([
  "source",
  "expiry",
  "manifest",
  "attempt",
  "account",
  "unknown_field",
])("private proof rejects changed %s", async (scenario) => {
  const f = await preparingRecoveryFixture(),
    env = { ...f.options.env };
  if (scenario === "source") env.GITHUB_SHA = "d".repeat(40);
  if (scenario === "expiry") f.proof.approveBefore = f.options.now();
  if (scenario === "manifest")
    env.CARRYFORWARD_MANIFEST_SHA256 = "d".repeat(64);
  if (scenario === "attempt") env.GITHUB_RUN_ATTEMPT = "2";
  if (scenario === "account") env.EXPECTED_ACCOUNT_ID = "000000000000";
  if (scenario === "unknown_field") f.proof.force = true;
  env.PREPARING_RECOVERY_PROOF_JSON = JSON.stringify(f.proof);
  env.PREPARING_RECOVERY_PROOF_SHA256 = bindingHash(f.proof);
  expect(() => readPreparingProof(env, f.options.now)).toThrow();
});
