/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { setImmediate } from "node:timers";
import vm from "node:vm";
import ts from "typescript";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import legacy from "../fixtures/maintenance/legacy593a.json";
import { loadLegacyDatabase } from "../fixtures/maintenance/legacyRuntime.js";
import {
  buildProbeRequests,
  classifyProbe,
} from "../../scripts/deployment/maintenance-probe.cjs";
import { buildMaintenancePolicy } from "../../scripts/deployment/maintenance-fence.cjs";
const { binding } = legacy;
function loadLegacy(sendError) {
  const captured = [];
  const exports = loadLegacyDatabase(
    {
      send: async (command) => {
        captured.push(command.input);
        if (sendError) throw sendError;
        return {};
      },
    },
    (name) =>
      binding[
        name === "ActiveMeetingTable"
          ? "activeMeetingTableArn"
          : "personalMediaUploadJobTableArn"
      ],
  );
  return { exports, captured };
}
test("probe shapes retain frozen legacy requests with an independently impossible actual-key guard", async () => {
  const probes = buildProbeRequests(binding);
  const { exports: db, captured } = loadLegacy();
  const lease = unmarshall(probes.meetingAcquire.request.Item);
  const claim = unmarshall(
    probes.uploadClaim.request.ExpressionAttributeValues,
  );
  const options = {
    uploadId: binding.operationId,
    instanceId: claim[":instanceId"],
    nowEpochSeconds: claim[":nowEpochSeconds"],
    claimExpiresAt: claim[":claimExpiresAt"],
    updatedAt: claim[":updatedAt"],
    maxAttempts: claim[":maxAttempts"],
  };
  await db.tryAcquireActiveMeetingLease(lease, claim[":nowEpochSeconds"]);
  await db.claimPersonalMediaUploadJob(options);
  await db.renewPersonalMediaUploadJobClaim(options);
  await db.updateClaimedPersonalMediaUploadJobProgress({
    ...options,
    segmentCount: 0,
    uploadedSegmentCount: 0,
    processedSegmentCount: 0,
  });
  await db.releaseActiveMeetingLease(
    lease.guildId,
    lease.meetingId,
    lease.ownerInstanceId,
  );
  await db.renewActiveMeetingLease(
    lease.guildId,
    lease.meetingId,
    lease.ownerInstanceId,
    lease.leaseExpiresAt,
    lease.updatedAt,
    lease.expiresAt,
    { status: lease.status },
  );
  const entries = [
    probes.meetingAcquire,
    probes.uploadClaim,
    probes.uploadRenew,
    probes.uploadProgress,
    probes.meetingRelease,
    probes.meetingRenew,
  ];
  for (const [index, { request }] of entries.entries()) {
    const frozen = captured[index];
    const key = index === 0 || index >= 4 ? "guildId" : "uploadId";
    expect(request.UpdateExpression).toEqual(frozen.UpdateExpression);
    expect(request.ReturnValues).toEqual(frozen.ReturnValues);
    expect(request.Item).toEqual(frozen.Item);
    expect(request.Key).toEqual(frozen.Key);
    expect(request.ConditionExpression).toBe(
      "(" +
        frozen.ConditionExpression +
        ") AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
    );
    expect(request.ExpressionAttributeNames).toEqual({
      ...frozen.ExpressionAttributeNames,
      "#maintenanceKey": key,
    });
    expect(request.ExpressionAttributeValues).toEqual(
      frozen.ExpressionAttributeValues,
    );
    const guard = request.ConditionExpression.match(
      /attribute_exists\((#[A-Za-z]+)\) AND attribute_not_exists\((#[A-Za-z]+)\)$/,
    );
    expect(guard).not.toBeNull();
    expect(request.ExpressionAttributeNames[guard[1]]).toBe(key);
    expect(request.ExpressionAttributeNames[guard[2]]).toBe(key);
    for (const item of [undefined, {}, { [key]: { S: "existing" } }]) {
      const has = (alias) =>
        Object.hasOwn(item || {}, request.ExpressionAttributeNames[alias]);
      expect(has(guard[1]) && !has(guard[2])).toBe(false);
    }
    const attrs = Object.values(request.ExpressionAttributeNames);
    expect(attrs.includes("processingStartedAt")).toBe(index === 1);
    expect(
      Object.values(frozen.ExpressionAttributeNames).filter((a) => a !== key),
    ).toEqual(attrs.filter((a) => a !== key));
  }
});
test.each([
  ["AccessDeniedException", "iam_denied"],
  ["ConditionalCheckFailedException", "condition_refused"],
  ["ThrottlingException", "unavailable"],
  ["ValidationException", "unavailable"],
  ["ResourceNotFoundException", "unavailable"],
  ["TransactionCanceledException", "unavailable"],
  [undefined, "unavailable"],
])("classifies %s conservatively", (errorName, expected) =>
  expect(classifyProbe({ errorName })).toBe(expected),
);
test("validates bindings before constructing requests", () =>
  expect(() =>
    buildProbeRequests({ ...binding, region: "eu-west-1" }),
  ).toThrow());
test("frozen worker denied claim logs and leaves job and owner untouched", async () => {
  const job = {
    uploadId: binding.operationId,
    status: "queued",
    attempts: 2,
    processingOwnerInstanceId: "existing-owner",
  };
  const before = JSON.parse(JSON.stringify(job));
  const error = Object.assign(new Error("denied"), {
    name: "AccessDeniedException",
  });
  const logs = [];
  let processed = 0;
  let writes = 0;
  const exports = {};
  const { exports: db } = loadLegacy(error);
  const repository = {
    listClaimable: async () => [job],
    claim: db.claimPersonalMediaUploadJob,
    renewClaim: async () => {
      writes++;
    },
    update: async () => {
      writes++;
    },
    updateClaimed: async () => {
      writes++;
    },
  };
  const context = {
    exports,
    require: (path) => {
      if (path.endsWith("constants")) return legacy.constants;
      if (path.includes("personalMediaUploadRepository"))
        return { getPersonalMediaUploadRepository: () => repository };
      if (path.includes("runtimeInstanceService"))
        return { getRuntimeInstanceId: () => "worker" };
      return {
        createPersonalMediaProcessingMeeting: async () => {
          processed++;
        },
        processPersonalMediaUpload: async () => {
          processed++;
        },
      };
    },
    console: { error: (...args) => logs.push(args) },
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
  };
  vm.runInNewContext(
    ts.transpileModule(legacy.worker, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  exports.startPersonalMediaUploadWorker();
  await new Promise(setImmediate);
  expect(logs).toEqual([["Personal media upload worker failed", error]]);
  expect(job).toEqual(before);
  expect(processed).toBe(0);
  expect(writes).toBe(0);
  exports.stopPersonalMediaUploadWorker();
});

test("optional lease fields cannot change table-wide PutItem deny matching", () => {
  const statement = buildMaintenancePolicy(binding).Statement[0];
  for (const optional of [
    {},
    {
      voiceChannelName: { S: "optional" },
      startReason: { S: "manual" },
      startTriggeredByUserId: { S: "synthetic" },
      autoRecordRule: { S: "synthetic" },
    },
  ]) {
    const probe = buildProbeRequests(binding).meetingAcquire;
    probe.request.Item = { ...probe.request.Item, ...optional };
    expect(statement.Action).toBe("dynamodb:" + probe.action);
    expect(statement.Resource).toBe(probe.request.TableName);
    expect(statement.Condition).toBeUndefined();
  }
});
