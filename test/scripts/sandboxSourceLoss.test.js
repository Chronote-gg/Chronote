/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { recoverSandbox } from "../../scripts/deployment/recover-sandbox.cjs";
import { sourceLossFixture } from "../deployment/fixtures/sourceLossFixture";
const writes = (f) =>
  f.calls
    .slice(f.before)
    .filter((c) =>
      [
        "transact-write-items",
        "update-item",
        "modify-listener",
        "register-task-definition",
        "update-service",
        "stop-task",
        "update-task-protection",
      ].includes(c.operation),
    );
async function reviewed(f) {
  const result = await recoverSandbox({ ...f.options, mode: "inspect" });
  f.options.env.SOURCE_LOSS_BINDING_SHA256 = result.bindingSha256;
  return result;
}
test("inspection freezes exact source/candidate/topology and is read only", async () => {
  const f = await sourceLossFixture();
  const result = await reviewed(f);
  expect(result.kind).toBe("inspection");
  expect(result.binding.terminal.stoppedAt).toBe(
    new Date(999000).toISOString(),
  );
  expect(writes(f)).toEqual([]);
});

test("restores unchanged test billing flags without settling lost source work", async () => {
  const f = await sourceLossFixture();
  const flags = [
    { name: "STRIPE_RENEWAL_GRACE_ENABLED", value: "true" },
    { name: "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED", value: "true" },
    { name: "STRIPE_INTRO_OFFER_LEDGER_ENABLED", value: "false" },
    { name: "STRIPE_RENEWAL_REACTIVATION_ENABLED", value: "true" },
  ];
  f.loss.sourceBillingFlags.push(...structuredClone(flags));
  f.loss.candidateBillingFlags.push(...structuredClone(flags));
  f.state.rows.old.workCounts.pending_admission = 1;
  const original = structuredClone(f.state.rows.old);
  const inspection = await reviewed(f);
  expect(inspection.binding.terminal.billingFlags).toMatchObject({
    STRIPE_MODE: "test",
    STRIPE_RENEWAL_GRACE_ENABLED: "true",
    STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED: "true",
  });
  expect(await recoverSandbox({ ...f.options, mode: "recover" })).toMatchObject(
    {
      kind: "availability_restored",
      settlement: "lost_owner_settlement_pending",
    },
  );
  expect(f.state.rows.old).toEqual(original);
  expect(f.loss.receipt.settlement).toBe("lost_owner_settlement_pending");
});

test("recovery refuses billing drift after review even when both definitions agree", async () => {
  const f = await sourceLossFixture();
  const approved = await reviewed(f);
  for (const side of ["sourceBillingFlags", "candidateBillingFlags"])
    f.loss[side].push({ name: "STRIPE_RENEWAL_GRACE_ENABLED", value: "true" });
  const changed = await recoverSandbox({ ...f.options, mode: "inspect" });
  expect(changed.bindingSha256).not.toBe(approved.bindingSha256);
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toMatchObject({
    name: "AssertionError",
    code: "ERR_ASSERTION",
    actual: changed.bindingSha256,
    expected: approved.bindingSha256,
  });
  expect(writes(f)).toEqual([]);
});

test.each([
  "STRIPE_RENEWAL_GRACE_ENABLED",
  "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
  "STRIPE_RENEWAL_REACTIVATION_ENABLED",
])("refuses changed %s in either immutable definition", async (name) => {
  for (const side of ["sourceBillingFlags", "candidateBillingFlags"]) {
    const f = await sourceLossFixture();
    f.loss[side].push({ name, value: "true" });
    await expect(reviewed(f)).rejects.toThrow();
    expect(writes(f)).toEqual([]);
  }
});

