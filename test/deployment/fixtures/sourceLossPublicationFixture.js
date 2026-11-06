import { productionSourceLossPacket } from "./productionSourceLossPacket";
import { jest } from "@jest/globals";
/** @jest-environment node */
// Synthetic provider effects, real local DynamoDB and runtime admission logic.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { sourceLossFixture } from "./sourceLossFixture";
import {
  introductionClient,
  createIntroductionTable,
  putIntroductionDocument,
  readIntroductionDocument,
} from "./introductionStore";
import { recoverProduction } from "../../../scripts/deployment/recover-production-source-loss.cjs";
import { bindingHash } from "../../../scripts/deployment/continue-sandbox.cjs";
import { createRuntimeLifecycle } from "../../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../../src/services/runtimeProtectionService";
import { createRuntimeArtifactSafety } from "../../../src/services/runtimeArtifactSafety";
import { createArtifactAdmissionGate } from "../../../src/services/artifactAdmissionGate";
import { createMockDeploymentControlRepository } from "../../../src/repositories/deploymentControlRepository";
import { createMockArtifactSafetyRepository } from "../../../src/repositories/artifactSafetyRepository";
import { createCoordinator } from "../../../scripts/deployment/coordinator.cjs";
import { publicationImages } from "../../../scripts/deployment/publication-compatibility.cjs";

const key = (sk) => JSON.stringify(["ENV", sk]);
const suffixes = {
  DeploymentControlTable: ["pk", "sk"],
  MeetingHistoryTable: ["guildId", "channelId_timestamp"],
  ActiveMeetingTable: ["guildId"],
  MeetingControlCommandTable: ["requestId"],
  PersonalMediaUploadJobTable: ["uploadId"],
};

