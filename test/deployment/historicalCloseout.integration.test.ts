/** @jest-environment node */
import { expect, test } from "@jest/globals";
import * as production from "../../scripts/deployment/recover-production-source-loss.cjs";
import { historicalCloseoutFixture } from "./fixtures/historicalCloseoutFixture";
import { putIntroductionDocument } from "./fixtures/introductionStore";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createHandoffGate } from "../../scripts/deployment/handoff-quiet-gate.cjs";
import * as types from "../../src/types/deploymentControl";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCompatibleReplacementTransaction } from "../../src/services/deploymentControlTransactions";
import { writeIntroduction } from "./fixtures/introductionStore";
import { runtime } from "./controlFixtures";

test("historical marker is preserved without granting admission or settlement authority", async () => {
  const f = await historicalCloseoutFixture();
  try {
    await f.historicalReplacement();
    const before = await f.read("CONTROL");
    const rows = await Promise.all([
      f.read("RUNTIME#old"),
      f.readReceipt(),
      f.readLease(),
      f.readVoice(),
    ]);
    const inspection = await f.inspectCloseout();
    await f.applyCloseout();
    const closed = await f.read("CONTROL");
    expect(closed.compatibleReplacement).toEqual(before.compatibleReplacement);
    expect(closed.servingMembers).toEqual(before.servingMembers);
    expect(closed.servingGeneration).toBe(before.servingGeneration);
    expect(
      await Promise.all([
        f.read("RUNTIME#old"),
        f.readReceipt(),
        f.readLease(),
        f.readVoice(),
      ]),
    ).toEqual(rows);
    expect((await f.receipt()).evidence.historicalReplacement).toMatchObject({
      origin: "unknown",
      treatment: "preserved_non_authoritative_history",
      successorControl:
        f.packet.closeout.historicalReplacement.successorControl,
    });
    expect(inspection.bindingSha256).toBeTruthy();
    const old = await f.read("RUNTIME#new");
    old.readiness.expiresAt = f.loss.clock - 1;
    await putIntroductionDocument(f.table, old);
    const candidate = structuredClone(old);
    candidate.identity = {
      ...old.identity,
      instanceId: "replacement",
      taskArn: runtime("replacement").identity.taskArn,
    };
    candidate.sk = "RUNTIME#replacement";
    candidate.role = "candidate";
    candidate.readiness = {
      ...candidate.readiness,
      identity: candidate.identity,
      expiresAt: f.loss.clock + 100,
    };
    candidate.protection.identity = candidate.identity;
    await putIntroductionDocument(f.table, candidate);
    const input = {
      control: closed,
      candidate,
      members: [old],
      now: f.loss.clock,
    };
    const transaction = buildCompatibleReplacementTransaction(input, {
      deploymentControl: f.table,
    });
    for (const change of ["token", "membership"] as const) {
      const reused = structuredClone(input);
      if (change === "token")
        reused.control.deployment.runToken =
          closed.compatibleReplacement.runToken;
      else reused.control.servingMembers = {};
      expect(() =>
        buildCompatibleReplacementTransaction(reused, {
          deploymentControl: f.table,
        }),
      ).toThrow();
    }
    await writeIntroduction(transaction);
    expect((await f.read("CONTROL")).servingGeneration).toBe(
      closed.servingGeneration + 1,
    );
    expect((await f.read("CONTROL")).compatibleReplacement.runToken).toBe(
      closed.deployment.runToken,
    );
    await expect(writeIntroduction(transaction)).rejects.toThrow();
  } finally {
    await f.stop();
  }
});

