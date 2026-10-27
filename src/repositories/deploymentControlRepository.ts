import {
  proofReady,
  mockServingAdmissionAllowed,
} from "./deploymentControlReadiness";
import {
  consumedFixtureMatches,
  mockMaintenanceAllows,
  consumeMockFixture,
} from "../services/deploymentFixtureAdmission";
import {
  newWorkScopeSchema,
  type NewWorkScope,
} from "../types/productionIntroduction";
import {
  matchesOwnedHistoryTransition,
  applyMockOwnedHistoryTransition,
} from "./meetingHistoryTransitionState";

import {
  conditional,
  sessionReservationFailure,
  type ConditionalResult,
} from "./deploymentControlErrors";
import {
  createDynamoRecoveryRepository,
  createMockRecoveryRepository,
} from "./meetingRecoveryRepository";
import type { RecoveryRepository } from "../types/meetingRecovery";
import { planCompatibleReplacement } from "../services/runtimeCompatibleReplacementService";
import { buildPausedDesktopDraftInstallationTransaction } from "../services/pausedDesktopDraftTransactions";
import {
  recordingCheckpointSchema,
  recoveryDispositionSchema,
} from "../types/recordingCheckpoint";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { planLocalBootstrap } from "../services/runtimeLocalBootstrapPlan";
import type {
  ActiveMeetingLease,
  MeetingHistory,
  PersonalMediaUploadJobRecord,
} from "../types/db";
import {
  buildCompatibleReplacementTransaction,
  buildHistoryTransition,
  buildOwnedCheckpointTransition,
  buildInitialMeetingHistoryPut,
  buildPromotionTransaction,
  buildRuntimeAdmissionChecks,
  buildRuntimeRoleTransition,
  buildLocalBootstrapTransaction,
  buildSessionReservationTransaction,
  buildWorkAdmissionChecks,
  buildRuntimeRetirementRequest,
  retirementSnapshotCondition,
} from "../services/deploymentControlTransactions";
import {
  admissionContextSchema,
  controlRecordSchema,
  parseDeploymentControlRecord,
  promotionInputSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  validateRuntimeRoleTransition,
  type RuntimeRoleTransition,
  voiceRecordSchema,
  type AdmissionCheckResult,
  type AdmissionContext,
  type ControlRecord,
  type ControlTableNames,
  type DeploymentControlRecord,
  type HistoryKey,
  type HistoryTransition,
  type PromotionInput,
  type RuntimeRecord,
  type VoiceRecord,
  type LocalBootstrapInput,
  type CompatibleReplacementInput,
  type SessionReservationInput,
  type SessionReservationWriteResult,
  type WorkAdmissionAuthority,
  type SuppressionRecord,
  suppressionRecordSchema,
  type RuntimeRetirementRequestInput,
  type PausedDesktopDraftInstallation,
} from "../types/deploymentControl";

export {
  classifyDeploymentTransactionError,
  DeploymentControlError,
  type ConditionalResult,
} from "./deploymentControlErrors";
export type ExpectedVoiceState = Pick<
  VoiceRecord,
  "attemptId" | "state" | "ownerInstanceId" | "meetingId"
