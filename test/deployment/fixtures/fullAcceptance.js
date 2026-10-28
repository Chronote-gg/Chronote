import process from "node:process";
import { Buffer } from "node:buffer";
import { jest, expect, afterEach } from "@jest/globals";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { productionOrchestrationFixture } from "./productionOrchestration.js";
import {
  preparePausedAcceptance,
  originalRunCallerIdentity,
  assertPausedOriginalRows,
  seedPausedOriginalRows,
  attachPausedReaders,
  runFullIntroduction,
  prepareFullPausedCollector,
  assertPausedObjectOperations,
  pausedAcceptanceResult,
  assertPausedFinalTransaction,
} from "./fullPausedAcceptance.js";
import { consumeMaximumRenewals } from "./maximumIntroductionRenewals.js";
import { hostedAcceptance } from "./productionAcceptanceHosted.js";
import {
  sourceTransport,
  readStaticCredentialSource,
  readOidcOnlySource,
} from "../../fixtures/productionReviewedSource.js";
import { contentFixture } from "../../fixtures/productionFixtureContent.js";
import {
  createIntroductionTable,
  putIntroductionDocument as put,
  readIntroductionDocument as read,
} from "./introductionStore";
import { loadProductionPackage } from "../../../scripts/deployment/production-private-package.cjs";
import { verifyDeclaredRoutes } from "../../../scripts/deployment/production-source-routes.cjs";
import {
  collectLauncherSettingsFromOriginalRun,
  readLauncherSettings,
} from "../../../scripts/deployment/production-launcher-settings.cjs";
import {
  collectAcceptanceFromOriginalRun,
  readAcceptance,
} from "../../../scripts/deployment/production-acceptance-collector.cjs";
import { dispatchAcceptance } from "../../../scripts/deployment/accept-production.cjs";
const mockProductionClients = [];
let mockAfterProductionSend = async () => undefined;
afterEach(() => {
  sourceTransport.read = readOidcOnlySource;
  jest.restoreAllMocks();
  for (const client of mockProductionClients.splice(0)) client.destroy();
  mockCli.mockReset();
  mockExec.mockReset();
  mockS3.mockReset();
  mockAfterProductionSend = async () => undefined;
});
const mockCli = jest.fn(),
  mockExec = jest.fn(),
  mockS3 = jest.fn();