test.each([
  "missing",
  "absent",
  "hash",
  "marker",
  "same_run",
  "generation",
  "overlap",
  "keys",
  "phase",
  "epoch",
  "members",
  "candidate",
  "maintenance",
])("historical witness refuses %s without submission", async (scenario) => {
  const f = await historicalCloseoutFixture();
  try {
    await f.historicalReplacement();
    const witness = f.packet.closeout.historicalReplacement;
    const successor = witness.successorControl;
    if (scenario === "missing") delete f.packet.closeout.historicalReplacement;
    if (scenario === "absent")
      await f.change("CONTROL", (c) => {
        delete c.compatibleReplacement;
      });
    if (scenario === "hash") witness.successorControlSha256 = "0".repeat(64);
    if (scenario === "marker")
      successor.compatibleReplacement.runToken += "foreign";
    if (scenario === "same_run")
      successor.compatibleReplacement.runToken =
        f.packet.operation.deployment.runToken;
    if (scenario === "generation")
      successor.compatibleReplacement.servingGeneration =
        successor.servingGeneration;
    if (scenario === "overlap")
      successor.compatibleReplacement.servingMembers = successor.servingMembers;
    if (scenario === "keys")
      successor.compatibleReplacement.servingMembers = {
        foreign: successor.compatibleReplacement.servingMembers.historic,
      };
    if (scenario === "phase") successor.deployment.phase = "retiring";
    if (scenario === "epoch")
      successor.coordinatorEpoch = f.packet.operation.coordinatorEpoch;
    if (scenario === "members") successor.servingMembers = {};
    if (scenario === "candidate")
      successor.deployment.candidate = successor.deployment.outgoing;
    if (scenario === "maintenance")
      successor.maintenance = {
        holdId: "hold",
        introductionId: "hold",
        revision: 1,
      };
    if (!["missing", "absent", "hash"].includes(scenario)) {
      witness.successorControlSha256 = bindingHash(successor);
      if (scenario !== "marker")
        await f.change("CONTROL", (c) => {
          c.compatibleReplacement = successor.compatibleReplacement;
        });
    }
    await f.bindControl();
    await expect(f.inspectCloseout()).rejects.toThrow();
    expect(f.activity.submissions).toBe(0);
  } finally {
    await f.stop();
  }
});

test.each(["marker", "witness", "delayed"])(
  "historical closeout fences %s changes",
  async (scenario) => {
    const f = await historicalCloseoutFixture();
    try {
      await f.historicalReplacement();
      await f.inspectCloseout();
      if (scenario === "witness") {
        f.packet.closeout.historicalReplacement.captureSha256 = "c".repeat(64);
        f.closeoutOptions.packetSha256 = bindingHash(f.packet);
      } else if (scenario === "marker") {
        f.activity.before = () =>
          f.change("CONTROL", (c) => {
            c.compatibleReplacement.runToken += "race";
          });
      } else {
        const previous = structuredClone(
          f.packet.closeout.historicalReplacement.successorControl,
        );
        previous.deployment.phase = "complete";
        const member = await f.read("RUNTIME#old");
        member.readiness.observedEpoch = previous.coordinatorEpoch;
        member.readiness.expiresAt = f.loss.clock - 1;
        const candidate = structuredClone(member);
        candidate.identity = {
          ...member.identity,
          instanceId: "delayed",
          taskArn: runtime("delayed").identity.taskArn,
        };
        candidate.sk = "RUNTIME#delayed";
        candidate.role = "candidate";
        candidate.readiness = {
          ...candidate.readiness,
          identity: candidate.identity,
          expiresAt: f.loss.clock + 100,
        };
        candidate.protection = {
          identity: candidate.identity,
          provenAt: f.loss.clock,
          expiresAt: f.loss.clock + 600,
        };
        for (const kind of Object.keys(candidate.workCounts))
          candidate.workCounts[kind] = 0;
        await putIntroductionDocument(f.table, candidate);
        const delayed = buildCompatibleReplacementTransaction(
          {
            control: previous,
            members: [member],
            candidate,
            now: f.loss.clock,
          },
          { deploymentControl: f.table },
        );
        await f.applyCloseout();
        await expect(writeIntroduction(delayed)).rejects.toHaveProperty(
          "CancellationReasons.0.Code",
          "ConditionalCheckFailed",
        );
        return;
      }
      await expect(f.applyCloseout()).rejects.toThrow();
      expect(await f.receipt()).toBeUndefined();
    } finally {
      await f.stop();
    }
  },
);