>;
export type DeploymentControlRepository = RecoveryRepository & {
  installPausedDesktopDrafts(
    input: PausedDesktopDraftInstallation,
  ): Promise<ConditionalResult>;
  writeSuppression(input: {
    record: SuppressionRecord;
    expectedVersion?: number;
    authority: WorkAdmissionAuthority;
  }): Promise<ConditionalResult>;
  reserveSession(
    input: SessionReservationInput,
  ): Promise<SessionReservationWriteResult>;
  replaceCompatibleRuntime(
    input: CompatibleReplacementInput,
  ): Promise<ConditionalResult>;
  supportsLocalBootstrap(): Promise<boolean>;
  bootstrapLocal(input: LocalBootstrapInput): Promise<ConditionalResult>;
  getRecord(
    pk: string,
    sk: string,
  ): Promise<DeploymentControlRecord | undefined>;
  initializeControl(record: ControlRecord): Promise<ConditionalResult>;
  writeRuntime(record: RuntimeRecord): Promise<ConditionalResult>;
  requestRetirement(
    input: RuntimeRetirementRequestInput,
  ): Promise<ConditionalResult>;
  transitionRuntimeRole(
    input: RuntimeRoleTransition,
  ): Promise<ConditionalResult>;
  writeVoice(
    record: VoiceRecord,
    expected?: ExpectedVoiceState,
  ): Promise<ConditionalResult>;
  /** Diagnostic only. Work claims must include buildRuntimeAdmissionChecks in their own transaction. */
  checkAdmission(
    context: AdmissionContext,
    scope?: NewWorkScope,
  ): Promise<AdmissionCheckResult>;
  promote(input: PromotionInput): Promise<ConditionalResult>;
  createInitialMeetingHistory(
    history: MeetingHistory,
  ): Promise<ConditionalResult>;
  transitionMeetingHistory(
    input: HistoryTransition,
  ): Promise<ConditionalResult>;
  getMeetingHistory(
    key: HistoryKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>;
  listPendingRecordingRecoveries(guildId: string): Promise<MeetingHistory[]>;
};

export function createDynamoDeploymentControlRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
  options: { localBootstrap?: boolean } = {},
): DeploymentControlRepository {
  async function supportsLocalBootstrap() {
    if (!options.localBootstrap || !client.config.endpoint) return false;
    const endpoint = await client.config.endpoint();
    const credentials = await client.config.credentials();
    return (
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname) &&
      endpoint.protocol === "http:" &&
      (await client.config.region()) === "local" &&
      credentials.accessKeyId === "dummy" &&
      credentials.secretAccessKey === "dummy" &&
      !credentials.sessionToken
    );
  }
  return {
    installPausedDesktopDrafts(input) {
      const transaction = buildPausedDesktopDraftInstallationTransaction(
        input,
        tables,
      );
      const command = new TransactWriteItemsCommand(transaction);
      // An unknown installation acknowledgment must stop for readback, never replay.
      command.middlewareStack.add((next) => next, {
        name: "retryMiddleware",
        step: "finalizeRequest",
        priority: "high",
        override: true,
      });
      // Explicit options bypass the SDK command-class handler cache.
      return conditional(() => client.send(command, {}));
    },
    ...createDynamoRecoveryRepository(client, {
      ...tables,
      get activeMeeting() {
        if (!tables.activeMeeting)
          throw new Error("Active meeting table required for recovery");
        return tables.activeMeeting;
      },
    }),
    replaceCompatibleRuntime(input) {
      return conditional(() =>
        client.send(
          new TransactWriteItemsCommand(
            buildCompatibleReplacementTransaction(input, tables),
          ),
        ),
      );
    },
    async reserveSession(input) {
      const transaction = buildSessionReservationTransaction(input, tables);
      try {
        await client.send(new TransactWriteItemsCommand(transaction));
        return { kind: "admitted" };
      } catch (error) {
        return sessionReservationFailure(error, input);
      }
    },
    supportsLocalBootstrap,
    async bootstrapLocal(input) {
      if (!(await supportsLocalBootstrap()))
        throw new Error("Local bootstrap requires explicit local storage");
      const transaction = buildLocalBootstrapTransaction(input, tables);
      return conditional(() =>
        client.send(new TransactWriteItemsCommand(transaction)),
      );
    },
    async getRecord(pk, sk) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.deploymentControl,
          Key: marshall({ pk, sk }),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? parseDeploymentControlRecord(unmarshall(result.Item))
        : undefined;
    },
    async initializeControl(record) {
      controlRecordSchema.parse(record);
      if (
        record.runtimeEnvironment === "local" &&
        !(await supportsLocalBootstrap())
      )
        throw new Error("Local control requires explicit local storage");
      return conditional(() =>
        client.send(
          new PutItemCommand({
            TableName: tables.deploymentControl,
            Item: marshall(record),
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        ),
      );
    },
    writeRuntime(record) {
      runtimeRecordSchema.parse(record);
      const retirement = retirementSnapshotCondition(record);
      return conditional(() =>
        client.send(
          new PutItemCommand({
            TableName: tables.deploymentControl,
            Item: marshall(record, { removeUndefinedValues: true }),
            ConditionExpression: `attribute_not_exists(pk) OR (#identity = :identity AND authorizedGeneration = :generation AND #role = :role AND ${retirement.condition})`,
            ExpressionAttributeNames: {
              "#identity": "identity",
              "#role": "role",
            },
            ExpressionAttributeValues: marshall({
              ":identity": record.identity,
              ":generation": record.authorizedGeneration,
              ":role": record.role,
              ...retirement.values,
            }),
          }),
        ),
      );
    },
    requestRetirement: (input) =>
      conditional(() =>
        client.send(
          new TransactWriteItemsCommand(
            buildRuntimeRetirementRequest(input, tables),
          ),
        ),
      ),
    transitionRuntimeRole: (input) =>
      conditional(() =>
        client.send(
          new TransactWriteItemsCommand(
            buildRuntimeRoleTransition(input, tables),
          ),
        ),
      ),
    async writeVoice(record, expected) {
      voiceRecordSchema.parse(record);
      if (
        expected &&
        expected.attemptId !== record.attemptId &&
        expected.state !== "settled"
      )
        return "stale";
      return conditional(() =>
        client.send(
          new PutItemCommand({
            TableName: tables.deploymentControl,
            Item: marshall(record),
            ConditionExpression: expected
              ? "attemptId = :attempt AND #state = :state AND ownerInstanceId = :owner AND meetingId = :meeting"
              : "attribute_not_exists(pk)",
            ...(expected
              ? {
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: marshall({
                    ":attempt": expected.attemptId,
                    ":state": expected.state,
                    ":owner": expected.ownerInstanceId,
                    ":meeting": expected.meetingId,
                  }),
                }
              : {}),
          }),
        ),
      );
    },
    writeSuppression({ record, expectedVersion, authority }) {
      suppressionRecordSchema.parse(record);
      if (
        authority.kind === "session" &&
        (authority.ownership.guildId !== record.guildId ||
          (record.suppressed &&
            authority.ownership.meetingId !== record.meetingId))
      )
        throw new Error("Suppression session identity mismatch");
      if (record.version !== (expectedVersion ?? 0) + 1)
        throw new Error("Invalid suppression version");
      return conditional(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              ...buildWorkAdmissionChecks(authority, tables),
              {
                Put: {
                  TableName: tables.deploymentControl,
                  Item: marshall(record),
                  ConditionExpression:
                    expectedVersion === undefined
                      ? "attribute_not_exists(pk)"
                      : "#version = :version",
                  ...(expectedVersion === undefined
                    ? {}
                    : {
                        ExpressionAttributeNames: { "#version": "version" },
                        ExpressionAttributeValues: marshall({
                          ":version": expectedVersion,
                        }),
                      }),
                },
              },
            ],
          }),
        ),
      );
    },
    async checkAdmission(context, scope) {
      const result = await conditional(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: buildRuntimeAdmissionChecks(context, tables, scope),
          }),
        ),
      );
      return result === "applied"
        ? { kind: "admitted" }
        : { kind: "blocked", reason: "not_serving" };
    },
    promote: (input) =>
      conditional(() =>
        client.send(
          new TransactWriteItemsCommand(
            buildPromotionTransaction({ ...input, tables }),
          ),
        ),
      ),
    createInitialMeetingHistory: (history) =>
      conditional(() =>
        client.send(
          new PutItemCommand(buildInitialMeetingHistoryPut(history, tables)),
        ),
      ),
    transitionMeetingHistory: (input) =>
      conditional(() =>
        input.completionPolicyProof ||
        input.recordingDelivery ||
        input.initialTerminalDisposition ||
        input.terminalPreservation ||
        input.checkpointPublication
          ? client.send(
              new TransactWriteItemsCommand(
                buildOwnedCheckpointTransition(input, tables),
              ),
              { abortSignal: input.signal },
            )
          : client.send(
              new UpdateItemCommand(buildHistoryTransition(input, tables)),
              { abortSignal: input.signal },
            ),
      ),
    async listPendingRecordingRecoveries(guildId) {
      const rows: MeetingHistory[] = [];
      let cursor: QueryCommandOutput["LastEvaluatedKey"];
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: tables.meetingHistory,
            ConsistentRead: true,
            KeyConditionExpression: "guildId = :guild",
            ExpressionAttributeValues: marshall({ ":guild": guildId }),
            ExclusiveStartKey: cursor,
          }),
        );
        rows.push(
          ...(page.Items ?? [])
            .map((item) => unmarshall(item) as MeetingHistory)
            .filter(isPendingRecordingRecovery),
        );
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return rows;
    },
    async getMeetingHistory(key, signal) {
      signal?.throwIfAborted();
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.meetingHistory,
          Key: marshall(key),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingHistory)
        : undefined;
    },
  };
}

