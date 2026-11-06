/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import {
  productionSourceLossPacket,
  syntheticStopEventEvidence,
} from "../deployment/fixtures/productionSourceLossPacket";
import { awsCli } from "../../scripts/deployment/coordinator-aws.cjs";
jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  ...jest.requireActual("../../scripts/deployment/coordinator-aws.cjs"),
  awsCli: jest.fn(),
}));
import {
  recoverProduction,
  recoverEventProduction,
} from "../../scripts/deployment/recover-production-source-loss.cjs";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";
import { sourceLossFixture } from "../deployment/fixtures/sourceLossFixture";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

async function fixture() {
  const f = await sourceLossFixture();
  const d = f.state.ctl.deployment;
  d.phase = "promoting";
  d.candidate = f.candidateIdentity;
  d.tablePrefix = "fixture-prod-";
  const actor = {
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AccountAdministrator_fixture/operator",
  };
  const hold = { value: undefined };
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    if (service === "sts") return actor;
    if (operation === "get-item" && unmarshall(input.Key).sk === "INTRODUCTION")
      return { Item: hold.value ? marshall(hold.value) : undefined };
    const result = await original(service, operation, input);
    if (operation === "describe-task-definition") {
      result.taskDefinition.containerDefinitions[0].environment.find(
        (x) => x.name === "STRIPE_MODE",
      ).value = "live";
    }
    return result;
  });
  const packet = productionSourceLossPacket(
    f.state.ctl,
    f.candidateIdentity,
    actor,
    "a".repeat(40),
  );
  const options = { ...f.options, packet };
  return { ...f, actor, packet, options, hold };
}
const writes = (f) =>
  f.calls
    .slice(f.before)
    .filter((c) =>
      ["transact-write-items", "update-item", "modify-listener"].includes(
        c.operation,
      ),
    );
