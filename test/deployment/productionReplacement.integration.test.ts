import {
  createIntroductionTable,
  readIntroductionDocument,
} from "./fixtures/introductionStore";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../src/services/productionIntroductionTransactions";
import { fixture, bound } from "../fixtures/productionManifest.js";
import { createIntroductionHold } from "../../scripts/deployment/introduction-hold.cjs";
import { runtime, control as sample } from "./controlFixtures";
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  maxAttempts: 1,
});
afterAll(() => client.destroy());
test.each(["normal", "replacement"])(
  "native %s bootstrap promotion binds actual fixture prior epoch and token",
  async (path) => {
    const table = "task5-" + randomUUID();
    await createIntroductionTable(table);
    try {
      const m = fixture();
      m.validUntil = 5000;
      m.resources.tables.deploymentControl = table;
      const replacement = {
        candidateId: "repair",
        taskDefinition: m.runtime.candidateDefinition.replace(":2", ":4"),
        imageDigest: "sha256:" + "9".repeat(64),
        runToken: "repair-run",
        expectedEpoch: 1 as const,
        epoch: 2 as const,
      };
      const binding = bound({ ...m, failedUnserved: replacement });
      const write = (
        input: Parameters<
          typeof builders.buildAcquireIntroductionHold
        >[0] extends never
          ? never
          : import("@aws-sdk/client-dynamodb").TransactWriteItemsCommandInput,
      ) => client.send(new TransactWriteItemsCommand(input));
      const put = (value: object) =>
        client.send(
          new PutItemCommand({ TableName: table, Item: marshall(value) }),
        );
      const read = (key: object) => readIntroductionDocument(table, key);
      const { hold, authority } = await createIntroductionHold({
        builders,
        table,
        write,
        read,
        now: () => 150,
      }).acquire(binding);
      let control = {
        ...sample,
        coordinatorToken: m.handoff.priorRunToken,
        coordinatorEpoch: 1,
        coordinatorExpiresAt: 149,
        servingGeneration: 0,
        servingMembers: {},
        maintenance: {
          holdId: hold.holdId,
          introductionId: hold.introductionId,
          revision: hold.revision,
        },
      };
      await put(control);
      const launch: builders.IntroductionAction = {
        pk: `INTRODUCTION#${m.introductionId}`,
        sk: "ACTION#launch",
        recordType: "introduction_action",
        holdId: m.holdId,
        introductionId: m.introductionId,
        manifestHash: binding.manifestHash,
        operationId: m.operationId,
        revision: 1,
        actor: binding.actor,
        runToken: authority.runToken,
        actionId: "launch",
        kind: "launch_candidate",
        intentHash: authority.actions.launch.intentHash,
        requestHash: "1".repeat(64),
        predecessor: null,
        reservedAt: 100,
        phase: "observed",
        version: 4,
        attemptId: randomUUID(),
        submittedAt: 101,
        acknowledgedAt: 102,
        observedAt: 103,
        acknowledgment: {
          resourceIds: [m.runtime.serviceArn, m.runtime.candidateDefinition],
          evidenceHash: "2".repeat(64),
        },
        observation: {
          resourceIds: [
            m.runtime.clusterArn.replace("cluster/", "task/") + "/first",
          ],
          evidenceHash: "3".repeat(64),
        },
      };
      await put(launch);
      if (path === "replacement") {
        const args = {
          hold,
          authority,
          previous: control,
          launch,
          now: 150,
          tables: { deploymentControl: table },
        };
        expect(() =>
          builders.buildReplaceUnservedControl({
            ...args,
            previous: { ...control, coordinatorExpiresAt: 151 },
          }),
        ).toThrow();
        expect(() =>
          builders.buildReplaceUnservedControl({
            ...args,
            launch: {
              ...launch,
              phase: "submitted",
              version: 2,
            } as builders.IntroductionAction,
          }),
        ).toThrow();
        const tx = builders.buildReplaceUnservedControl(args);
        await write(tx);
        await expect(write(tx)).rejects.toThrow();
        control = builders.controlRecordSchema.parse(
          await read({ pk: "ENV", sk: "CONTROL" }),
        );
      } else {
        control.coordinatorExpiresAt = 330;
        await put(control);
      }
      const prior = builders.bootstrapAuthority(
        authority,
        control.coordinatorEpoch,
      );
      const row = runtime("ready", "candidate");
      row.identity = {
        ...row.identity,
        candidateId: prior.candidateId,
        imageDigest: prior.imageDigest,
      };
      row.authorizedGeneration = 0;
      row.readiness = {
        ...row.readiness,
        identity: row.identity,
        observedEpoch: control.coordinatorEpoch,
        observedGeneration: 0,
        expiresAt: 500,
      };
      row.protection = {
        ...row.protection,
        identity: row.identity,
        expiresAt: 500,
      };
      await put(row);
      const promotion = {
        coordinatorToken: control.coordinatorToken,
        coordinatorEpoch: control.coordinatorEpoch,
        expectedServingGeneration: 0,
        expectedServingMembers: [],
        proposedGeneration: 1,
        candidate: row.identity,
        candidateRuntimeMode: "all" as const,
        now: 150,
      };
      await write(
        builders.buildIntroductionPromotion({
          hold,
          authority,
          promotion,
          tables: {
            deploymentControl: table,
            meetingHistory: "unused-" + table,
          },
        }),
      );
      const observed = builders.controlRecordSchema.parse(
        await read({ pk: "ENV", sk: "CONTROL" }),
      );
      expect(observed.coordinatorExpiresAt).toBe(0);
      expect(observed.servingGeneration).toBe(1);
      const h = builders.effectiveHandoff(authority, observed.coordinatorEpoch);
      const operation = {
        pk: `INTRODUCTION#${m.introductionId}`,
        sk: "FIXTURE_COORDINATOR" as const,
        recordType: "fixture_coordinator_authority" as const,
        holdId: hold.holdId,
        introductionId: hold.introductionId,
        manifestHash: hold.manifestHash,
        revision: hold.revision,
        runToken: h.runToken,
        priorRunToken: h.priorRunToken,
        priorEpoch: h.priorEpoch,
        priorGeneration: 1 as const,
        priorMember: row.identity,
        candidateId: h.candidateId,
        taskDefinition: h.taskDefinition,
        imageDigest: h.imageDigest,
      };
      await write(
        builders.buildAuthorizeFixtureCoordinator({
          hold,
          authority,
          expectedControl: observed,
          operation,
          tables: { deploymentControl: table },
        }),
      );
      expect(
        (await read({ pk: operation.pk, sk: operation.sk }))?.priorRunToken,
      ).toBe(
        path === "replacement" ? replacement.runToken : m.handoff.priorRunToken,
      );
      if (path === "replacement")
        expect(() =>
          builders.buildAuthorizeFixtureCoordinator({
            hold,
            authority,
            expectedControl: observed,
            operation: {
              ...operation,
              priorEpoch: 1,
              priorRunToken: m.handoff.priorRunToken,
            },
            tables: { deploymentControl: table },
          }),
        ).toThrow();
    } finally {
      // Generated table cleanup is owned by the shared fixture.
    }
  },
);