const mockReservationRequests = new WeakMap<
  Map<string, DeploymentControlRecord>,
  Map<string, SessionReservationInput>
>();

export function mockWorkAdmissionAllowed(
  authority: WorkAdmissionAuthority,
  records: Map<string, DeploymentControlRecord>,
  leases: Map<string, ActiveMeetingLease>,
  scope: NewWorkScope = { kind: "ordinary" },
): boolean {
  if (authority.kind === "session") {
    const owner = authority.ownership;
    const lease = leases.get(owner.guildId);
    return Boolean(
      lease &&
      lease.meetingId === owner.meetingId &&
      lease.ownerInstanceId === owner.ownerInstanceId &&
      lease.executionVersion === owner.executionVersion &&
      lease.voiceOperationAttemptId === owner.voiceOperationAttemptId &&
      lease.leaseExpiresAt >= authority.now,
    );
  }
  const { context } = authority;
  admissionContextSchema.parse(context);
  newWorkScopeSchema.parse(scope);
  const control = records.get(JSON.stringify(["ENV", "CONTROL"]));
  const row = records.get(
    JSON.stringify(["ENV", `RUNTIME#${context.instanceId}`]),
  );
  if (control?.recordType !== "control" || row?.recordType !== "runtime")
    return false;
  return (
    mockMaintenanceAllows(control, scope, records) &&
    mockServingAdmissionAllowed(control, row, context)
  );
}
function repeatedReservationResult(
  previous: SessionReservationInput,
  input: SessionReservationInput,
): SessionReservationWriteResult {
  return isDeepStrictEqual(previous, structuredClone(input))
    ? { kind: "admitted" }
    : { kind: "blocked", reason: "unavailable" };
}
function matchesPromotionControl(
  control: ControlRecord,
  input: PromotionInput,
) {
  return (
    control.runtimeEnvironment === input.candidate.kind &&
    control.coordinatorEpoch === input.coordinatorEpoch &&
    control.coordinatorToken === input.coordinatorToken &&
    control.coordinatorExpiresAt > input.now &&
    control.servingGeneration === input.expectedServingGeneration &&
    Object.keys(control.servingMembers).length ===
      input.expectedServingMembers.length &&
    input.expectedServingMembers.every(
      (identity) =>
        control.servingMembers[identity.instanceId] &&
        sameRuntimeIdentity(
          control.servingMembers[identity.instanceId],
          identity,
        ),
    )
  );
}