jest.mock("../../../scripts/deployment/coordinator-aws.cjs", () => ({
  ...jest.requireActual("../../../scripts/deployment/coordinator-aws.cjs"),
  awsCli: (...args) => mockCli(...args),
}));
jest.mock("node:child_process", () => {
  const execFile = () => undefined;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
    mockExec(...args);
  return {
    ...jest.requireActual("node:child_process"),
    execFile,
    execFileSync: jest.fn((_file, args) =>
      args[0] === "rev-parse" ? "a".repeat(40) : "",
    ),
  };
});
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const { env } = jest.requireActual("node:process");
  return {
    ...actual,
    DynamoDBClient: jest.fn((settings) => {
      const client = new actual.DynamoDBClient({
        ...settings,
        endpoint: env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
        region: "local",
        credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
        maxAttempts: 1,
      });
      if (!settings.endpoint) {
        mockProductionClients.push(client);
        const send = client.send.bind(client);
        client.send = async (command) => {
          const response = await send(command);
          await mockAfterProductionSend(command);
          return response;
        };
      }
      return client;
    }),
  };
});
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn((settings) => ({
    ...jest
      .requireActual("../../fixtures/productionProviderFixtures.js")
      .s3Transport(mockS3, settings),
    config: {
      maxAttempts: async () => settings.maxAttempts ?? 1,
      region: async () => settings.region,
    },
  })),
}));
// Node's native structuredClone returns outer-realm objects under Jest. Rebuild
// synthetic values in the test realm so production deep equality remains exact.
function cloneInTestRealm(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneInTestRealm);
  if (value instanceof Map)
    return new Map(
      [...value].map(([key, item]) => [key, cloneInTestRealm(item)]),
    );
  if (value instanceof Set) return new Set([...value].map(cloneInTestRealm));
  if (ArrayBuffer.isView(value)) return Buffer.from(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneInTestRealm(item)]),
  );
}
async function assertFinalFault({
  fault,
  purpose,
  f,
  table,
  collect,
  invocations,
}) {
  if (fault === "static-route") {
    const beforeHold = await read(table, { pk: "ENV", sk: "INTRODUCTION" });
    const beforeControl = await read(table, { pk: "ENV", sk: "CONTROL" });
    sourceTransport.read = readStaticCredentialSource;
    expect(() => verifyDeclaredRoutes(f.binding)).toThrow(
      "unaccounted_static_credential_route",
    );
    await expect(collect()).rejects.toThrow("fixture_content_refused");
    expect(await read(table, { pk: "ENV", sk: "INTRODUCTION" })).toEqual(
      beforeHold,
    );
    expect(await read(table, { pk: "ENV", sk: "CONTROL" })).toEqual(
      beforeControl,
    );
    expect(
      await read(table, {
        pk: `INTRODUCTION#${f.m.introductionId}`,
        sk: `ACTION#${f.m.actions.find((action) => action.purpose === purpose).actionId}`,
      }),
    ).toBeUndefined();
    expect(invocations()).toBe(0);
    return;
  }
  const { token, value } = await collect();
  if (fault === "expiry-before-dispatch") f.state.time = f.m.validUntil;
  if (fault === "paused-marker-after-collect") {
    const marker = await read(table, { pk: "UPLOAD#one", sk: "PAUSED_DRAFT" });
    await put(table, { ...marker, createdAt: marker.createdAt + 1 });
  }
  if (fault === "late-ack") await dispatchAcceptance(token);
  else await expect(dispatchAcceptance(token)).rejects.toThrow();
  const journal = await read(table, {
    pk: value.history.authority.pk,
    sk: `ACTION#${value.stage.action.actionId}`,
  });
  const expectedPhase = {
    "expiry-before-dispatch": undefined,
    "expiry-after-submitted": "submitted",
    "late-ack": "observed",
    "lost-ack": "submitted",
    "paused-marker-after-collect": "submitted",
  }[fault];
  expect(journal?.phase).toBe(expectedPhase);
  expect(invocations()).toBe(["late-ack", "lost-ack"].includes(fault) ? 1 : 0);
  const changed = ["late-ack", "lost-ack"].includes(fault);
  const reopened = purpose !== "persist_acceptance" && changed;
  const released = purpose === "release_deployment" && changed;
  const hold = await read(table, { pk: "ENV", sk: "INTRODUCTION" });
  expect(hold.admission.state).toBe(reopened ? "reopened" : "held");
  expect(hold.deployment.state).toBe(released ? "released" : "held");
  expect(
    Boolean((await read(table, { pk: "ENV", sk: "CONTROL" })).maintenance),
  ).toBe(!reopened);
  await expect(collectAcceptanceFromOriginalRun()).rejects.toThrow();
  await expect(dispatchAcceptance(token)).rejects.toThrow();
  expect(invocations()).toBe(["late-ack", "lost-ack"].includes(fault) ? 1 : 0);
}
function clearEndpointOverrides(env) {
  for (const key of Object.keys(env))
    if (key.startsWith("AWS_ENDPOINT_URL")) delete env[key];
}
export async function fullAcceptance(
  path,
  fault,
  faultPurpose = "persist_acceptance",
  paused = false,
) {
  jest
    .spyOn(globalThis, "structuredClone")
    .mockImplementation(cloneInTestRealm);
  let hosted, prep;
  if (paused) jest.spyOn(Date, "now").mockReturnValue(150000);
  const instanceIds = Object.fromEntries(
    ["bootstrap", "replacement", "handoff"].map((slot) => [slot, randomUUID()]),
  );
  const f = await productionOrchestrationFixture({
    instanceIds,
    recordingDuration: 300,
    configure: async (m) => {
      if (paused) m.operationId = "00000000-0000-4000-8000-000000000001";
      hosted = hostedAcceptance(m);
      if (paused)
        prep = await preparePausedAcceptance(m, hosted, {
          cli: mockCli,
          exec: mockExec,
          s3: mockS3,
        });
    },
  });
  const m = f.m,
    table = m.resources.tables.deploymentControl;
  for (const [name, keys] of Object.entries({
    activeMeeting: ["guildId"],
    personalJob: ["uploadId"],
    personalSegment: ["uploadId", "segmentKey"],
    notion: ["pk", "sk"],
    stripeWebhook: ["eventId"],
    guildSubscription: ["guildId"],
  }))
    await createIntroductionTable(m.resources.tables[name], keys);
  await seedPausedOriginalRows(prep, m, put);
  const env = { ...process.env, ...hosted.env };
  clearEndpointOverrides(env);
  jest.replaceProperty(process, "env", env);
  jest.spyOn(Date, "now").mockImplementation(() => f.state.time * 1000);
  f.options.nowMilliseconds = () => f.state.time * 1000;
  f.state.timed = true;
  mockCli.mockImplementation(async (service, operation, input, settings) => {
    if (service === "sts") {
      const arn = (session) =>
        `arn:aws:sts::${m.identity.accountId}:assumed-role/acceptance-reader/${session}`;
      if (operation === "get-caller-identity")
        return originalRunCallerIdentity(m, f.binding, env.GITHUB_JOB);
      if (operation === "assume-role")
        return {
          AssumedRoleUser: { Arn: arn(input.RoleSessionName) },
          Credentials: {
            AccessKeyId: input.RoleSessionName,
            SecretAccessKey: "dummy",
            SessionToken: "dummy",
            Expiration: new Date((f.state.time + 900) * 1000).toISOString(),
          },
        };
      throw Error("Unexpected STS transport");
    }
    if (service === "iam")
      return hosted.launcher.aws(service, operation, input);
    const raw = await f.options.aws(service, operation, input);
    if (settings?.query?.startsWith("{items:tasks"))
      return {
        items: raw.tasks.map(
          ({
            taskArn,
            taskDefinitionArn,
            group,
            lastStatus,
            desiredStatus,
            containers,
          }) => ({
            taskArn,
            taskDefinitionArn,
            group,
            lastStatus,
            desiredStatus,
            containers,
          }),
        ),
        failures: raw.failures,
      };
    if (settings?.query?.startsWith("{items:services"))
      return {
        items: raw.services.map(
          ({ serviceArn, desiredCount, runningCount, pendingCount }) => ({
            serviceArn,
            desiredCount,
            runningCount,
            pendingCount,
          }),
        ),
        failures: raw.failures,
      };
    if (
      operation === "describe-target-health" &&
      settings?.query?.startsWith("TargetHealthDescriptions")
    )
      return raw.TargetHealthDescriptions.map((t) => ({
        targetId: t.Target.Id,
        state: t.TargetHealth.State,
      }));
    return raw;
  });
  mockExec.mockImplementation(async (file, args, settings) => {
    if (prep && args[1].endsWith("/zip"))
      return { stdout: prep.state.archive, stderr: "" };
    return {
      stdout: JSON.stringify(
        file === "gh"
          ? await hosted.github(args[1], args[3])
          : {
              Account: m.identity.accountId,
              Arn: `arn:aws:sts::${m.identity.accountId}:assumed-role/acceptance-reader/${settings.env.AWS_ACCESS_KEY_ID}`,
            },
      ),
      stderr: "",
    };
  });
  const initial = await loadProductionPackage(process.env, mockCli);
  expect(initial.binding).toEqual(f.binding);
  f.options.launcherSettingsToken =
    await collectLauncherSettingsFromOriginalRun();
  f.options.launcherBaseline = readLauncherSettings(
    f.options.launcherSettingsToken,
    f.binding,
  );
  const initializationRequests = attachPausedReaders(f, initial, prep, fault);
  consumeMaximumRenewals(f);
  if (
    await runFullIntroduction(
      f,
      path,
      fault,
      prep,
      initializationRequests,
      read,
    )
  )
    return { initializationRefused: true };
  const completeAt = f.state.time;
  await f.options.sleep(400000);
  const records = f.state.recordings;
  const owners = [
    instanceIds[path === "repair" ? "replacement" : "bootstrap"],
    instanceIds.handoff,
  ];
  const content = contentFixture({
    binding: f.binding,
    ownerIds: owners,
    firstOffsetSeconds: records[0].startedAt - 100,
    secondOffsetSeconds: records[1].startedAt - 100,
  });
  for (const fixture of content.fixtures) {
    await put(table, fixture.grant);
    await put(m.resources.tables.meetingHistory, {
      ...fixture.history,
      notes: fixture.notes,
    });
    await put(m.resources.tables.meetingControl, {
      requestId: fixture.grant.commandId,
      queueStatus: "completed",
      commandType: "start_meeting",
      expiresAt: completeAt + 180,
    });
  }
  hosted.state.mode = "accept";
  hosted.state.repair = path === "repair";
  hosted.state.endedAt = completeAt;
  hosted.state.supplement = {
    ...content.supplement,
    reviewedAt: new Date((f.state.time - 1) * 1000).toISOString(),
  };
  env.GITHUB_JOB = "accept";
  env.INTRODUCTION_SUPPLEMENT_COMMIT = "c".repeat(40);
  env.INTRODUCTION_SUPPLEMENT_HASH = createHash("sha256")
    .update(JSON.stringify(hosted.state.supplement))
    .digest("hex");
  mockS3.mockImplementation(async (command) => {
    if (
      prep &&
      (command.input.Bucket === prep.request.storeBinding.bucket ||
        !command.input.Key ||
        command.input.Key.startsWith("personal-media-uploads/"))
    )
      return prep.send(command);
    const object = content.objects.get(command.input.Key);
    if (!object) throw Error("Unexpected content key");
    const metadata = {
      ContentLength: object.bytes.length,
      VersionId: object.versionId,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: m.acceptance.storageKeyArn,
      BucketKeyEnabled: false,
    };
    return command.constructor.name === "HeadObjectCommand"
      ? metadata
      : { ...metadata, Body: Readable.from([object.bytes]) };
  });
  await prepareFullPausedCollector(prep, env, m, read);
  let finalInvocations = 0,
    currentPurpose;
  mockAfterProductionSend = async (command) => {
    if (command.constructor.name !== "TransactWriteItemsCommand") return;
    assertPausedFinalTransaction(prep, path, m, command.input);
    if (currentPurpose !== faultPurpose) return;
    const items = command.input.TransactItems;
    const submitted = items.some(
      (item) => item.Put?.Item.phase?.S === "submitted",
    );
    if (submitted && fault === "expiry-after-submitted")
      f.state.time = m.validUntil;
    if (items.length <= 3) return;
    finalInvocations++;
    if (fault === "late-ack") f.state.time = m.validUntil;
    if (fault === "lost-ack")
      throw Error("transport ACK lost after native commit");
  };
  const collect = async (purpose) => {
    const token = await collectAcceptanceFromOriginalRun(),
      value = readAcceptance(token);
    expect(value.stage.action.purpose).toBe(purpose);
    expect(value.history.entries.length).toBe(path === "normal" ? 95 : 107);
    for (const copy of [{ ...token }, structuredClone(token)])
      expect(() => readAcceptance(copy)).toThrow();
    return { token, value };
  };
  for (const purpose of [
    "persist_acceptance",
    "reopen_admission",
    "release_deployment",
  ]) {
    currentPurpose = purpose;
    if (fault && purpose === faultPurpose) {
      await assertFinalFault({
        fault,
        purpose,
        f,
        table,
        collect: () => collect(purpose),
        invocations: () => finalInvocations,
      });
      return;
    }
    const { token } = await collect(purpose);
    await dispatchAcceptance(token);
    await assertPausedOriginalRows(prep, m, read);
  }
  expect(
    (await read(table, { pk: "ENV", sk: "INTRODUCTION" })).deployment.state,
  ).toBe("released");
  expect(
    (await read(table, { pk: "ENV", sk: "CONTROL" })).maintenance,
  ).toBeUndefined();
  assertPausedObjectOperations(prep, mockS3.mock.calls);
  jest.restoreAllMocks();
  mockCli.mockReset();
  mockExec.mockReset();
  mockS3.mockReset();
  return pausedAcceptanceResult(prep);
}