test("closeout preserves unsettled history and actual serving admission", async () => {
  const f = await historicalCloseoutFixture();
  try {
    const before = {
      control: await f.read("CONTROL"),
      old: await f.read("RUNTIME#old"),
      current: await f.read("RUNTIME#new"),
      recovery: await f.readReceipt(),
      lease: await f.readLease(),
      voice: await f.readVoice(),
    };
    const inspection = await f.inspectCloseout();
    expect(f.activity.submissions).toBe(0);
    expect(inspection.kind).toBe("inspection");
    await expect(f.applyCloseout()).resolves.toMatchObject({
      kind: "availability_handoff_closed_with_unsettled_history",
      settlement: "lost_owner_settlement_pending",
    });
    const after = await f.read("CONTROL");
    expect(after.coordinatorToken).not.toBe(before.control.coordinatorToken);
    expect(after).toEqual({
      ...before.control,
      coordinatorToken: after.coordinatorToken,
      coordinatorExpiresAt: f.loss.clock,
      deployment: {
        ...before.control.deployment,
        phase: "complete",
        updatedAt: f.loss.clock,
      },
    });
    expect(await f.read("RUNTIME#old")).toEqual(before.old);
    expect(await f.read("RUNTIME#new")).toEqual(before.current);
    expect(await f.readReceipt()).toEqual(before.recovery);
    expect(await f.readLease()).toEqual(before.lease);
    expect(await f.readVoice()).toEqual(before.voice);
    expect((await f.receipt()).sourceRuntime.workCounts.pending_admission).toBe(
      1,
    );
    expect((await f.receipt()).nativeProtection).toMatchObject({
      taskArn: f.candidateIdentity.taskArn,
    });
    expect((await f.receipt()).nativeProtection.expiresAt).toBeGreaterThan(
      f.loss.clock + 120,
    );
    await f.refreshActualRuntime();
    expect(f.lifecycle.isAcceptingWork()).toBe(true);
    const work = f.lifecycle.beginRuntimeWork("pending_admission");
    work.settle();
    expect(f.activity.submissions).toBe(1);
    expect(
      f.activity.calls.every(
        (call) =>
          call.operation === "transact-write-items" ||
          /^(get-|describe-|list-)/.test(call.operation),
      ),
    ).toBe(true);
    await expect(f.applyCloseout()).rejects.toThrow();
    expect(f.activity.submissions).toBe(1);
  } finally {
    await f.stop();
  }
});

test("a new ordinary coordinator acquires after closeout, while the historical run cannot", async () => {
  const f = await historicalCloseoutFixture();
  const next = createCoordinator({
    ...f.closeoutOptions,
    env: {
      ...f.options.env,
      SECRETS_PREFIX: "fixture-prod",
      DEPLOYMENT_RUN_TOKEN: "next-run",
    },
  });
  try {
    await expect(next.prepare()).rejects.toMatchObject({
      category: "coordinator_authority_changed",
    });
    await f.inspectCloseout();
    await f.applyCloseout();
    await f.refreshActualRuntime();
    await expect(f.normal.prepare()).rejects.toMatchObject({
      category: "coordinator_authority_changed",
    });
    const provider = f.aws.getMockImplementation();
    f.aws.mockImplementation(async (s, o, i) => {
      if (
        o === "describe-task-definition" &&
        (await f.read("CONTROL")).coordinatorToken === "next-run"
      )
        throw new Error(
          "Qualification stops after normal acquisition, before registering a replacement",
        );
      return provider(s, o, i);
    });
    await expect(next.prepare()).rejects.toMatchObject({
      category: "provider_operation_failed",
    });
    expect(await f.read("CONTROL")).toMatchObject({
      coordinatorToken: "next-run",
      coordinatorEpoch: f.packet.operation.coordinatorEpoch + 1,
      deployment: { runToken: "next-run" },
    });
  } finally {
    await f.stop();
  }
});