test("refuses an enabled intro ledger even when unchanged", async () => {
  const f = await sourceLossFixture();
  for (const side of ["sourceBillingFlags", "candidateBillingFlags"])
    f.loss[side].push({
      name: "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
      value: "true",
    });
  await expect(reviewed(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});

test.each(["source", "candidate"])(
  "refuses duplicate or secret billing flags in the %s definition",
  async (side) => {
    for (const kind of ["duplicate", "secret"]) {
      const f = await sourceLossFixture();
      if (kind === "duplicate")
        f.loss[side + "BillingFlags"].push({
          name: "STRIPE_MODE",
          value: "test",
        });
      else {
        const original = f.aws.getMockImplementation();
        f.aws.mockImplementation(async (service, operation, input) => {
          const result = await original(service, operation, input);
          const arn = side === "source" ? "definition:old" : "definition:new";
          if (
            operation === "describe-task-definition" &&
            input.taskDefinition === arn
          )
            result.taskDefinition.containerDefinitions[0].secrets.push({
              name: "STRIPE_RENEWAL_GRACE_ENABLED",
              valueFrom: "fixture-reference",
            });
          return result;
        });
      }
      await expect(reviewed(f)).rejects.toThrow();
      expect(writes(f)).toEqual([]);
    }
  },
);

test.each(["arn", "family", "image", "live"])(
  "refuses mismatched source definition %s",
  async (kind) => {
    const f = await sourceLossFixture();
    const original = f.aws.getMockImplementation();
    f.aws.mockImplementation(async (service, operation, input) => {
      const result = await original(service, operation, input);
      if (
        operation === "describe-task-definition" &&
        input.taskDefinition === "definition:old"
      ) {
        const definition = result.taskDefinition;
        if (kind === "arn") definition.taskDefinitionArn = "foreign";
        if (kind === "family") definition.family = "foreign";
        if (kind === "image")
          definition.containerDefinitions[0].image =
            "repo@sha256:" + "c".repeat(64);
        if (kind === "live")
          definition.containerDefinitions[0].environment.find(
            (e) => e.name === "STRIPE_MODE",
          ).value = "live";
      }
      return result;
    });
    await expect(reviewed(f)).rejects.toThrow();
    expect(writes(f)).toEqual([]);
  },
);
test("same candidate restores admission before traffic and leaves settlement pending", async () => {
  const f = await sourceLossFixture();
  const original = structuredClone(f.state.rows.old);
  await reviewed(f);
  expect(await recoverSandbox({ ...f.options, mode: "recover" })).toMatchObject(
    {
      kind: "availability_restored",
      settlement: "lost_owner_settlement_pending",
    },
  );
  expect(f.state.ctl.servingGeneration).toBe(2);
  expect(f.state.ctl.servingMembers).toEqual({ new: f.candidateIdentity });
  expect(f.state.ctl.deployment.phase).toBe("promoted");
  expect(f.state.rows.old).toEqual(original);
  expect(f.loss.receipt).toMatchObject({
    stage: "availability_restored",
    settlement: "lost_owner_settlement_pending",
  });
  expect(f.loss.receipt.expiresAt).toBeUndefined();
  expect(writes(f).map((c) => c.operation)).toEqual([
    "transact-write-items",
    "transact-write-items",
    "modify-listener",
    "transact-write-items",
  ]);
  expect(f.state.rows.new.heartbeatAt).toBeGreaterThan(
    f.loss.receipt.admittedAt,
  );
  expect(await f.coordinator.prepare()).toMatchObject({
    kind: "preserved",
    phase: "promoted",
  });
});
test.each([
  "RUNNING",
  "MISSING",
  "source_target",
  "extra",
  "pending",
  "stale",
  "protection",
  "submitted",
  "revision",
  "identity",
  "generation",
  "hash",
])("refuses %s before writes", async (kind) => {
  const f = await sourceLossFixture();
  await reviewed(f);
  if (kind === "RUNNING") f.loss.sourceStatus = "RUNNING";
  if (kind === "MISSING") f.loss.missing = true;
  if (kind === "source_target") f.traffic.sourceTargets = [f.target()];
  if (kind === "extra") f.loss.extra = true;
  if (kind === "pending") f.svc.pendingCount = 1;
  if (kind === "stale") f.state.rows.new.readiness.expiresAt = 0;
  if (kind === "protection") f.state.protected = false;
  if (kind === "submitted")
    f.state.ctl.deployment.routing.state = "forward_submitted";
  if (kind === "revision") f.traffic.revisionMismatch = true;
  if (kind === "identity")
    f.state.rows.new.identity = {
      ...f.state.rows.new.identity,
      candidateId: "foreign",
    };
  if (kind === "generation") f.state.ctl.servingGeneration++;
  if (kind === "hash")
    f.options.env.SOURCE_LOSS_BINDING_SHA256 = "0".repeat(64);
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("requires candidate's own heartbeat after atomic admission before listener writes", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  f.loss.refresh = false;
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow("readiness did not refresh");
  expect(f.loss.receipt.stage).toBe("admission_transferred");
  expect(writes(f).map((c) => c.operation)).toEqual(["transact-write-items"]);
});
test("lost Dynamo acknowledgments use exact readback without repeating transaction", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  f.loss.loseAck = true;
  expect(await recoverSandbox({ ...f.options, mode: "recover" })).toMatchObject(
    { kind: "availability_restored" },
  );
  expect(
    writes(f).filter((c) => c.operation === "transact-write-items"),
  ).toHaveLength(3);
});
test("unknown listener submission stays fenced and cannot be retried", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  f.traffic.unknown = true;
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  expect(f.state.ctl.deployment.routing.state).toBe("forward_submitted");
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(1);
});
test("conditional Control race cannot be swallowed as an uncertain applied write", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  f.loss.beforeWrite = () => f.state.ctl.coordinatorEpoch++;
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow("conditional conflict");
  expect(f.loss.receipt).toBeUndefined();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(0);
});

