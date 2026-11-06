import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifiedFixture } from "./sourceLossPublicationFixture";
import { syntheticStopEventEvidence } from "./productionSourceLossPacket";
import {
  putIntroductionDocument,
  readIntroductionDocument,
} from "./introductionStore";
import {
  bindingHash,
  continuationBinding,
} from "../../../scripts/deployment/continue-sandbox.cjs";
import { closeoutProduction } from "../../../scripts/deployment/recover-production-source-loss.cjs";

export async function historicalCloseoutFixture(options = {}) {
  const f = await qualifiedFixture(options);
  f.definition.containerDefinitions[0].environment.find(
    (entry) => entry.name === "DDB_TABLE_PREFIX",
  ).value = "fixture-prod-";
  await f.inspect();
  await f.apply();
  const ctl = await f.read("CONTROL");
  const old = await f.read("RUNTIME#old");
  const receipt = await f.readReceipt();
  ctl.coordinatorExpiresAt = f.loss.clock - 1;
  ctl.deployment.cluster = f.oldIdentity.taskArn.split("/")[1];
  Object.keys(old.workCounts).forEach((kind) => {
    old.workCounts[kind] = kind === "pending_admission" ? 1 : 0;
  });
  const event = {
    id: "synthetic-stop",
    createdAt: new Date(900000).toISOString(),
    message: "(service service) has stopped 1 running tasks: (task old).",
  };
  Object.assign(f.svc, {
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/fixture",
    serviceArn: "arn:aws:ecs:us-east-1:123456789012:service/fixture/service",
    events: [event],
  });
  const eventEvidence = syntheticStopEventEvidence(f.svc, event);
  delete receipt.stoppedAt;
  Object.assign(receipt, {
    version: 3,
    terminalProof: {
      ...eventEvidence,
      eventCreatedAt: event.createdAt,
      nativeObservation: "MISSING",
    },
  });
  f.loss.missing = true;
  for (const row of [ctl, old, receipt])
    await putIntroductionDocument(f.table, row);
  const directory = mkdtempSync(join(tmpdir(), "chronote-closeout-"));
  const packet = {
    ...f.packet,
    operation: continuationBinding(ctl, ctl.deployment.candidate),
    eventEvidence,
    closeout: {
      version: 1,
      operationId: randomUUID(),
      approveBefore: f.loss.clock + 600,
      operatorExclusion: "exclusive_approved_writer_window",
      providerEffects: "all_submitted_effects_settled",
      controlSha256: bindingHash(ctl),
      recoverySha256: bindingHash(receipt),
      sourceRuntimeSha256: bindingHash(old),
      submissionFile: join(directory, "submission.json"),
    },
  };
  const closeoutOptions = {
    ...f.options,
    packet,
    packetSha256: bindingHash(packet),
  };
  const original = f.aws.getMockImplementation();
  const activity = {
    submissions: 0,
    calls: [],
    before: async () => {},
    after: async () => {},
    beforeError: false,
    afterError: false,
    readError: false,
  };
  f.aws.mockImplementation(async (s, o, i) => {
    activity.calls.push({ service: s, operation: o, input: i });
    if (activity.readError && activity.submissions && o === "get-item")
      throw new Error("Readback unavailable");
    if (o === "transact-write-items") {
      activity.submissions++;
      await activity.before();
      if (activity.beforeError) throw new Error("Unknown before commit");
      let result;
      try {
        result = await original(s, o, i);
      } catch (error) {
        activity.error = error;
        throw error;
      }
      await activity.after();
      if (activity.afterError) throw new Error("Unknown after commit");
      return result;
    }
    return original(s, o, i);
  });
  const inspectCloseout = async () => {
    const result = await closeoutProduction({
      ...closeoutOptions,
      mode: "inspect",
    });
    closeoutOptions.bindingSha256 = result.bindingSha256;
    return result;
  };
  return {
    ...f,
    event,
    packet,
    closeoutOptions,
    activity,
    inspectCloseout,
    observeCloseout: () =>
      closeoutProduction({ ...closeoutOptions, mode: "observe" }),
    applyCloseout: () =>
      closeoutProduction({ ...closeoutOptions, mode: "apply" }),
    receipt: () =>
      readIntroductionDocument(f.table, {
        pk: "HISTORICALCLOSEOUT#" + packet.closeout.operationId,
        sk: "RECEIPT",
      }),
    change: async (sk, change) => {
      const row = await f.read(sk);
      change(row);
      await putIntroductionDocument(f.table, row);
    },
    stop: async () => {
      await f.stop();
      rmSync(directory, { recursive: true });
    },
  };
}