test.each([
  "token",
  "counter",
  "retirement",
  "candidate_busy",
  "candidate_stale",
  "protection",
  "event",
  "event_missing",
  "receipt",
  "artifact",
  "maintenance",
  "introduction",
  "actor",
  "account",
  "approval",
  "digest",
])("inspection refuses changed %s without submission", async (scenario) => {
  const f = await historicalCloseoutFixture();
  try {
    await f.historicalReplacement();
    await f.inspectCloseout();
    const changeRow = {
      token: () =>
        f.change("CONTROL", (row) => {
          row.coordinatorToken += "other";
        }),
      counter: () =>
        f.change("RUNTIME#old", (row) => {
          row.workCounts.pending_admission = 0;
        }),
      retirement: () =>
        f.change("RUNTIME#old", (row) => {
          row.retirementRequest = {};
        }),
    }[scenario];
    if (changeRow) await changeRow();
    if (scenario === "candidate_busy")
      await f.change("RUNTIME#new", (row) => {
        row.workCounts.recording = 1;
      });
    if (scenario === "candidate_stale")
      await f.change("RUNTIME#new", (row) => {
        row.readiness.expiresAt = 0;
      });
    if (scenario === "protection") f.state.protected = false;
    if (scenario === "event") f.event.message += "changed";
    if (scenario === "event_missing") f.svc.events = [];
    if (scenario === "receipt") {
      const receipt = await f.readReceipt();
      receipt.updatedAt++;
      await putIntroductionDocument(f.table, receipt);
    }
    if (scenario === "artifact")
      await f.change("ARTIFACTS#new/STATE", (row) => {
        row.startup = { kind: "pending" };
      });
    if (scenario === "maintenance")
      await f.change("CONTROL", (row) => {
        row.maintenance = {
          holdId: "held",
          introductionId: "held",
          revision: 1,
        };
      });
    if (scenario === "introduction")
      await putIntroductionDocument(f.table, {
        pk: "ENV",
        sk: "INTRODUCTION",
        deployment: { state: "held" },
      });
    if (scenario === "actor" || scenario === "account") {
      const original = f.aws.getMockImplementation();
      f.aws.mockImplementation((s, o, i) =>
        o === "get-caller-identity"
          ? { Account: "000000000000", Arn: "foreign" }
          : original(s, o, i),
      );
    }
    if (scenario === "approval") {
      f.packet.closeout.approveBefore = 1;
      f.closeoutOptions.packetSha256 = bindingHash(f.packet);
    }
    if (scenario === "digest") f.closeoutOptions.packetSha256 = "0".repeat(64);
    await expect(f.applyCloseout()).rejects.toThrow();
    expect(f.activity.submissions).toBe(0);
    expect(await f.receipt()).toBeUndefined();
  } finally {
    await f.stop();
  }
});

test.each([
  "counter",
  "introduction",
  "artifact",
  "busy",
  "publicationProtocol",
  "publicationCompatibleImages",
  "publicationPins",
  "publicationTransition",
])("atomic transaction refuses a late %s race", async (scenario) => {
  const f = await historicalCloseoutFixture();
  try {
    await f.historicalReplacement();
    await f.inspectCloseout();
    f.activity.before = async () => {
      if (scenario === "counter")
        await f.change("RUNTIME#old", (r) => {
          r.workCounts.pending_admission = 0;
        });
      else if (scenario === "introduction")
        await putIntroductionDocument(f.table, {
          pk: "ENV",
          sk: "INTRODUCTION",
          deployment: { state: "held" },
        });
      else if (scenario === "artifact")
        await f.change("ARTIFACTS#new/STATE", (r) => {
          r.startup = { kind: "pending" };
        });
      else if (scenario === "busy")
        await f.change("RUNTIME#new", (r) => {
          r.workCounts.finalization = 1;
        });
      else
        await f.change("CONTROL", (r) => {
          r[scenario] =
            scenario === "publicationProtocol"
              ? 1
              : scenario === "publicationCompatibleImages"
                ? []
                : scenario === "publicationPins"
                  ? {}
                  : { runToken: "foreign", images: [] };
        });
    };
    await expect(f.applyCloseout()).rejects.toThrow("outcome held");
    expect((await f.read("CONTROL")).deployment.phase).toBe("promoted");
    expect(await f.receipt()).toBeUndefined();
    await expect(f.applyCloseout()).rejects.toThrow();
    expect(f.activity.submissions).toBe(1);
  } finally {
    await f.stop();
  }
});

