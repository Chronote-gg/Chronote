/** @jest-environment node */
import type {
  GetItemCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type {
  DescribeTasksCommandOutput,
  DescribeTaskDefinitionCommandInput,
  UpdateServiceCommandInput,
} from "@aws-sdk/client-ecs";
import type { NativeAttributeValue } from "@aws-sdk/util-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  fixture as base,
  env as baseEnv,
  oldIdentity,
  candidateIdentity,
} from "../deployment/fixtures/coordinatorFixture";
import {
  fixture as manifestFixture,
  bound,
} from "../fixtures/productionManifest.js";
import {
  createCoordinator,
  candidateDefinition,
} from "../../scripts/deployment/coordinator.cjs";
import { createProductionCoordinator } from "../../scripts/deployment/production-coordinator.cjs";
import { authorityFor } from "../../scripts/deployment/introduction-hold.cjs";
import * as builders from "../../src/services/productionIntroductionTransactions";
import * as coordinatorBuilders from "../../src/services/productionCoordinatorTransactions";
function strictFixture(
  editManifest: (manifest: ReturnType<typeof manifestFixture>) => void = () =>
    undefined,
) {
  const f = base(),
    m = manifestFixture();
  Object.assign(m.runtime, {
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/fixture",
    serviceArn: "arn:aws:ecs:us-east-1:123456789012:service/fixture/service",
    family: "family",
    container: "fixture",
    legacyDefinition:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/family:1",
    candidateDefinition:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/family:2",
    continuationDefinition:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/family:3",
    legacyTaskArns: ["arn:aws:ecs:us-east-1:123456789012:task/fixture/legacy"],
    candidateId: oldIdentity.candidateId,
    candidateDigest: oldIdentity.imageDigest,
    continuationDigest: candidateIdentity.imageDigest,
  });
  Object.assign(m.handoff, {
    runToken: "run-2",
    priorRunToken: "previous",
    candidateId: "run-2",
    priorCandidateId: oldIdentity.candidateId,
  });
  m.resources.tables.deploymentControl = "fixture-DeploymentControlTable";
  const steps = [
    ["acquire", "none", "preparing", 1, 1],
    ["phase", "preparing", "preparing", 2, 1],
    ["phase", "preparing", "warming", 2, 1],
    ["launch", "warming", "warming", 2, 1],
    ["renew", "warming", "warming", 2, 1],
    ["phase", "warming", "promoting", 2, 1],
    ["promote", "promoting", "promoting", 2, 1],
    ["phase", "promoting", "promoted", 2, 2],
  ];
  m.actions = steps.map(
    ([purpose, fromPhase, toPhase, epoch, generation], sequence) => ({
      actionId: `c${sequence}`,
      kind: "coordinator_write",
      predecessor: sequence === 5 ? "c3" : sequence ? `c${sequence - 1}` : null,
      sequence,
      purpose,
      fromPhase,
      toPhase,
      epoch,
      generation,
    }),
  );
  m.validUntil = 5000;
  editManifest(m);
  const binding = bound(m);
  const authority = authorityFor(binding);
  const hold = {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    admission: { state: "held" },
    deployment: { state: "held" },
  };
  Object.assign(f.state.ctl, {
    maintenance: {
      holdId: m.holdId,
      introductionId: m.introductionId,
      revision: 1,
    },
  });
  const fixtureAuthority = {
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: "FIXTURE_COORDINATOR",
    recordType: "fixture_coordinator_authority",
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    runToken: "run-2",
    priorRunToken: "previous",
    priorEpoch: 1,
    priorGeneration: 1,
    priorMember: oldIdentity,
    candidateId: "run-2",
    taskDefinition: m.runtime.continuationDefinition,
    imageDigest: m.runtime.continuationDigest,
  };
  const rows = new Map<string, Record<string, NativeAttributeValue>>([
    ["INTRODUCTION", hold],
    [authority.sk, authority],
    ["FIXTURE_COORDINATOR", fixtureAuthority],
  ]);
  Object.assign(f.definition, {
    taskDefinitionArn: m.runtime.candidateDefinition,
    family: "family",
  });
  Object.assign(f.svc, {
    taskDefinition: m.runtime.candidateDefinition,
    serviceArn: m.runtime.serviceArn,
  });
  const env = {
    ...baseEnv,
    ECS_CLUSTER: m.runtime.clusterArn,
    ECS_SERVICE: m.runtime.serviceArn,
  };
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, raw) => {
    const input = raw as GetItemCommandInput &
      DescribeTaskDefinitionCommandInput;
    if (operation === "get-item" && rows.has(input.Key!.sk.S!))
      return { Item: marshall(rows.get(input.Key!.sk.S!)!) };
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === m.runtime.continuationDefinition
    )
      return {
        taskDefinition: {
          ...candidateDefinition(f.definition, {
            tablePrefix: "fixture-",
            image: env.CANDIDATE_IMAGE,
            candidateId: "run-2",
          }),
          taskDefinitionArn: m.runtime.continuationDefinition,
        },
      };
    if (operation === "describe-tasks") {
      const result = (await original(
        service,
        operation,
        input,
      )) as DescribeTasksCommandOutput;
      for (const task of result.tasks!)
        task.taskDefinitionArn =
          task.taskArn === oldIdentity.taskArn
            ? m.runtime.candidateDefinition
            : m.runtime.continuationDefinition;
      return result;
    }
    return original(service, operation, input);
  });
  const read = async (key: { pk: string; sk: string }) =>
    key.sk === "CONTROL"
      ? unmarshall(marshall(f.state.ctl))
      : (rows.get(key.sk) ?? f.state.rows[key.sk.slice(8)]);
  const write = async (tx: TransactWriteItemsCommandInput) => {
    for (const item of tx.TransactItems!)
      if (item.Put) {
        const next = unmarshall(item.Put.Item),
          prior = rows.get(next.sk);
        if (prior && next.version !== prior.version + 1)
          throw Error("conditional");
        rows.set(next.sk, next);
      }
    return {};
  };
  const invoke = async (
    operation: string,
    input: TransactWriteItemsCommandInput & UpdateServiceCommandInput,
  ) => {
    if (operation === "updateService") {
      await f.aws("ecs", "update-service", input);
      return {
        service: {
          serviceArn: m.runtime.serviceArn,
          taskDefinition: m.runtime.continuationDefinition,
          desiredCount: 1,
        },
      };
    }
    if (operation === "transactWriteItems") {
      const update = input.TransactItems![0].Update;
      if (update?.ExpressionAttributeNames?.["#n0"]) {
        const values = unmarshall(update.ExpressionAttributeValues!);
        for (let i = 0; i < 4; i++)
          Object.assign(f.state.ctl, {
            [update.ExpressionAttributeNames![`#n${i}`]]: values[`:n${i}`],
          });
        return {};
      }
      return f.aws("dynamodb", "transact-write-items", input);
    }
    throw Error("unexpected");
  };
  const productionOptions = {
    binding,
    builders,
    coordinatorBuilders,
    table: m.resources.tables.deploymentControl,
    read,
    write,
    invoke,
    now: f.options.now,
    readService: async () => ({
      ...f.svc,
      deploymentConfiguration: {
        ...f.svc.deploymentConfiguration,
        earlySuccessCriteria: {
          enable: true,
          healthyPercent: 100,
          sourceServiceRevisionCleanup: "DEFERRED",
        },
      },
    }),
  };
  const coordinator = () =>
    createCoordinator({
      ...f.options,
      env,
      production: createProductionCoordinator(productionOptions),
    });
  return { ...f, rows, coordinator, productionOptions, env };
}
test("strict real coordinator retains lost UpdateService acknowledgment despite matching service read and refuses restart/promote", async () => {
  const f = strictFixture();
  f.state.loseUpdateResponse = true;
  await expect(f.coordinator().prepare()).rejects.toThrow();
  expect(f.state.launched).toBe(true);
  expect(f.rows.get("ACTION#c3")).toMatchObject({ phase: "submitted" });
  const before = f.calls.length;
  await expect(f.coordinator().prepare()).rejects.toThrow();
  await expect(f.coordinator().promote()).rejects.toThrow();
  expect(
    f.calls
      .slice(before)
      .some((c) =>
        ["update-service", "transact-write-items"].includes(c.operation),
      ),
  ).toBe(false);
});
test("strict real coordinator retains a lost conditional promotion acknowledgment across restart", async () => {
  const f = strictFixture();
  await f.coordinator().prepare();
  f.state.losePromotionResponse = true;
  await expect(f.coordinator().promote()).rejects.toThrow();
  expect(f.state.ctl.servingGeneration).toBe(2);
  expect(f.rows.get("ACTION#c6")).toMatchObject({ phase: "submitted" });
  await expect(f.coordinator().promote()).rejects.toThrow();
  await expect(f.coordinator().reconcile()).rejects.toThrow();
});

