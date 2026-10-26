/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { carryforwardFixture } from "../deployment/fixtures/carryforwardFixture";
import { carryforwardSandbox } from "../../scripts/deployment/carryforward-sandbox.cjs";
import { bindingHash } from "../../scripts/deployment/binding-hash.cjs";
import { controlAuthority } from "../../scripts/deployment/carryforward-state.cjs";
const writes = (f) =>
  f.calls
    .slice(f.before)
    .filter((c) =>
      [
        "update-item",
        "transact-write-items",
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(c.operation),
    );
async function bind(f) {
  const result = await carryforwardSandbox({ ...f.options, mode: "inspect" });
  f.options.env.CARRYFORWARD_BINDING_SHA256 = result.bindingSha256;
  return result;
}
test("carryforward inspection is metadata-only and binds original recovery and exact reviewed template", async () => {
  const f = carryforwardFixture();
  expect(await bind(f)).toMatchObject({
    kind: "inspection",
    binding: {
      kind: "sandbox_historical_carryforward",
      source: f.oldIdentity,
      preparedDefinitionSha256: f.manifest.preparedDefinitionSha256,
    },
  });
  expect(writes(f)).toEqual([]);
});

test("the current native source revision must match the original acknowledged candidate", async () => {
  const f = carryforwardFixture();
  f.state.ctl.deployment.routing.candidateRevision = "foreign-revision";
  f.manifest.controlSha256 = bindingHash(controlAuthority(f.state.ctl));
  f.bind();
  await expect(bind(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test.each([false, true])(
  "one-use archive hands off to normal genuine source retirement, including lost claim acknowledgment=%s",
  async (loseAck) => {
    const f = carryforwardFixture();
    await bind(f);
    f.carry.loseAck = loseAck;
    const oldLoss = structuredClone(f.carry.recovery),
      lostRuntime = structuredClone(f.carry.historical);
    expect(
      await carryforwardSandbox({ ...f.options, mode: "carryforward" }),
    ).toMatchObject({
      kind: "carryforward_complete",
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.state.ctl.deployment.phase).toBe("complete");
    expect(f.state.ctl.deployment.outgoing).toEqual(f.oldIdentity);
    expect(
      f.state.rows.old.retirementAcknowledgment.request.coordinatorToken,
    ).toBe("901-1");
    expect(f.carry.recovery).toEqual(oldLoss);
    expect(f.carry.historical).toEqual(lostRuntime);
    expect(f.carry.archive.originalControl.deployment.phase).toBe("promoted");
    const before = writes(f).length;
    await expect(
      carryforwardSandbox({ ...f.options, mode: "carryforward" }),
    ).rejects.toThrow();
    expect(writes(f)).toHaveLength(before);
  },
);
function invalidateLateProof(f, scenario) {
  if (scenario === "readiness")
    f.state.rows.new.readiness.dependenciesReady = false;
  if (scenario === "protection") f.state.protected = false;
  if (scenario === "outgoing_protection") f.carry.sourceProtectionLost = true;
  if (scenario === "foreign_listener") f.traffic.actions = [];
  if (scenario === "foreign_identity") {
    const identity = {
      ...f.state.rows.new.identity,
      instanceId: "foreign",
      taskArn: f.candidateIdentity.taskArn + "-foreign",
    };
    Object.assign(f.state.rows.new, { identity, role: "candidate" });
    f.state.rows.new.readiness.identity = identity;
    f.state.rows.new.protection.identity = identity;
  }
  if (scenario === "coordinator_expiry") {
    f.carry.advance(f.state.ctl.coordinatorExpiresAt - f.options.now() + 1);
    for (const row of Object.values(f.state.rows)) {
      row.heartbeatAt = f.options.now();
      row.readiness.provenAt = f.options.now();
      row.readiness.expiresAt = f.options.now() + 30;
      row.protection.expiresAt = f.options.now() + 600;
    }
  }
}

test.each([
  "receipt",
  "control",
  "template",
  "competing",
  "pending",
  "binding",
])("changed %s refuses before claim and service mutation", async (scenario) => {
  const f = carryforwardFixture();
  await bind(f);
  if (scenario === "receipt") f.carry.recovery.updatedAt++;
  if (scenario === "control") f.state.ctl.coordinatorEpoch++;
  if (scenario === "template")
    f.carry.template.volumes.push({ name: "unreviewed" });
  if (scenario === "competing")
    f.options.writerInventory.assertExclusive.mockRejectedValue(
      new Error("competing writer"),
    );
  if (scenario === "pending") f.svc.pendingCount = 1;
  if (scenario === "binding")
    f.options.env.CARRYFORWARD_BINDING_SHA256 = "0".repeat(64);
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
  expect(f.carry.archive).toBeUndefined();
});
test("a slow final writer read cannot outlive native protection before the atomic handoff", async () => {
  const f = carryforwardFixture();
  await bind(f);
  let reads = 0;
  f.options.writerInventory.assertExclusive.mockImplementation(async () => {
    if (++reads === 3) f.carry.advance(1000);
    return { competing: 0 };
  });
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow("Native protection expired");
  expect(writes(f)).toEqual([]);
});
test("unknown listener acknowledgment preserves the submitted fence and forbids a second invocation", async () => {
  const f = carryforwardFixture();
  await bind(f);
  f.traffic.unknown = true;
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow();
  expect(f.state.ctl.deployment.routing.state).toBe("forward_submitted");
  expect(f.state.rows.old.retirementAcknowledgment).toBeUndefined();
  expect(f.carry.recovery.settlement).toBe("lost_owner_settlement_pending");
  const submitted = f.calls.filter(
    (c) => c.operation === "modify-listener",
  ).length;
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow();
  expect(f.calls.filter((c) => c.operation === "modify-listener")).toHaveLength(
    submitted,
  );
});
test.each(["before_read", "during_protection_read"])(
  "ongoing source work is retained until its genuine acknowledgment %s",
  async (acknowledgment) => {
    const f = carryforwardFixture();
    await bind(f);
    f.state.rows.old.workCounts.recording = 1;
    f.state.retirementAcknowledged = false;
    let observedBusy = false;
    f.state.onSleep = () => {
      if (!f.state.rows.old.retirementRequest || observedBusy) return;
      expect(f.state.ctl.deployment.routing.state).toBe("candidate");
      expect(f.state.rows.old.retirementAcknowledgment).toBeUndefined();
      expect(f.state.rows.old.workCounts.recording).toBe(1);
      observedBusy = true;
      f.state.rows.old.workCounts.recording = 0;
      const acknowledge = () => {
        f.state.rows.old.role = "retired";
        f.state.rows.old.retirementAcknowledgment = {
          request: f.state.rows.old.retirementRequest,
          retiredAt: f.options.now(),
        };
      };
      if (acknowledgment === "before_read") acknowledge();
      else {
        f.state.rows.old.role = "draining";
        f.state.rows.old.readiness.dependenciesReady = false;
        f.carry.sourceProtectionLost = true;
        f.carry.sourceProtectionRead = acknowledge;
      }
    };
    expect(
      await carryforwardSandbox({ ...f.options, mode: "carryforward" }),
    ).toMatchObject({ kind: "carryforward_complete" });
    expect(observedBusy).toBe(true);
  },
);
test("loss of the exclusive writer window after claim preserves archive and prevents service mutation", async () => {
  const f = carryforwardFixture();
  await bind(f);
  f.carry.afterClaim = () =>
    f.options.writerInventory.assertExclusive.mockRejectedValue(
      new Error("competing operation"),
    );
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow();
  expect(f.carry.archive).toBeDefined();
  expect(f.state.ctl.deployment.phase).toBe("preparing");
  expect(
    f.calls.some((c) =>
      [
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(c.operation),
    ),
  ).toBe(false);
});
test.each([
  "readiness",
  "protection",
  "foreign_listener",
  "foreign_identity",
  "coordinator_expiry",
  "outgoing_protection",
])(
  "late %s loss during writer inventory cannot reach listener mutation",
  async (scenario) => {
    const f = carryforwardFixture();
    await bind(f);
    let injected = false;
    f.options.writerInventory.assertExclusive.mockImplementation(async () => {
      if (
        !injected &&
        f.state.ctl.deployment.routing.state === "forward_submitted"
      ) {
        injected = true;
        invalidateLateProof(f, scenario);
      }
      return { competing: 0 };
    });
    await expect(
      carryforwardSandbox({ ...f.options, mode: "carryforward" }),
    ).rejects.toThrow();
    expect(injected).toBe(true);
    expect(
      f.calls.filter((c) => c.operation === "modify-listener"),
    ).toHaveLength(0);
    expect(f.state.ctl.deployment.routing.state).toBe("forward_submitted");
  },
);

test("the outgoing source stays protected during retirement while it still has work", async () => {
  const f = carryforwardFixture();
  await bind(f);
  f.state.rows.old.workCounts.recording = 1;
  f.state.retirementAcknowledged = false;
  let submitted;
  f.options.writerInventory.assertExclusive.mockImplementation(async () => {
    if (submitted !== undefined) throw new Error("bounded regression check");
    if (f.state.ctl.deployment.phase === "retiring") {
      submitted = writes(f).length;
      f.carry.sourceProtectionLost = true;
    }
    return { competing: 0 };
  });
  await expect(
    carryforwardSandbox({ ...f.options, mode: "carryforward" }),
  ).rejects.toThrow();
  expect(submitted).toBeDefined();
  expect(writes(f)).toHaveLength(submitted);
  expect(f.state.rows.old.workCounts.recording).toBe(1);
  expect(f.state.rows.old.retirementAcknowledgment).toBeUndefined();
});

test.each(["valid", "foreign_request", "work_remaining", "incomplete_counts"])(
  "released source protection requires truthful retired acknowledgment: %s",
  async (scenario) => {
    const f = carryforwardFixture();
    await bind(f);
    f.options.writerInventory.assertExclusive.mockImplementation(async () => {
      if (f.state.rows.old.retirementAcknowledgment) {
        f.carry.sourceProtectionLost = true;
        if (scenario === "foreign_request")
          f.state.rows.old.retirementAcknowledgment.request = {
            ...f.state.rows.old.retirementRequest,
            coordinatorToken: "foreign",
          };
        if (scenario === "work_remaining")
          f.state.rows.old.workCounts.recording = 1;
        if (scenario === "incomplete_counts") f.state.rows.old.workCounts = {};
      }
      return { competing: 0 };
    });
    const execute = carryforwardSandbox({ ...f.options, mode: "carryforward" });
    if (scenario === "valid")
      expect(await execute).toMatchObject({ kind: "carryforward_complete" });
    else {
      await expect(execute).rejects.toThrow();
      expect(f.state.ctl.deployment.phase).toBe("retiring");
    }
    expect(f.carry.sourceProtectionLost).toBe(true);
  },
);
test("the actual OIDC session must belong to the execution run, not only an independently named valid session", async () => {
  const f = carryforwardFixture();
  f.options.env.GITHUB_RUN_ID = "902";
  await expect(
    carryforwardSandbox({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