test.each(["before", "after", "unavailable", "publication_drift"])(
  "uncertain %s outcome never resubmits",
  async (scenario) => {
    const f = await historicalCloseoutFixture();
    try {
      await f.inspectCloseout();
      f.activity.beforeError = scenario === "before";
      f.activity.afterError = scenario !== "before";
      f.activity.after = async () => {
        if (scenario === "unavailable") f.activity.readError = true;
        if (scenario === "publication_drift")
          await f.change("CONTROL", (r) => {
            r.publicationProtocol = 1;
          });
      };
      if (scenario === "after")
        await expect(f.applyCloseout()).resolves.toMatchObject({
          kind: "availability_handoff_closed_with_unsettled_history",
        });
      else await expect(f.applyCloseout()).rejects.toThrow("outcome held");
      f.activity.readError = false;
      await expect(f.applyCloseout()).rejects.toThrow();
      expect(f.activity.submissions).toBe(1);
      if (scenario === "unavailable" || scenario === "after")
        await expect(f.observeCloseout()).resolves.toMatchObject({
          settlement: "lost_owner_settlement_pending",
        });
      else await expect(f.observeCloseout()).rejects.toThrow();
      expect(f.activity.submissions).toBe(1);
    } finally {
      await f.stop();
    }
  },
);

test("a delayed historical authority write cannot change the closed Control", async () => {
  const f = await historicalCloseoutFixture();
  try {
    await f.inspectCloseout();
    await f.applyCloseout();
    await expect(
      f.aws("dynamodb", "transact-write-items", {
        TransactItems: [
          {
            Update: {
              TableName: "fixture-prod-DeploymentControlTable",
              Key: marshall({ pk: "ENV", sk: "CONTROL" }),
              ConditionExpression: "coordinatorToken = :old",
              UpdateExpression: "SET coordinatorExpiresAt = :later",
              ExpressionAttributeValues: marshall({
                ":old": f.packet.operation.coordinatorToken,
                ":later": 99999,
              }),
            },
          },
        ],
      }),
    ).rejects.toThrow();
    expect((await f.read("CONTROL")).deployment.phase).toBe("complete");
  } finally {
    await f.stop();
  }
});

test("valid proof heartbeat refresh can race closeout without changing its binding", async () => {
  const f = await historicalCloseoutFixture();
  try {
    await f.inspectCloseout();
    f.activity.before = () =>
      f.change("RUNTIME#new", (row) => {
        row.heartbeatAt = f.loss.clock;
        row.readiness.expiresAt++;
        row.protection.expiresAt++;
      });
    await expect(f.applyCloseout()).resolves.toMatchObject({
      settlement: "lost_owner_settlement_pending",
    });
  } finally {
    await f.stop();
  }
});