function retainedRuntimesReady(
  retained: Array<RuntimeRecord | undefined>,
  input: PromotionInput,
) {
  return retained.every(
    (row, index) =>
      row &&
      row.role === "serving" &&
      row.authorizedGeneration === input.expectedServingGeneration &&
      sameRuntimeIdentity(row.identity, (input.retainedMembers ?? [])[index]) &&
      proofReady(
        row,
        input.coordinatorEpoch,
        input.expectedServingGeneration,
        input.now,
      ),
  );
}

function suppressionAllowsReservation(
  row: DeploymentControlRecord | undefined,
  expectedVersion?: number,
): boolean {
  if (expectedVersion === undefined) return !row;
  return (
    row?.recordType === "suppression" &&
    row.version === expectedVersion &&
    !row.suppressed
  );
}
export function createMockDeploymentControlRepository(
  records = new Map<string, DeploymentControlRecord>(),
  histories = new Map<string, MeetingHistory[]>(),
  leases = new Map<string, ActiveMeetingLease>(),
  uploads = new Map<string, PersonalMediaUploadJobRecord>(),
): DeploymentControlRepository {
  const requests =
    mockReservationRequests.get(records) ??
    new Map<string, SessionReservationInput>();
  mockReservationRequests.set(records, requests);
  const recordKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);
  const getControl = () => {
    const row = records.get(recordKey("ENV", "CONTROL"));
    return row?.recordType === "control" ? row : undefined;
  };
  const getRuntime = (instance: string) => {
    const row = records.get(recordKey("ENV", `RUNTIME#${instance}`));
    return row?.recordType === "runtime" ? row : undefined;
  };
  const getHistory = (key: HistoryKey) =>
    histories
      .get(key.guildId)
      ?.find((row) => row.channelId_timestamp === key.channelId_timestamp);
  const store = (record: DeploymentControlRecord): ConditionalResult => {
    records.set(recordKey(record.pk, record.sk), structuredClone(record));
    return "applied";
  };

  return {
    async installPausedDesktopDrafts(input) {
      buildPausedDesktopDraftInstallationTransaction(input, {
        deploymentControl: "mock",
        meetingHistory: "mock",
        personalMediaUpload: "mock",
      });
      if (
        !isDeepStrictEqual(getControl(), input.control) ||
        input.pairs.some(
          ({ record, expectedParent }) =>
            records.has(recordKey(record.pk, record.sk)) ||
            !isDeepStrictEqual(
              uploads.get(expectedParent.uploadId),
              expectedParent,
            ),
        )
      )
        return "stale";
      input.pairs.forEach(({ record }) => store(record));
      return "applied";
    },
    ...createMockRecoveryRepository(
      records,
      histories,
      leases,
      (context, grant) => {
        if (!grant)
          return mockWorkAdmissionAllowed(
            { kind: "serving", context },
            records,
            leases,
          );
        const control = getControl();
        const runtime = getRuntime(context.instanceId);
        return Boolean(
          control &&
          runtime &&
          mockServingAdmissionAllowed(control, runtime, context) &&
          consumedFixtureMatches(
            control.maintenance,
            records.get(recordKey(grant.pk, grant.sk)),
            grant,
          ),
        );
      },
    ),
    async reserveSession(input) {
      buildSessionReservationTransaction(input, {
        deploymentControl: "mock",
        meetingHistory: "mock",
        activeMeeting: "mock",
      });
      const previous = requests.get(input.requestToken);
      if (previous) return repeatedReservationResult(previous, input);
      const { context, lease, voice, history, suppression } = input;
      if (
        !mockWorkAdmissionAllowed(
          { kind: "serving", context },
          records,
          leases,
          input.scope,
        )
      )
        return { kind: "blocked", reason: "not_serving" };
      const existingVoice = records.get(recordKey(voice.pk, voice.sk));
      if (
        existingVoice &&
        (existingVoice.recordType !== "voice" ||
          existingVoice.state !== "settled")
      )
        return { kind: "blocked", reason: "voice_uncertain" };
      const existingLease = leases.get(lease.guildId);
      if (
        (existingLease && existingLease.leaseExpiresAt >= context.now) ||
        (history && getHistory(history))
      )
        return { kind: "blocked", reason: "active_session" };
      if (suppression) {
        const row = records.get(
          recordKey(
            `SUPPRESS#${lease.guildId}`,
            `CHANNEL#${suppression.channelId}`,
          ),
        );
        const allowed = suppressionAllowsReservation(
          row,
          suppression.expectedVersion,
        );
        if (!allowed) return { kind: "blocked", reason: "suppressed" };
      }
      consumeMockFixture(input, records);
      leases.set(lease.guildId, structuredClone(lease));
      store(voice);
      if (history)
        histories.set(history.guildId, [
          ...(histories.get(history.guildId) ?? []),
          structuredClone(history),
        ]);
      requests.set(input.requestToken, structuredClone(input));
      return { kind: "admitted" };
    },
    async writeSuppression({ record, expectedVersion, authority }) {
      suppressionRecordSchema.parse(record);
      if (
        authority.kind === "session" &&
        (authority.ownership.guildId !== record.guildId ||
          (record.suppressed &&
            authority.ownership.meetingId !== record.meetingId))
      )
        throw new Error("Suppression session identity mismatch");
      if (record.version !== (expectedVersion ?? 0) + 1)
        throw new Error("Invalid suppression version");
      if (!mockWorkAdmissionAllowed(authority, records, leases)) return "stale";
      const current = records.get(recordKey(record.pk, record.sk));
      if (
        expectedVersion === undefined
          ? Boolean(current)
          : current?.recordType !== "suppression" ||
            current.version !== expectedVersion
      )
        return "stale";
      return store(record);
    },
    async replaceCompatibleRuntime(input) {
      const next = planCompatibleReplacement(input);
      if (
        !isDeepStrictEqual(getControl(), structuredClone(input.control)) ||
        ![input.candidate, ...input.members].every((row) =>
          isDeepStrictEqual(
            getRuntime(row.identity.instanceId),
            structuredClone(row),
          ),
        )
      )
        return "stale";
      store(next.control);
      next.runtimes.forEach(store);
      return "applied";
    },
    supportsLocalBootstrap: async () => true,
    async bootstrapLocal(input) {
      const next = planLocalBootstrap(input);
      if (
        !isDeepStrictEqual(getControl(), structuredClone(input.control)) ||
        ![input.candidate, ...input.members].every((row) =>
          isDeepStrictEqual(
            getRuntime(row.identity.instanceId),
            structuredClone(row),
          ),
        )
      )
        return "stale";
      store(next.control);
      next.authorized.forEach(store);
      return "applied";
    },
    async getRecord(pk, sk) {
      const row = records.get(recordKey(pk, sk));
      return row
        ? structuredClone(parseDeploymentControlRecord(row))
        : undefined;
    },
    async initializeControl(record) {
      controlRecordSchema.parse(record);
      return getControl() ? "stale" : store(record);
    },
    async writeRuntime(record) {
      runtimeRecordSchema.parse(record);
      const existing = getRuntime(record.identity.instanceId);
      if (
        existing &&
        (!sameRuntimeIdentity(existing.identity, record.identity) ||
          existing.authorizedGeneration !== record.authorizedGeneration ||
          existing.role !== record.role ||
          !isDeepStrictEqual(
            existing.retirementRequest,
            record.retirementRequest,
          ) ||
          !isDeepStrictEqual(
            existing.retirementAcknowledgment,
            record.retirementAcknowledgment,
          ))
      )
        return "stale";
      return store(record);
    },
    async requestRetirement(input) {
      buildRuntimeRetirementRequest(input, {
        deploymentControl: "fixture",
        meetingHistory: "fixture",
      });
      const control = getControl();
      const existing = getRuntime(input.record.identity.instanceId);
      if (
        !control ||
        control.coordinatorToken !== input.request.coordinatorToken ||
        control.coordinatorEpoch !== input.request.coordinatorEpoch ||
        control.coordinatorExpiresAt <= input.now ||
        control.servingMembers[input.record.identity.instanceId] ||
        !existing ||
        !sameRuntimeIdentity(existing.identity, input.record.identity) ||
        existing.authorizedGeneration !== input.record.authorizedGeneration ||
        existing.role !== input.record.role ||
        !isDeepStrictEqual(
          existing.retirementRequest,
          input.record.retirementRequest,
        ) ||
        !isDeepStrictEqual(
          existing.retirementAcknowledgment,
          input.record.retirementAcknowledgment,
        )
      )
        return "stale";
      return store({ ...existing, retirementRequest: input.request });
    },
    async transitionRuntimeRole(input) {
      validateRuntimeRoleTransition(input);
      const control = getControl();
      const row = getRuntime(input.record.identity.instanceId);
      if (
        !control ||
        control.coordinatorEpoch !== input.retirementEpoch ||
        (input.expectedRetirementRequest &&
          control.coordinatorToken !==
            input.expectedRetirementRequest.coordinatorToken) ||
        control.servingMembers[input.record.identity.instanceId] ||
        !row ||
        !sameRuntimeIdentity(row.identity, input.record.identity) ||
        row.role !== input.expectedRole ||
        row.authorizedGeneration !== input.expectedGeneration ||
        !isDeepStrictEqual(
          row.retirementRequest,
          input.expectedRetirementRequest,
        ) ||
        !isDeepStrictEqual(
          row.retirementAcknowledgment,
          input.expectedRetirementAcknowledgment,
        )
      )
        return "stale";
      return store(input.record);
    },
    async writeVoice(record, expected) {
      voiceRecordSchema.parse(record);
      if (
        expected &&
        expected.attemptId !== record.attemptId &&
        expected.state !== "settled"
      )
        return "stale";
      const existing = records.get(recordKey(record.pk, record.sk));
      if (
        expected
          ? existing?.recordType !== "voice" ||
            existing.attemptId !== expected.attemptId ||
            existing.state !== expected.state ||
            existing.ownerInstanceId !== expected.ownerInstanceId ||
            existing.meetingId !== expected.meetingId
          : Boolean(existing)
      )
        return "stale";
      return store(record);
    },
    async checkAdmission(context, scope) {
      return mockWorkAdmissionAllowed(
        { kind: "serving", context },
        records,
        leases,
        scope,
      )
        ? { kind: "admitted" }
        : { kind: "blocked", reason: "not_serving" };
    },
    async promote(input) {
      promotionInputSchema.parse(input);
      const control = getControl();
      const candidate = getRuntime(input.candidate.instanceId);
      const retained = (input.retainedMembers ?? []).map((identity) =>
        getRuntime(identity.instanceId),
      );
      if (
        !control ||
        !candidate ||
        !matchesPromotionControl(control, input) ||
        !retainedRuntimesReady(retained, input) ||
        candidate.role !== "candidate" ||
        candidate.retirementRequest !== undefined ||
        candidate.retirementAcknowledgment !== undefined ||
        candidate.readiness.runtimeMode !== input.candidateRuntimeMode ||
        !sameRuntimeIdentity(candidate.identity, input.candidate) ||
        !proofReady(
          candidate,
          input.coordinatorEpoch,
          input.expectedServingGeneration,
          input.now,
        )
      )
        return "stale";
      store({
        ...control,
        servingGeneration: input.proposedGeneration,
        servingMembers: Object.fromEntries(
          [input.candidate, ...(input.retainedMembers ?? [])].map(
            (identity) => [identity.instanceId, identity],
          ),
        ),
      });
      store({
        ...candidate,
        role: "serving",
        authorizedGeneration: input.proposedGeneration,
        readiness: {
          ...candidate.readiness,
          observedGeneration: input.proposedGeneration,
        },
      });
      for (const row of retained) {
        if (!row) throw new Error("Retained runtime disappeared");
        store({
          ...row,
          authorizedGeneration: input.proposedGeneration,
          readiness: {
            ...row.readiness,
            observedGeneration: input.proposedGeneration,
          },
        });
      }
      return "applied";
    },
    async createInitialMeetingHistory(history) {
      buildInitialMeetingHistoryPut(history, {
        deploymentControl: "mock",
        meetingHistory: "mock",
      });
      if (getHistory(history)) return "stale";
      histories.set(history.guildId, [
        ...(histories.get(history.guildId) ?? []),
        structuredClone(history),
      ]);
      return "applied";
    },
    async transitionMeetingHistory(input) {
      input.signal?.throwIfAborted();
      buildHistoryTransition(input, {
        deploymentControl: "mock",
        meetingHistory: "mock",
      });
      const row = getHistory(input.key);
      if (!checkpointLeaseAllowed(input, records, leases)) return "stale";
      if (!matchesOwnedHistoryTransition(row, input)) return "stale";
      applyMockOwnedHistoryTransition(row, input);
      return "applied";
    },
    async listPendingRecordingRecoveries(guildId) {
      return structuredClone(
        (histories.get(guildId) ?? []).filter(isPendingRecordingRecovery),
      );
    },
    async getMeetingHistory(key, signal) {
      signal?.throwIfAborted();
      const row = getHistory(key);
      return row ? structuredClone(row) : undefined;
    },
  };
}