import { configuration } from "../../scripts/deployment/coordinator-definition.cjs";
import { createCoordinatorJournal } from "../../scripts/deployment/introduction-transitions.cjs";
test("unused optional earlier slot does not block exact next phase, but exhausted renewal capacity refuses", async () => {
  const f = strictFixture((m) => {
    m.actions.splice(1, 0, {
      ...m.actions[4],
      actionId: "optional",
      predecessor: "c0",
      fromPhase: "preparing",
      toPhase: "preparing",
    });
    m.actions.forEach(
      (a: { sequence: number }, index: number) => (a.sequence = index),
    );
  });
  await f.coordinator().prepare();
  expect(f.rows.has("ACTION#optional")).toBe(false);
  const api = createProductionCoordinator(f.productionOptions),
    config = configuration(f.env);
  await api.guard(f.state.ctl, config);
  await api.save(f.state.ctl, { ...f.state.ctl, coordinatorExpiresAt: 1100 });
  expect(f.rows.get("ACTION#c4")).toMatchObject({ phase: "observed" });
  await expect(
    api.save(f.state.ctl, { ...f.state.ctl, coordinatorExpiresAt: 1120 }),
  ).rejects.toThrow();
});
test("reserved exact action can resume, but prevents a different later action and wrong phase/epoch/generation", async () => {
  const f = strictFixture();
  await f.coordinator().prepare();
  const api = createProductionCoordinator(f.productionOptions),
    config = configuration(f.env);
  await api.guard(f.state.ctl, config);
  const ctl = unmarshall(marshall(f.state.ctl)),
    next = { ...ctl, coordinatorExpiresAt: 1100 };
  const journal = createCoordinatorJournal({
    ...f.productionOptions,
    hold: builders.introductionHoldSchema.parse(f.rows.get("INTRODUCTION")),
    authority: builders.introductionAuthoritySchema.parse(
      f.rows.get("OPERATION#op"),
    ),
  });
  await journal.reserveAction("c4", { control: ctl, next });
  await expect(
    api.save(ctl, {
      ...ctl,
      deployment: { ...ctl.deployment, phase: "promoting" },
    }),
  ).rejects.toThrow();
  for (const change of [
    { coordinatorEpoch: 99 },
    { servingGeneration: 99 },
    { deployment: { ...ctl.deployment, phase: "retiring" } },
  ])
    await expect(api.save({ ...ctl, ...change }, next)).rejects.toThrow();
  await api.save(ctl, next);
  expect(f.rows.get("ACTION#c4")).toMatchObject({ phase: "observed" });
});

test("missing earlier mandatory receipt refuses later phase despite matching current Control", async () => {
  const f = strictFixture();
  await f.coordinator().prepare();
  f.rows.delete("ACTION#c1");
  const api = createProductionCoordinator(f.productionOptions);
  await api.guard(f.state.ctl, configuration(f.env));
  await expect(
    api.save(f.state.ctl, {
      ...f.state.ctl,
      deployment: { ...f.state.ctl.deployment, phase: "promoting" },
    }),
  ).rejects.toThrow();
  expect(f.rows.has("ACTION#c5")).toBe(false);
});