async function expectFencedRouting(f) {
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(0);
}

test("foreign listener appearing after submitted fence is preserved, never overwritten", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  f.loss.afterWrite = (receipt) => {
    if (receipt.stage === "forward_submitted")
      f.traffic.actions = [
        { Type: "redirect", RedirectConfig: { Host: "foreign.example" } },
      ];
  };
  await expectFencedRouting(f);
});

test.each([
  "session",
  "billing_live",
  "billing_gate",
  "source_digest",
  "source_definition",
  "candidate_digest",
])("refuses %s metadata without writes", async (kind) => {
  const f = await sourceLossFixture();
  await reviewed(f);
  if (kind === "session")
    f.options.env.EXPECTED_SESSION_NAME = "chronote-sandbox-901-1";
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    if (operation === "describe-task-definition") {
      if (kind === "billing_live")
        result.taskDefinition.containerDefinitions[0].environment.find(
          (e) => e.name === "STRIPE_MODE",
        ).value = "live";
      if (
        kind === "billing_gate" &&
        input.taskDefinition === f.state.ctl.deployment.taskDefinition
      )
        result.taskDefinition.containerDefinitions[0].environment.push({
          name: "STRIPE_RENEWAL_GRACE_ENABLED",
          value: "true",
        });
    }
    if (operation === "describe-tasks") {
      if (kind === "source_digest")
        result.tasks.find(
          (t) => t.taskArn === f.oldIdentity.taskArn,
        ).containers[0].imageDigest = "sha256:" + "c".repeat(64);
      if (kind === "source_definition")
        result.tasks.find(
          (t) => t.taskArn === f.oldIdentity.taskArn,
        ).taskDefinitionArn = "foreign";
      if (kind === "candidate_digest")
        result.tasks.find(
          (t) => t.taskArn === f.candidateIdentity.taskArn,
        ).containers[0].imageDigest = "sha256:" + "c".repeat(64);
    }
    return result;
  });
  await expect(
    recoverSandbox({ ...f.options, mode: "recover" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test.each(["lost_candidate_proof", "changed_owner", "expired_authority"])(
  "post-admission %s leaves receipt and does not route",
  async (kind) => {
    const f = await sourceLossFixture();
    await reviewed(f);
    f.loss.afterWrite = (receipt) => {
      if (receipt.stage !== "admission_transferred") return;
      if (kind === "lost_candidate_proof")
        f.state.rows.new.readiness.dependenciesReady = false;
      if (kind === "changed_owner") f.state.ctl.coordinatorToken = "foreign";
      if (kind === "expired_authority") f.loss.clock += 181;
    };
    await expect(
      recoverSandbox({ ...f.options, mode: "recover" }),
    ).rejects.toThrow();
    expect(f.loss.receipt.stage).toBe("admission_transferred");
    expect(
      writes(f).filter((c) => c.operation === "modify-listener"),
    ).toHaveLength(0);
  },
);

test("slow native reads cannot outlive candidate proof immediately before routing", async () => {
  const f = await sourceLossFixture();
  await reviewed(f);
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    if (
      operation === "get-task-protection" &&
      f.loss.receipt?.stage === "forward_submitted"
    )
      f.loss.clock += 31;
    return result;
  });
  await expectFencedRouting(f);
});

test("initial Control drift cannot leave stale source metadata in the recovery receipt", async () => {
  const f = await sourceLossFixture();
  const original = f.aws.getMockImplementation();
  let first = true;
  f.aws.mockImplementation(async (service, operation, input) => {
    const response = await original(service, operation, input);
    if (first && operation === "get-item") {
      first = false;
      f.state.ctl.coordinatorEpoch++;
      f.state.rows.new.readiness.observedEpoch = f.state.ctl.coordinatorEpoch;
    }
    return response;
  });
  await expect(
    recoverSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