test("a late first commit can only be observed after its original approval expires", async () => {
  const f = await historicalCloseoutFixture();
  try {
    await f.inspectCloseout();
    let delayed;
    const provider = f.aws.getMockImplementation();
    f.aws.mockImplementation((s, o, i) => {
      if (o === "transact-write-items") {
        delayed = i;
        f.activity.submissions++;
        throw new Error("Submission still in flight");
      }
      return provider(s, o, i);
    });
    await expect(f.applyCloseout()).rejects.toThrow("outcome held");
    await expect(f.applyCloseout()).rejects.toThrow();
    f.loss.clock = f.packet.closeout.approveBefore + 1;
    // The original provider request completes late, without another operator submission.
    f.activity.submissions--;
    await provider("dynamodb", "transact-write-items", delayed);
    await expect(f.observeCloseout()).resolves.toMatchObject({
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.activity.submissions).toBe(1);
  } finally {
    await f.stop();
  }
});

test.each([
  "publicationProtocol",
  "publicationCompatibleImages",
  "publicationPins",
  "publicationTransition",
])("present %s cannot disappear before atomic closeout", async (field) => {
  const f = await historicalCloseoutFixture({
    knownCompatible: true,
    publicationControl: {
      publicationProtocol: 1,
      publicationCompatibleImages: [],
      publicationPins: {},
    },
    sameRun: true,
  });
  try {
    await f.inspectCloseout();
    f.activity.before = () =>
      f.change("CONTROL", (ctl) => {
        delete ctl[field];
      });
    await expect(f.applyCloseout()).rejects.toThrow("outcome held");
    expect(await f.receipt()).toBeUndefined();
  } finally {
    await f.stop();
  }
});

test("known compatible images retain unresolved publication pins unchanged", async () => {
  const f = await historicalCloseoutFixture({
    knownCompatible: true,
    publicationControl: {
      publicationProtocol: 1,
      publicationPins: {
        synthetic: { authorities: ["unsettled"], settled: [] },
      },
    },
  });
  try {
    const before = await f.read("CONTROL");
    await f.inspectCloseout();
    await f.applyCloseout();
    expect((await f.read("CONTROL")).publicationPins).toEqual(
      before.publicationPins,
    );
    expect((await f.read("CONTROL")).publicationTransition).toBeUndefined();
  } finally {
    await f.stop();
  }
});

test("normal acquisition still waits for actual newly admitted work", async () => {
  const f = await historicalCloseoutFixture();
  try {
    await f.inspectCloseout();
    await f.applyCloseout();
    await f.refreshActualRuntime();
    const work = f.lifecycle.beginRuntimeWork("recording");
    await f.refreshActualRuntime();
    let clock = f.loss.clock;
    const gate = createHandoffGate({
      types,
      now: () => clock,
      sleep: async () => {
        clock += 1801;
      },
      control: () => f.read("CONTROL"),
      original: async () => ({ old: await f.read("RUNTIME#new") }),
      env: {},
      assertWriter: async () => {},
    });
    await expect(
      gate.acquirable(await f.read("CONTROL"), f.svc),
    ).rejects.toMatchObject({ category: "outgoing_busy" });
    work.settle();
  } finally {
    await f.stop();
  }
});

test.each(["next", "operation", "actor", "executor", "binding", "packet"])(
  "observe refuses substituted journal %s authority",
  async (kind) => {
    const f = await historicalCloseoutFixture();
    try {
      await f.inspectCloseout();
      await f.applyCloseout();
      const journal = JSON.parse(
        readFileSync(f.packet.closeout.submissionFile, "utf8"),
      );
      if (kind === "next") {
        journal.next.coordinatorToken = "foreign";
        await putIntroductionDocument(f.table, journal.next);
      }
      if (kind === "operation")
        journal.receipt.operationId = "12345678-1234-4123-8123-123456789abc";
      if (kind === "actor") journal.receipt.actorArn = "foreign";
      if (kind === "executor") journal.receipt.executorCommit = "0".repeat(40);
      if (kind === "binding") journal.receipt.bindingSha256 = "0".repeat(64);
      if (kind === "packet") journal.receipt.packetSha256 = "0".repeat(64);
      if (kind !== "next")
        await putIntroductionDocument(f.table, journal.receipt);
      writeFileSync(f.packet.closeout.submissionFile, JSON.stringify(journal));
      await expect(f.observeCloseout()).rejects.toThrow();
      expect(f.activity.submissions).toBe(1);
    } finally {
      await f.stop();
    }
  },
);

test("an unchanged unqualified recovery transition remains valid after promotion", async () => {
  const f = await historicalCloseoutFixture({
    publicationControl: { publicationProtocol: 1 },
  });
  try {
    const original = (await f.read("CONTROL")).publicationTransition;
    await f.inspectCloseout();
    await f.applyCloseout();
    expect((await f.read("CONTROL")).publicationTransition).toEqual(original);
  } finally {
    await f.stop();
  }
});

test("the guarded production entry supports lifecycle-only historical closeout", () => {
  expect(production.closeoutProduction).toEqual(expect.any(Function));
});