/** A candidate is not a claim or permission to join voice. Legacy rows are untouched. */
export function isPendingRecordingRecovery(row: MeetingHistory): boolean {
  const recovery = recoveryDispositionSchema.safeParse(row.recovery);
  const checkpoint = recordingCheckpointSchema.safeParse(row.checkpoint);
  if (!recovery.success || !checkpoint.success) return false;
  return (
    ["interrupted", "failed"].includes(row.status ?? "") &&
    recovery.data.disposition === "pending" &&
    recovery.data.attempt < recovery.data.retry.maxAttempts &&
    recovery.data.executionVersion === row.executionVersion &&
    row.ownerInstanceId !== undefined &&
    checkpoint.data.capture.meetingId === row.meetingId &&
    checkpoint.data.capture.guildId === row.guildId &&
    checkpoint.data.capture.channelId_timestamp === row.channelId_timestamp
  );
}

function checkpointLeaseAllowed(
  input: HistoryTransition,
  records: Map<string, DeploymentControlRecord>,
  leases: Map<string, ActiveMeetingLease>,
) {
  const proof =
    input.completionPolicyProof ??
    input.recordingDelivery ??
    input.initialTerminalDisposition ??
    input.terminalPreservation ??
    input.checkpointPublication;
  return (
    !proof ||
    (leases.get(proof.ownership.guildId)?.sessionMode === "meeting" &&
      mockWorkAdmissionAllowed(
        { kind: "session", ownership: proof.ownership, now: proof.now },
        records,
        leases,
      ))
  );
}
