/** @jest-environment node */
import {
  mockPreparationAws as mockAws,
  mockPreparationS3 as mockSend,
} from "../fixtures/productionPreparationTransport.js";
import { expect, test, jest, afterEach } from "@jest/globals";
import { fixture, bound } from "../fixtures/productionManifest.js";
import { pausedPreparationFixture } from "../fixtures/productionPausedPreparation.js";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { zipSync, strToU8 } from "fflate";
import process from "node:process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { prepareOriginalPausedDrafts } from "../../scripts/deployment/production-paused-preparation.cjs";
import {
  authenticateOriginalPausedPreparation,
  readAuthenticatedPausedPreparation,
} from "../../scripts/deployment/production-paused-draft-binding.cjs";
import { requestSchema } from "../../scripts/deployment/production-paused-contract.cjs";
const mockGithub = jest.fn(),
  mockExec = jest.fn();
jest.mock("../../scripts/deployment/production-private-package.cjs", () => ({
  githubJson: (...args) => mockGithub(...args),
  readCollectionBinding: () => {
    throw Error("invalid collection");
  },
}));
jest.mock("node:child_process", () =>
  jest
    .requireActual("../fixtures/productionProcessMock.js")
    .processModuleMock((...args) => mockExec(...args), {}),
);
const oldEnv = process.env;
afterEach(() => {
  process.env = oldEnv;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
function setup() {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const m = fixture();
  m.operationId = "00000000-0000-4000-8000-000000000001";
  m.identity.repository = "Chronote-gg/Chronote";
  m.identity.workflow = `Chronote-gg/Chronote/.github/workflows/introduce-production.yml@${m.identity.ref}`;
  const f = pausedPreparationFixture(m);
  process.env = { ...f.env };
  mockGithub.mockImplementation(f.github);
  mockAws.mockImplementation(f.aws);
  mockSend.mockImplementation(f.send);
  mockExec.mockImplementation(async () => ({ stdout: f.state.archive }));
  return { m, ...f };
}

async function assertRefusedWithoutCapture() {
  await expect(prepareOriginalPausedDrafts()).rejects.toThrow();
  expect(
    mockSend.mock.calls.some(
      ([cmd]) => cmd.constructor.name === "PutObjectCommand",
    ),
  ).toBe(false);
}

test("original preparation request refuses a fabricated request before acquisition", () => {
  expect(() => requestSchema.parse({ verified: true })).toThrow();
});

test("actual no-argument producer stores structural capture, sanitizes ZIP receipt, and authenticates original consumer", async () => {
  const f = setup(),
    receipt = await prepareOriginalPausedDrafts(),
    declaration = f.finish(receipt);
  expect(f.state.capture.toString()).not.toContain("PRIVATE SENTINEL");
  expect(JSON.stringify(receipt)).not.toContain("owner");
  const originalCalls = mockSend.mock.calls.filter(
    ([cmd]) => cmd.input.Bucket === f.request.scope.bucket,
  );
  expect(
    originalCalls.filter(
      ([cmd]) => cmd.constructor.name === "HeadObjectCommand",
    ),
  ).toHaveLength(4);
  expect(
    originalCalls.every(
      ([cmd]) =>
        !["GetObjectCommand", "PutObjectCommand"].includes(
          cmd.constructor.name,
        ),
    ),
  ).toBe(true);
  const evidence = {
    retainedDisposition: { pausedDesktopDrafts: declaration },
  };
  f.m.prerequisites.retainedDisposition = canonicalHash(
    evidence.retainedDisposition,
  );
  const token = await authenticateOriginalPausedPreparation(
    bound(f.m),
    evidence,
    "synthetic-github",
  );
  expect(
    readAuthenticatedPausedPreparation(token).capture.parents,
  ).toHaveLength(2);
  expect(readAuthenticatedPausedPreparation(token).request).toEqual(f.request);
  expect(() => readAuthenticatedPausedPreparation({ ...token })).toThrow();
  expect(f.digest(f.state.archive)).not.toBe(declaration.capture.sha256);
});

test.each([
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REPOSITORY_ID",
  "AWS_REGION",
  "PRODUCTION_PAUSED_PREPARATION_ROLE_ARN",
])("wrong %s refuses before draft reads", async (field) => {
  setup();
  process.env[field] = "wrong";
  await expect(prepareOriginalPausedDrafts()).rejects.toThrow();
  expect(mockAws.mock.calls.some(([, op]) => op === "query")).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test("unlisted object reference and forbidden processing state prevent evidence publication", async () => {
  const f = setup();
  f.segments[0].sourceS3Key += "-unlisted";
  await assertRefusedWithoutCapture();
  f.segments[0].sourceS3Key = f.request.sourceObjects[0].key;
  f.parents[0].processingClaimId = "claimed";
  await assertRefusedWithoutCapture();
});

test("lost capture ACK never returns a publishable receipt", async () => {
  const f = setup();
  f.state.lostAck = true;
  await expect(prepareOriginalPausedDrafts()).rejects.toThrow("do not retry");
  expect(f.state.receipt).toBe(null);
});

test("consumer refuses an unfinished producer, modified artifact, or reference", async () => {
  const f = setup(),
    receipt = await prepareOriginalPausedDrafts(),
    declaration = f.finish(receipt);
  const evidence = {
    retainedDisposition: { pausedDesktopDrafts: declaration },
  };
  const authenticate = () => {
    f.m.prerequisites.retainedDisposition = canonicalHash(
      evidence.retainedDisposition,
    );
    return authenticateOriginalPausedPreparation(
      bound(f.m),
      evidence,
      "synthetic-github",
    );
  };
  f.state.completed = false;
  await expect(authenticate()).rejects.toThrow();
  f.state.completed = true;
  f.state.archive = Buffer.from(
    zipSync({
      "preparation.json": [
        strToU8(
          JSON.stringify({ ...receipt, captureSize: receipt.captureSize + 1 }),
        ),
        { mtime: new Date("2026-10-26T00:00:00Z") },
      ],
    }),
  );
  await expect(authenticate()).rejects.toThrow();
  f.finish(receipt);
  declaration.capture = { ...declaration.capture, versionId: "wrong-version" };
  await expect(authenticate()).rejects.toThrow();
});

test.each([
  "GetBucketVersioningCommand",
  "GetPublicAccessBlockCommand",
  "GetBucketEncryptionCommand",
])("invalid capture-store %s prevents publication", async (operation) => {
  const f = setup();
  mockSend.mockImplementation((command) =>
    command.input.Bucket === f.request.storeBinding.bucket &&
    command.constructor.name === operation
      ? {}
      : f.send(command),
  );
  await assertRefusedWithoutCapture();
});

test.each([
  "third-id",
  "source-count",
  "duplicate-source",
  "null-version",
  "wrong-size",
  "wrong-key",
  "incomplete-pages",
])("invalid structural cohort %s cannot publish capture", async (change) => {
  const f = setup();
  if (change === "third-id")
    f.request.cohort.push({ ...f.request.cohort[0], uploadId: "three" });
  if (change === "source-count")
    f.parents[0].sourceManifest.push({
      sourceId: "extra",
      kind: "system_output",
    });
  if (change === "duplicate-source")
    f.parents[0].sourceManifest.push({ ...f.parents[0].sourceManifest[0] });
  if (["null-version", "wrong-size", "wrong-key"].includes(change))
    mockSend.mockImplementation((cmd) => {
      const value = f.send(cmd);
      if (cmd.constructor.name !== "HeadObjectCommand") return value;
      if (change === "null-version") value.VersionId = "null";
      if (change === "wrong-size") value.ContentLength = 11;
      if (change === "wrong-key") value.DeleteMarker = true;
      return value;
    });
  if (change === "incomplete-pages")
    mockAws.mockImplementation((...args) => {
      const value = f.aws(...args);
      if (args[1] === "query")
        value.LastEvaluatedKey = {
          uploadId: { S: args[2].ExpressionAttributeValues[":uploadId"].S },
        };
      return value;
    });
  await assertRefusedWithoutCapture();
});

test("native workflow pins source, dedicated role and session and uploads only sanitized artifact", () => {
  const source = parse(
    readFileSync(
      ".github/workflows/prepare-production-paused-drafts.yml",
      "utf8",
    ),
  );
  expect(source.permissions).toEqual({ contents: "read" });
  expect(Object.keys(source.jobs)).toEqual(["prepare-paused-drafts"]);
  const job = source.jobs["prepare-paused-drafts"];
  expect(job.if).toBe("github.ref == 'refs/heads/master'");
  expect(job.permissions).toEqual({
    contents: "read",
    actions: "read",
    "id-token": "write",
  });
  expect(job.steps[0].with.ref).toBe("${{ github.sha }}");
  expect(
    job.steps.find((s) =>
      s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    ).with,
  ).toMatchObject({
    "role-to-assume": "${{ env.PRODUCTION_PAUSED_PREPARATION_ROLE_ARN }}",
    "role-session-name": "paused-preparation-${{ github.run_id }}-1",
  });
  expect(
    job.steps.find((s) => s.name === "Prepare exact structural cohort").run,
  ).toBe("node scripts/deployment/production-paused-preparation.cjs");
  expect(job.steps.at(-1).with).toEqual({
    name: "paused-draft-preparation",
    path: ".paused-preparation/preparation.json",
    "if-no-files-found": "error",
    "retention-days": 1,
  });
});

test("approved optional checksum predicates keep their source through native preparation", async () => {
  const f = setup();
  const required = {
    ChecksumSHA256: {
      value: "approved-provider-value",
      source: "approved-request",
    },
  };
  f.request.sourceObjects[0].requiredChecksums = required;
  process.env.PAUSED_PREPARATION_REQUEST_SHA256 = canonicalHash(f.request);
  mockSend.mockImplementation((command) =>
    command.constructor.name === "HeadObjectCommand"
      ? {
          ...f.send(command),
          ChecksumSHA256: "approved-provider-value",
          ChecksumType: "FULL_OBJECT",
        }
      : f.send(command),
  );
  await prepareOriginalPausedDrafts();
  expect(
    JSON.parse(f.state.capture.toString()).objects[0].requiredChecksums,
  ).toEqual(required);
  mockSend.mockClear();
  mockSend.mockImplementation(f.send);
  await expect(prepareOriginalPausedDrafts()).rejects.toThrow();
  expect(
    mockSend.mock.calls.some(
      ([command]) => command.constructor.name === "PutObjectCommand",
    ),
  ).toBe(false);
});

test.each(["key", "mode"])(
  "approved source encryption %s mismatch refuses before capture publication",
  async (change) => {
    const f = setup(),
      key = f.request.resourceArns.personalJobKmsKeyArn;
    f.request.sourceObjects[0].encryption = {
      serverSideEncryption: "aws:kms",
      sseKmsKeyId: key,
      bucketKeyEnabled: false,
    };
    process.env.PAUSED_PREPARATION_REQUEST_SHA256 = canonicalHash(f.request);
    mockSend.mockImplementation((command) =>
      command.constructor.name === "HeadObjectCommand"
        ? {
            ...f.send(command),
            ServerSideEncryption: change === "mode" ? "AES256" : "aws:kms",
            SSEKMSKeyId: change === "key" ? key.replace(/1$/, "2") : key,
            BucketKeyEnabled: false,
          }
        : f.send(command),
    );
    await expect(prepareOriginalPausedDrafts()).rejects.toThrow();
    expect(
      mockSend.mock.calls.some(
        ([command]) => command.constructor.name === "PutObjectCommand",
      ),
    ).toBe(false);
  },
);
test("exact approved source KMS predicate and omitted optional predicate both use native HEAD metadata", async () => {
  const f = setup(),
    key = f.request.resourceArns.personalJobKmsKeyArn;
  const encryption = {
    serverSideEncryption: "aws:kms",
    sseKmsKeyId: key,
    bucketKeyEnabled: false,
  };
  f.request.sourceObjects[0].encryption = encryption;
  process.env.PAUSED_PREPARATION_REQUEST_SHA256 = canonicalHash(f.request);
  mockSend.mockImplementation((command) =>
    command.constructor.name === "HeadObjectCommand"
      ? {
          ...f.send(command),
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: key,
          BucketKeyEnabled: false,
        }
      : f.send(command),
  );
  await prepareOriginalPausedDrafts();
  const objects = JSON.parse(f.state.capture.toString()).objects;
  expect(objects.map((object) => object.encryption)).toEqual([
    encryption,
    encryption,
  ]);
});