async function reviewed(f) {
  const r = await recoverProduction({ ...f.options, mode: "inspect" });
  f.options.packetSha256 = bindingHash(f.packet);
  f.options.bindingSha256 = r.bindingSha256;
  return r;
}
test("production inspection is read only and freezes the original operation", async () => {
  const f = await fixture();
  expect(await reviewed(f)).toMatchObject({ kind: "inspection" });
  expect(writes(f)).toEqual([]);
});
test("default adapter pins region and disables hidden retries", async () => {
  const f = await fixture();
  awsCli.mockRejectedValueOnce(new Error("stop after adapter check"));
  await expect(
    recoverProduction({
      ...f.options,
      aws: undefined,
      mode: "inspect",
      env: { AWS_REGION: "wrong" },
    }),
  ).rejects.toThrow("adapter check");
  expect(awsCli).toHaveBeenLastCalledWith(
    "sts",
    "get-caller-identity",
    {},
    { region: "us-east-1", maxAttempts: 1 },
  );
});
test("introduction hold refuses production before writes", async () => {
  const f = await fixture();
  f.hold.value = { deployment: { state: "held" } };
  await expect(reviewed(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("production transfers admission with preservation conditions before fenced traffic", async () => {
  const f = await fixture(),
    old = structuredClone(f.state.rows.old);
  await reviewed(f);
  const result = await recoverProduction({ ...f.options, mode: "apply" });
  expect(result).toMatchObject({
    kind: "availability_restored",
    settlement: "lost_owner_settlement_pending",
  });
  expect(f.state.ctl.servingMembers).toEqual({ new: f.candidateIdentity });
  expect(f.state.rows.old).toEqual(old);
  expect(f.loss.receipt.settlement).toBe("lost_owner_settlement_pending");
  const admission = writes(f)[0].input.TransactItems;
  expect(
    admission.filter((x) =>
      x.ConditionCheck?.Key?.sk?.S?.startsWith("ARTIFACTS#"),
    ),
  ).toHaveLength(2);
  const check = admission.find(
    (x) => x.ConditionCheck?.Key?.sk?.S === "ARTIFACTS#new/STATE",
  ).ConditionCheck;
  expect(check.ConditionExpression).toContain(
    "startup.proof.expiresAt > :artifactDeadline",
  );
  expect(
    unmarshall(check.ExpressionAttributeValues)[":artifactDeadline"],
  ).toBeGreaterThan(1000);
  expect(
    admission.some((x) => x.ConditionCheck?.Key?.sk?.S === "INTRODUCTION"),
  ).toBe(true);
  expect(writes(f).map((x) => x.operation)).toEqual([
    "transact-write-items",
    "transact-write-items",
    "modify-listener",
    "transact-write-items",
  ]);
});
test.each([
  "actor",
  "token",
  "epoch",
  "generation",
  "candidate",
  "image",
  "billing",
  "source_live",
  "source_missing",
  "artifact",
  "hash",
  "scan",
])("production refuses %s before writes", async (kind) => {
  const f = await fixture();
  await reviewed(f);
  if (kind === "actor") f.actor.Arn += "foreign";
  if (kind === "token") f.state.ctl.coordinatorToken = "foreign";
  if (kind === "epoch") f.state.ctl.coordinatorEpoch++;
  if (kind === "generation") f.state.ctl.servingGeneration++;
  if (kind === "candidate") f.state.ctl.deployment.candidate = f.oldIdentity;
  if (kind === "image")
    f.state.ctl.deployment.image = "foreign@sha256:" + "f".repeat(64);
  if (kind === "billing") f.packet.billingFlags.STRIPE_MODE = "test";
  if (kind === "source_live") f.loss.sourceStatus = "RUNNING";
  if (kind === "source_missing") f.loss.missing = true;
  if (kind === "artifact")
    f.state.artifacts.get("new").startup.proof.expiresAt = 0;
  if (kind === "hash") f.options.packetSha256 = "0".repeat(64);
  if (kind === "scan") {
    const original = f.aws.getMockImplementation();
    f.aws.mockImplementation((s, o, i) =>
      o === "scan"
        ? { Items: [], LastEvaluatedKey: { pk: { S: "more" } } }
        : original(s, o, i),
    );
  }
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("production CAS conflict preserves source and sends no traffic", async () => {
  const f = await fixture();
  await reviewed(f);
  f.loss.beforeWrite = () => f.state.ctl.coordinatorEpoch++;
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(0);
});
test("production waits for candidate-owned readiness after admission", async () => {
  const f = await fixture();
  await reviewed(f);
  f.loss.refresh = false;
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow("readiness did not refresh");
  expect(writes(f).map((c) => c.operation)).toEqual(["transact-write-items"]);
});
test("production preserves uncertain routing and refuses another execution", async () => {
  const f = await fixture();
  await reviewed(f);
  f.traffic.unknown = true;
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(1);
});

test("historical consumption stays valid after its proof expires", async () => {
  const f = await fixture(),
    source = f.state.artifacts.get("old");
  Object.assign(source.proof, { provenAt: 800, expiresAt: 860 });
  Object.assign(source.request, { requestedAt: 800, expiresAt: 1100 });
  source.consumedAt = 850;
  await reviewed(f);
  expect(
    await recoverProduction({ ...f.options, mode: "apply" }),
  ).toMatchObject({ kind: "availability_restored" });
});
test("a hold introduced after the routing fence prevents listener submission", async () => {
  const f = await fixture();
  await reviewed(f);
  f.loss.afterWrite = (receipt) => {
    if (receipt.stage === "forward_submitted")
      f.hold.value = { deployment: { state: "held" } };
  };
  await expect(
    recoverProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(0);
});

async function eventFixture() {
  const f = await fixture();
  f.loss.missing = true;
  f.state.ctl.deployment.cluster = "fixture";
  f.packet.operation.deployment.cluster = "fixture";
  f.svc.serviceArn =
    "arn:aws:ecs:us-east-1:123456789012:service/fixture/service";
  f.svc.clusterArn = "arn:aws:ecs:us-east-1:123456789012:cluster/fixture";
  const event = {
    id: "stop-old",
    createdAt: new Date(900000).toISOString(),
    message: "(service service) has stopped 1 running tasks: (task old).",
  };
  f.svc.events = [event];
  f.packet.eventEvidence = syntheticStopEventEvidence(f.svc, event);
  f.options.packet = f.packet;
  return { ...f, event };
}
async function reviewedEvent(f) {
  const r = await recoverEventProduction({ ...f.options, mode: "inspect" });
  f.options.packetSha256 = bindingHash(f.packet);
  f.options.bindingSha256 = r.bindingSha256;
  return r;
}
test("event evidence restores availability without invented task stop fields", async () => {
  const f = await eventFixture();
  const old = structuredClone(f.state.rows.old);
  await reviewedEvent(f);
  expect(
    await recoverEventProduction({ ...f.options, mode: "apply" }),
  ).toMatchObject({
    kind: "availability_restored",
    settlement: "lost_owner_settlement_pending",
  });
  expect(f.loss.receipt).toMatchObject({
    version: 3,
    terminalProof: {
      kind: "ecs_service_stop_event",
      eventId: "stop-old",
      nativeObservation: "MISSING",
    },
  });
  expect(f.loss.receipt).not.toHaveProperty("stoppedAt");
  expect(f.loss.receipt.terminalProof).not.toHaveProperty("exitCode");
  expect(f.state.rows.old).toEqual(old);
});
test("event evidence rejects changed provider event body before any write", async () => {
  const f = await eventFixture();
  f.event.message += " changed";
  await expect(reviewedEvent(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("normal entry does not accept an event packet", async () => {
  const f = await eventFixture();
  await expect(
    recoverProduction({ ...f.options, mode: "inspect" }),
  ).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
function eventMessage(f, message) {
  f.event.message = message;
  f.packet.eventEvidence.eventBodySha256 = bindingHash({
    serviceArn: f.svc.serviceArn,
    clusterArn: f.svc.clusterArn,
    ...f.event,
  });
}
test.each([
  [
    "missing_event",
    (f) => {
      f.svc.events = [];
    },
  ],
  [
    "wrong_service",
    (f) => {
      f.svc.serviceArn += "foreign";
    },
  ],
  [
    "wrong_cluster",
    (f) => {
      f.svc.clusterArn += "foreign";
    },
  ],
  [
    "wrong_source_event",
    (f) =>
      eventMessage(
        f,
        "(service service) has stopped 1 running tasks: (task foreign).",
      ),
  ],
  [
    "unhealthy_event",
    (f) => eventMessage(f, "(service service) (task old) is unhealthy."),
  ],
  [
    "source_running",
    (f) => {
      f.loss.missing = false;
      f.loss.sourceStatus = "RUNNING";
    },
  ],
  [
    "source_stopped",
    (f) => {
      f.loss.missing = false;
    },
  ],
  [
    "generation",
    (f) => {
      f.state.ctl.servingGeneration++;
    },
  ],
  [
    "stale_candidate",
    (f) => {
      f.state.rows.new.readiness.expiresAt = 0;
    },
  ],
  [
    "protection",
    (f) => {
      f.state.protected = false;
    },
  ],
  [
    "preservation",
    (f) => {
      f.state.artifacts.get("new").startup.proof.expiresAt = 0;
    },
  ],
  [
    "hold",
    (f) => {
      f.hold.value = { deployment: { state: "held" } };
    },
  ],
])("event path refuses %s before writes", async (_name, change) => {
  const f = await eventFixture();
  change(f);
  await expect(reviewedEvent(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("event path rejects a denied source lookup rather than treating it as MISSING", async () => {
  const f = await eventFixture(),
    original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (s, o, i) => {
    const r = await original(s, o, i);
    if (o === "describe-tasks") r.failures[0].reason = "ACCESS_DENIED";
    return r;
  });
  await expect(reviewedEvent(f)).rejects.toThrow();
  expect(writes(f)).toEqual([]);
});
test("event path preserves uncertain listener receipt and never replays", async () => {
  const f = await eventFixture();
  await reviewedEvent(f);
  f.traffic.unknown = true;
  await expect(
    recoverEventProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(f.loss.receipt.stage).toBe("forward_submitted");
  await expect(
    recoverEventProduction({ ...f.options, mode: "apply" }),
  ).rejects.toThrow();
  expect(
    writes(f).filter((c) => c.operation === "modify-listener"),
  ).toHaveLength(1);
});
