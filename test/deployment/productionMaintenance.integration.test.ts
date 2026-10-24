import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PutItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { history as historyFixture } from "./controlFixtures";
import { fixture, client, readStored } from "./fixtures/productionIntroduction";
import { loadLegacyDatabase } from "../fixtures/maintenance/legacyRuntime.js";
import { requireLegacyDatabase } from "../fixtures/maintenance/legacyDatabase";
import { buildMaintenancePolicy } from "../../scripts/deployment/maintenance-fence.cjs";
import { metadataDigest } from "../../scripts/deployment/production-work.cjs";
import {
  createRuntimeLifecycle,
  type RuntimeLifecycle,
} from "../../src/services/runtimeLifecycleService";
import { localProtection } from "./fixtures/localProtection";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";

// Exercise source repositories with one-attempt dummy-credential loopback transport only.
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class extends actual.DynamoDBClient {
      constructor(input: object) {
        super({
          ...input,
          endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
          region: "local",
          credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
          maxAttempts: 1,
        });
      }
    },
  };
});
function queued(uploadId: string): PersonalMediaUploadJobRecord {
  return {
    uploadId,
    ownerUserId: "synthetic-owner",
    status: "queued",
    mediaKind: "audio",
    sourceS3Key: "synthetic-local-input",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test.each(["acknowledged", "unknown"])(
  "local legacy maintenance with %s effects preserves ownership and retained work",
  async (outcome) => {
    let candidate: RuntimeLifecycle | undefined;
    const f = await fixture(false, async (identity, controlTable) => {
      candidate = createRuntimeLifecycle({
        identity,
        now: () => 1000,
        repository: createDynamoDeploymentControlRepository(client, {
          deploymentControl: controlTable,
          meetingHistory: f.physical.get(f.m.binding.tableArns.history)!,
          activeMeeting: f.physical.get(f.m.binding.tableArns.leases)!,
        }),
        protection: localProtection(identity, () => 1000, 2000),
        probeReadiness: async () => ({
          gatewayReady: true,
          cacheReady: true,
          dependenciesReady: true,
        }),
        checkpointAndFence: async () => {},
      });
      await candidate.start();
      expect(candidate.getRole()).toBe("candidate");
      expect(candidate.isAcceptingWork()).toBe(false);
      expect(() =>
        candidate!.beginRuntimeWork("personal_processing"),
      ).toThrow();
    });
    const tableName = (name: string) =>
      [...f.physical.values()].find((value) => value.endsWith(name))!;
    const send: DynamoDBClient["send"] = client.send.bind(client);
    const policy = buildMaintenancePolicy(f.m.binding);
    const requests: string[] = [];
    const legacy = requireLegacyDatabase(
      loadLegacyDatabase(
        {
          send: async (command: PutItemCommand | UpdateItemCommand) => {
            const input = command.input;
            const action =
              "dynamodb:" + command.constructor.name.replace("Command", "");
            const arn = [...f.physical].find(
              ([, name]) => name === input.TableName,
            )?.[0];
            const attributes = Object.values(
              input.ExpressionAttributeNames ?? {},
            );
            const denied =
              f.isOwned() &&
              policy.Statement.some(
                (statement: {
                  Action: string;
                  Resource: string;
                  Condition?: Record<string, Record<string, string>>;
                }) =>
                  statement.Action === action &&
                  statement.Resource === arn &&
                  (!statement.Condition ||
                    attributes.includes(
                      statement.Condition["ForAnyValue:StringEquals"][
                        "dynamodb:Attributes"
                      ],
                    )),
              );
            requests.push(action);
            if (denied)
              throw Object.assign(
                new Error("Simulated policy deny, not native IAM proof"),
                { name: "AccessDeniedException" },
              );
            if (command instanceof PutItemCommand) return send(command);
            return send(command);
          },
        },
        tableName,
      ),
    );
    const lease = {
      guildId: "local-guild",
      meetingId: "local-meeting",
      ownerInstanceId: "legacy",
      status: "recording",
      leaseExpiresAt: 1500,
      expiresAt: 5000,
    };
    const history = {
      guildId: lease.guildId,
      channelId_timestamp: "local-channel#local-time",
      meetingId: lease.meetingId,
      ownerInstanceId: "legacy",
      status: "recording",
      notes: "retained local content",
    };
    const inProgress = queued("active-upload"),
      retained = queued("retained-upload");
    const put = (table: string, value: object) =>
      client.send(
        new PutItemCommand({
          TableName: tableName(table),
          Item: marshall(value),
        }),
      );
    const read = async (table: string, key: object) =>
      unmarshall((await readStored(tableName(table), marshall(key)))!);
    const claimLegacy = (uploadId: string) =>
      legacy.claimPersonalMediaUploadJob({
        uploadId,
        instanceId: "legacy",
        nowEpochSeconds: 1000,
        claimExpiresAt: 1500,
        updatedAt: "2026-01-01T00:00:01Z",
        maxAttempts: 3,
      });
    const acknowledged = new Set<string>();
    const originalProbe = f.options.probe;
    f.options.probe = Object.assign(
      async (
        request: Parameters<typeof originalProbe>[0],
        snapshot?: { tables: Record<string, Record<string, unknown>[]> },
      ) => {
        const result = await originalProbe(request);
        result.validUntil = Math.min(result.validUntil, request.validUntil);
        if (!snapshot) throw new Error("Missing local snapshot");
        result.settlements = Object.entries(snapshot.tables).flatMap(
          ([table, rows]) =>
            rows
              .filter((row) =>
                acknowledged.has(String(row.meetingId ?? row.uploadId)),
              )
              .map((row) => ({
                table,
                rowDigest: metadataDigest(row),
                effects: "acknowledged",
                evidenceId: "local-simulated-ack",
              })),
        );
        result.compatibility.uploads = snapshot.tables.uploads
          .filter((row) => row.uploadId === retained.uploadId)
          .map((row) => ({
            uploadId: String(row.uploadId),
            rowDigest: metadataDigest(row),
            sourceInput: "verified",
            token: "verified",
            schema: "verified",
            ownership: "verified",
            claimProtocol: "verified",
            evidenceId: "local-retained-input",
            validUntil: 2000,
          }));
        return result;
      },
      {
        capture: originalProbe.capture,
        readCapture: originalProbe.readCapture,
      },
    );
    try {
      expect(await legacy.tryAcquireActiveMeetingLease(lease, 1000)).toBe(true);
      await legacy.writeMeetingHistory(history);
      await put("PersonalMediaUploadJobTable", inProgress);
      await put("PersonalMediaUploadJobTable", retained);
      const active = await claimLegacy(inProgress.uploadId);
      if (!active) throw new Error("Legacy upload claim was not acknowledged");
      expect(active.status).toBe("processing");
      const retainedBefore = await read("PersonalMediaUploadJobTable", {
        uploadId: retained.uploadId,
      });
      await f.run("fence", "1");
      await expect(claimLegacy(retained.uploadId)).rejects.toThrow(
        "Simulated policy deny",
      );
      await expect(
        legacy.tryAcquireActiveMeetingLease(
          { ...lease, guildId: "another" },
          1000,
        ),
      ).rejects.toThrow("Simulated policy deny");
      expect(
        await read("PersonalMediaUploadJobTable", {
          uploadId: retained.uploadId,
        }),
      ).toEqual(retainedBefore);
      expect(
        await legacy.renewActiveMeetingLease(
          lease.guildId,
          lease.meetingId,
          "legacy",
          1600,
          "2026-01-01T00:00:02Z",
          5000,
          { status: "processing" },
        ),
      ).toBe(true);
      expect(
        await legacy.renewPersonalMediaUploadJobClaim({
          uploadId: active.uploadId,
          instanceId: "legacy",
          claimExpiresAt: 1600,
          updatedAt: "2026-01-01T00:00:02Z",
        }),
      ).toBe(true);
      expect(
        await legacy.updateClaimedPersonalMediaUploadJobProgress({
          uploadId: active.uploadId,
          instanceId: "legacy",
          segmentCount: 1,
          uploadedSegmentCount: 1,
          processedSegmentCount: 1,
          updatedAt: "2026-01-01T00:00:03Z",
        }),
      ).toBe(true);
      const readOwnedWork = () =>
        Promise.all([
          read("MeetingHistoryTable", {
            guildId: history.guildId,
            channelId_timestamp: history.channelId_timestamp,
          }),
          read("PersonalMediaUploadJobTable", { uploadId: active.uploadId }),
          read("ActiveMeetingTable", { guildId: lease.guildId }),
        ]);
      const unfinished = await readOwnedWork();
      const effect = Promise.withResolvers<void>();
      let effectAcknowledged = false;
      const acknowledge = () => {
        if (effectAcknowledged)
          throw new Error("Duplicate synthetic acknowledgment");
        effectAcknowledged = true;
        effect.resolve();
      };
      // This promise models an issued effect. Only its acknowledgment admits terminal writes.
      const finalization = (async () => {
        await effect.promise;
        acknowledged.add(history.meetingId);
        acknowledged.add(active.uploadId);
        await legacy.writeMeetingHistory({ ...history, status: "complete" });
        const terminal = {
          ...(await read("PersonalMediaUploadJobTable", {
            uploadId: active.uploadId,
          })),
          status: "complete",
          completedAt: "2026-01-01T00:00:04Z",
        };
        expect(
          await legacy.writeClaimedPersonalMediaUploadJob(terminal, "legacy"),
        ).toBe(true);
        expect(
          await legacy.writeClaimedPersonalMediaUploadJob(terminal, "legacy"),
        ).toBe(false);
        expect(
          await legacy.releaseActiveMeetingLease(
            lease.guildId,
            lease.meetingId,
            "legacy",
          ),
        ).toBe(true);
        expect(
          await legacy.releaseActiveMeetingLease(
            lease.guildId,
            lease.meetingId,
            "legacy",
          ),
        ).toBe(false);
      })();
      await expect(f.run("drain", "2")).rejects.toThrow();
      expect(await readOwnedWork()).toEqual(unfinished);
      expect(f.serviceRequests).toHaveLength(0);
      expect(
        requests.filter((action) => action === "dynamodb:DeleteItem"),
      ).toHaveLength(0);
      if (outcome === "unknown") {
        effect.reject(new Error("Unknown synthetic effect acknowledgment"));
        await expect(finalization).rejects.toThrow(
          "Unknown synthetic effect acknowledgment",
        );
        await expect(f.run("drain", "3")).rejects.toThrow();
        expect(await readOwnedWork()).toEqual(unfinished);
        expect(f.isOwned()).toBe(true);
        expect(f.serviceRequests).toHaveLength(0);
        expect(
          requests.filter((action) => action === "dynamodb:DeleteItem"),
        ).toHaveLength(0);
        expect(
          await read("PersonalMediaUploadJobTable", {
            uploadId: retained.uploadId,
          }),
        ).toEqual(retainedBefore);
        return;
      }
      acknowledge();
      await finalization;
      expect(acknowledge).toThrow("Duplicate synthetic acknowledgment");
      const completedHistory = await read("MeetingHistoryTable", {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      });
      const completedUpload = await read("PersonalMediaUploadJobTable", {
        uploadId: active.uploadId,
      });
      expect(completedUpload).toMatchObject({
        claimExpiresAt: 1600,
        segmentCount: 1,
        uploadedSegmentCount: 1,
        processedSegmentCount: 1,
      });
      await f.run("drain", "4");
      const native = f.options.aws;
      let noTargetStarted = 0;
      f.options.aws = async (
        service: string,
        operation: string,
        input: object,
      ) => {
        const result = await native(service, operation, input);
        if (
          operation === "update-service" &&
          "desiredCount" in input &&
          input.desiredCount === 0
        )
          noTargetStarted = performance.now();
        return result;
      };
      await f.run("activate", "5");
      const localOnlyNoTargetMilliseconds = performance.now() - noTargetStarted;
      expect(noTargetStarted).toBeGreaterThan(0);
      expect(localOnlyNoTargetMilliseconds).toBeGreaterThan(0);
      console.info(
        "LOCAL ONLY simulated no-target interval ms",
        localOnlyNoTargetMilliseconds,
      );
      await f.run("complete", "6");
      expect(candidate).toBeDefined();
      await candidate!.refreshRuntimeReadiness();
      expect(candidate!.getRole()).toBe("serving");
      const context = await candidate!.getRuntimeAdmissionContext();
      process.env.USE_LOCAL_DYNAMODB = "true";
      process.env.DDB_TABLE_PREFIX = tableName(
        "PersonalMediaUploadJobTable",
      ).slice(0, -"PersonalMediaUploadJobTable".length);
      const { getPersonalMediaUploadRepository } =
        await import("../../src/repositories/personalMediaUploadRepository");
      const repository = getPersonalMediaUploadRepository();
      const work = candidate!.beginRuntimeWork("personal_processing");
      const claims = [randomUUID(), randomUUID()].map((claimId) => ({
        uploadId: retained.uploadId,
        instanceId: "candidate",
        context,
        nowEpochSeconds: 1000,
        claimExpiresAt: 1600,
        updatedAt: "2026-01-01T00:00:05Z",
        maxAttempts: 3,
        expectedAttempts: 0,
        claimId,
      }));
      const results = await Promise.all(
        claims.map((claim) => repository.claim(claim)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const claimed = results.find((row) => row !== undefined)!;
      expect(claimed).toMatchObject({
        status: "processing",
        attempts: 1,
        sourceS3Key: retained.sourceS3Key,
        ownerUserId: retained.ownerUserId,
      });
      expect(
        await repository.claim(claims[results.findIndex(Boolean)]),
      ).toEqual(claimed);
      expect(
        await repository.claim({ ...claims[0], claimId: randomUUID() }),
      ).toBeUndefined();
      expect((await repository.get(retained.uploadId))?.attempts).toBe(1);
      const resumedHistory = {
        ...historyFixture,
        guildId: "personal:" + retained.ownerUserId,
        channelId_timestamp: "retained-channel#2026-01-01T00:00:05Z",
        meetingId: "retained-meeting",
        ownerUserId: retained.ownerUserId,
        ownershipScope: "personal" as const,
        status: "complete" as const,
      };
      const resumedClaim = {
        uploadId: claimed.uploadId,
        instanceId: "candidate",
        attempt: 1,
        claimId: claimed.processingClaimId!,
        nowEpochSeconds: 1000,
      };
      const terminalJob = { ...claimed, status: "complete" as const };
      expect(
        await repository.writeHistory(
          resumedHistory,
          resumedClaim,
          terminalJob,
        ),
      ).toEqual({ kind: "committed", history: resumedHistory });
      expect(
        await repository.writeHistory(
          resumedHistory,
          resumedClaim,
          terminalJob,
        ),
      ).toEqual({ kind: "stale" });
      expect(await repository.get(retained.uploadId)).toMatchObject({
        status: "complete",
        attempts: 1,
        sourceS3Key: retained.sourceS3Key,
      });
      work.settle();
      expect(
        await read("MeetingHistoryTable", {
          guildId: history.guildId,
          channelId_timestamp: history.channelId_timestamp,
        }),
      ).toEqual(completedHistory);
      expect(
        await read("PersonalMediaUploadJobTable", {
          uploadId: active.uploadId,
        }),
      ).toEqual(completedUpload);
      expect((await f.head())?.stage).toBe("complete");
      expect(
        f.calls.filter((operation) => operation === "delete-role-policy"),
      ).toHaveLength(1);
      expect(
        requests.filter((action) => action === "dynamodb:DeleteItem"),
      ).toHaveLength(2);
    } finally {
      candidate?.stop();
    }
  },
);