export async function qualifiedFixture({
  historyAuthority = false,
  publicationControl = {},
  publicationReleases,
  sameRun = false,
  knownCompatible = false,
} = {}) {
  const f = await sourceLossFixture();
  const d = f.state.ctl.deployment;
  d.phase = "promoting";
  d.candidate = f.candidateIdentity;
  d.tablePrefix = "fixture-prod-";
  Object.assign(f.state.ctl, publicationControl);
  if (sameRun)
    f.state.ctl.publicationTransition = {
      runToken: d.runToken,
      images: publicationImages(f.state.ctl, d.image),
    };
  if (knownCompatible)
    publicationReleases = {
      contract: "first_publication_archive_fence_v1",
      images: [
        ...new Set(
          publicationImages(f.state.ctl, d.image).map((image) =>
            image.replace(/^.*@/, ""),
          ),
        ),
      ],
    };
  f.state.rows.old.workCounts.finalization = 1;
  f.state.rows.old.workCounts.voice_operation = 1;
  const tables = {};
  const id = randomUUID();
  for (const [suffix, keys] of Object.entries(suffixes)) {
    tables[suffix] = `qualification-${id}-${suffix}`;
    await createIntroductionTable(tables[suffix], keys);
  }
  const table = tables.DeploymentControlTable;
  const read = (sk) => readIntroductionDocument(table, { pk: "ENV", sk });
  const actor = {
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AccountAdministrator_fixture/operator",
  };
  const lease = {
    guildId: "synthetic-guild",
    meetingId: "synthetic-meeting",
    ownerInstanceId: "old",
    executionVersion: 1,
    leaseExpiresAt: 999,
    sessionMode: "meeting",
  };
  const voice = {
    pk: "VOICE#synthetic-guild",
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: lease.guildId,
    meetingId: lease.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    attemptId: "synthetic-attempt",
    sessionMode: "meeting",
    state: "uncertain",
    updatedAt: 999,
  };
  const records = new Map([
    [key("CONTROL"), structuredClone(f.state.ctl)],
    [key("RUNTIME#old"), structuredClone(f.state.rows.old)],
  ]);
  const artifacts = new Map(
    [...f.state.artifacts.values()].map((row) => [
      row.sk,
      structuredClone(row),
    ]),
  );
  const repository = createMockDeploymentControlRepository(records);
  const histories = new Map();
  const artifactRepository = createMockArtifactSafetyRepository({
    records,
    artifacts,
    histories,
  });
  const admission = createArtifactAdmissionGate();
  const snapshot = f.state.artifacts.get("new").startup.proof.snapshot;
  const authority = {
    owner: {
      guildId: "history-guild",
      meetingId: "history-meeting",
      ownerInstanceId: "old",
      executionVersion: 1,
    },
    historyKey: "history-channel_time",
    checkpoint: null,
    status: "complete",
    completionDecision: "proceed",
    audioS3Key: "synthetic-stored",
    chatS3Key: null,
    transcriptS3Key: null,
  };
  if (historyAuthority) {
    snapshot.authorities = [authority];
    const history = {
      guildId: authority.owner.guildId,
      channelId_timestamp: authority.historyKey,
      meetingId: authority.owner.meetingId,
      status: authority.status,
      completionPolicy: { decision: authority.completionDecision },
      audioS3Key: authority.audioS3Key,
      ownerInstanceId: authority.owner.ownerInstanceId,
      executionVersion: 1,
    };
    histories.set(authority.owner.guildId, [history]);
    await putIntroductionDocument(tables.MeetingHistoryTable, history);
  }
  const storage = {
    seal: async () => snapshot,
    recheck: async () => snapshot,
    resume: jest.fn(),
  };
  const protection = createRuntimeProtectionService({
    identity: f.candidateIdentity,
    agentUri: "http://synthetic-agent",
    now: () => f.loss.clock,
    onUnsafe: jest.fn(),
    request: async () =>
      new Response(
        JSON.stringify({
          protection: {
            TaskArn: f.candidateIdentity.taskArn,
            ProtectionEnabled: true,
            ExpirationDate: new Date((f.loss.clock + 600) * 1000).toISOString(),
          },
        }),
        { status: 200 },
      ),
  });
  const safety = createRuntimeArtifactSafety({
    identity: f.candidateIdentity,
    repository: artifactRepository,
    control: repository,
    admission,
    storage,
    now: () => f.loss.clock,
    isProtected: () => protection.isSafe(),
  });
  const lifecycle = createRuntimeLifecycle({
    identity: f.candidateIdentity,
    repository,
    protection,
    artifactAdmission: admission,
    artifactSafety: safety,
    now: () => f.loss.clock,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: async () => undefined,
  });
  await lifecycle.start();
  await safety.startupReady();
  await lifecycle.refreshRuntimeReadiness();
  f.state.rows.new = records.get(key("RUNTIME#new"));
  for (const row of [
    f.state.ctl,
    f.state.rows.old,
    f.state.rows.new,
    voice,
    ...artifacts.values(),
  ])
    await putIntroductionDocument(table, row);
  await putIntroductionDocument(tables.ActiveMeetingTable, lease);
  const native = f.aws.getMockImplementation();
  const counts = { admissionWrites: 0, listenerWrites: 0, otherWrites: 0 };
  const fault = {
    beforeAdmission: false,
    afterAdmission: false,
    afterListener: false,
    hold: false,
  };
  async function addPublicationHold() {
    const ctl = await read("CONTROL");
    ctl.publicationProtocol = 1;
    ctl.publicationPins = {
      synthetic: { authorities: ["synthetic-authority"], settled: [] },
    };
    ctl.publicationTransition = { runToken: "other-deployment", images: [] };
    await putIntroductionDocument(table, ctl);
  }
  let admissionAcknowledged = false;
  async function sync() {
    f.state.ctl = await read("CONTROL");
    f.state.rows.new = await read("RUNTIME#new");
    f.state.rows.old = await read("RUNTIME#old");
    records.set(key("CONTROL"), structuredClone(f.state.ctl));
    records.set(key("RUNTIME#new"), structuredClone(f.state.rows.new));
    f.loss.receipt = await readIntroductionDocument(table, {
      pk: "SOURCELOSS#" + d.runToken,
      sk: "RECOVERY",
    });
  }
  async function refreshActualRuntime() {
    f.loss.clock++;
    await sync();
    await lifecycle.refreshRuntimeReadiness();
    const row = records.get(key("RUNTIME#new"));
    await putIntroductionDocument(table, row);
    for (const artifact of artifacts.values())
      if (artifact.identity.instanceId === "new")
        await putIntroductionDocument(table, artifact);
    await sync();
  }
  const physical = (name) => {
    const suffix = Object.keys(tables).find((s) => name.endsWith(s));
    assert(suffix, "Unmapped synthetic table");
    return tables[suffix];
  };
  async function localDynamo(operation, input) {
    if (
      fault.unavailableReadback &&
      admissionAcknowledged &&
      operation === "get-item" &&
      unmarshall(input.Key).sk === "CONTROL"
    )
      throw new Error("Synthetic readback unavailable");
    const commands = {
      "get-item": GetItemCommand,
      query: QueryCommand,
      scan: ScanCommand,
      "update-item": UpdateItemCommand,
    };
    if (commands[operation]) {
      if (operation === "update-item") counts.otherWrites++;
      const result = await introductionClient.send(
        new commands[operation]({
          ...input,
          TableName: physical(input.TableName),
        }),
      );
      if (operation === "update-item") await sync();
      return result;
    }
    assert.equal(operation, "transact-write-items");
    return transactLocal(input);
  }
  async function transactLocal(input) {
    const put = input.TransactItems.find((x) => x.Put)?.Put;
    const receipt = put ? unmarshall(put.Item) : undefined;
    const first = receipt?.stage === "admission_transferred";
    if (receipt?.stage === "forward_submitted" && fault.pinBeforeRouting)
      await addPublicationHold();
    if (first) {
      counts.admissionWrites++;
      if (fault.pinBeforeAdmission) await addPublicationHold();
      if (fault.beforeAdmission)
        throw new Error("Unknown admission write before commit");
    }
    const transaction = {
      ...input,
      TransactItems: input.TransactItems.map((item) => {
        const kind = Object.keys(item)[0];
        assert(
          ["Update", "Put", "ConditionCheck"].includes(kind),
          "Forbidden synthetic mutation",
        );
        return {
          [kind]: {
            ...item[kind],
            TableName: physical(item[kind].TableName),
          },
        };
      }),
    };
    const result = await introductionClient.send(
      new TransactWriteItemsCommand(transaction),
    );
    await sync();
    if (first) {
      admissionAcknowledged = true;
      await refreshActualRuntime();
      if (fault.pinAfterAdmission) await addPublicationHold();
      if (fault.afterAdmission)
        throw new Error("Lost admission acknowledgment after commit");
    }
    return result;
  }
  f.aws.mockImplementation(async (service, operation, input) => {
    if (service === "sts") return actor;
    if (service === "dynamodb") return localDynamo(operation, input);
    if (
      operation === "get-task-protection" &&
      input.tasks.includes(f.oldIdentity.taskArn)
    )
      return {
        failures: [{ arn: f.oldIdentity.taskArn, reason: "TASK_NOT_RUNNING" }],
      };
    if (operation === "describe-task-definition") {
      const result = await native(service, operation, input);
      result.taskDefinition.containerDefinitions[0].environment.find(
        (x) => x.name === "STRIPE_MODE",
      ).value = "live";
      return result;
    }
    if (operation === "modify-listener") {
      counts.listenerWrites++;
      assert(admissionAcknowledged, "Routing before admitted generation");
      assert.equal((await read("CONTROL")).servingGeneration, 2);
      assert.equal(
        (
          await readIntroductionDocument(table, {
            pk: "SOURCELOSS#" + d.runToken,
            sk: "RECOVERY",
          })
        ).stage,
        "forward_submitted",
      );
      const result = await native(service, operation, input);
      if (fault.afterListener)
        throw new Error("Unknown listener outcome after apply");
      return result;
    }
    return native(service, operation, input);
  });
  const packet = productionSourceLossPacket(
    f.state.ctl,
    f.candidateIdentity,
    actor,
    "35980886efa2e33cdef014750bfb55a19cb2210a",
  );
  const options = {
    ...f.options,
    aws: f.aws,
    packet,
    sleep: refreshActualRuntime,
    publicationReleases,
  };
  const normal = createCoordinator({
    ...f.options,
    aws: f.aws,
    env: { ...f.options.env, SECRETS_PREFIX: "fixture-prod-".slice(0, -1) },
  });
  return {
    ...f,
    table,
    tables,
    read,
    packet,
    options,
    normal,
    lifecycle,
    admission,
    fault,
    counts,
    addPublicationHold,
    inspect: async () => {
      const r = await recoverProduction({ ...options, mode: "inspect" });
      options.packetSha256 = bindingHash(packet);
      options.bindingSha256 = r.bindingSha256;
      return r;
    },
    apply: () => recoverProduction({ ...options, mode: "apply" }),
    stop: () => lifecycle.shutdown(),
    readLease: () =>
      readIntroductionDocument(tables.ActiveMeetingTable, {
        guildId: lease.guildId,
      }),
    readVoice: () =>
      readIntroductionDocument(table, { pk: voice.pk, sk: voice.sk }),
    readReceipt: () =>
      readIntroductionDocument(table, {
        pk: "SOURCELOSS#" + d.runToken,
        sk: "RECOVERY",
      }),
  };
}
