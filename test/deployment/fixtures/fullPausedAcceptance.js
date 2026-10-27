import { Buffer } from "node:buffer";
import process from "node:process";
import { expect } from "@jest/globals";
import { pausedPreparationFixture } from "../../fixtures/productionPausedPreparation.js";
import { prepareOriginalPausedDrafts } from "../../../scripts/deployment/production-paused-preparation.cjs";
import { canonicalHash } from "../../../scripts/deployment/production-manifest.cjs";
import { packageIntentHash } from "../../../scripts/deployment/production-package.cjs";
import {
  preservationPolicy,
  policyName,
} from "../../../scripts/deployment/production-paused-policy.cjs";

import { createProductionAws } from "../../../scripts/deployment/production-aws.cjs";
import { bindOriginalPausedDisposition } from "../../../scripts/deployment/production-paused-drafts.cjs";
import { introduceProduction } from "../../../scripts/deployment/introduce-production.cjs";
import { collectOriginalPausedInstallationFromRun } from "../../../scripts/deployment/production-actions.cjs";
import {
  collectAcceptanceFromOriginalRun,
  readAcceptance,
} from "../../../scripts/deployment/production-acceptance-collector.cjs";
export async function preparePausedAcceptance(m, hosted, transport) {
  const prep = pausedPreparationFixture(m),
    previous = process.env;
  prep.request.validUntil = m.validUntil + 100;
  prep.request.storeBinding.retentionUntil = m.validUntil + 200;
  prep.env.PAUSED_PREPARATION_REQUEST_SHA256 = canonicalHash(prep.request);
  process.env = {
    ...prep.env,
    DEPLOYMENT_TEST_DYNAMODB_ENDPOINT:
      previous.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  };
  transport.cli.mockImplementation(prep.aws);
  transport.s3.mockImplementation(prep.send);
  transport.exec.mockImplementation(async (_file, args) => ({
    stdout: JSON.stringify(prep.github(args[1])),
    stderr: "",
  }));
  try {
    const receipt = await prepareOriginalPausedDrafts(),
      declaration = prep.finish(receipt);
    const capture = JSON.parse(prep.state.capture.toString());
    expect(prep.state.capture.toString()).not.toContain("PRIVATE SENTINEL");
    expect(JSON.stringify(receipt)).not.toContain("personal-media-uploads");
    const scope = {
      manifest: m,
      identities: prep.request.cohort,
      objects: capture.objects,
      request: prep.request,
    };
    for (const purpose of ["introduction", "collector"]) {
      const role = hosted.launcher.declaration.roles.find(
        (r) => r.purpose === purpose,
      );
      const document = preservationPolicy(scope, purpose);
      hosted.launcher.inlinePolicies.set(
        role.arn.split("/").at(-1),
        new Map([[policyName, document]]),
      );
      role.inline = [
        { name: policyName, documentHash: canonicalHash(document) },
      ];
    }
    hosted.evidence.retainedDisposition.pausedDesktopDrafts = declaration;
    m.prerequisites.retainedDisposition = canonicalHash(
      hosted.evidence.retainedDisposition,
    );
    m.prerequisites.launcherHolds = canonicalHash(hosted.launcher.declaration);
    const manifest = structuredClone(m);
    for (const key of ["runId", "runAttempt", "sessionName"])
      manifest.identity[key] = "$CURRENT";
    const pkg = {
      schemaVersion: 1,
      manifest,
      identitySlots: ["runId", "runAttempt", "sessionName"],
      repositoryId: "1",
      repositoryOwnerId: "2",
    };
    hosted.env.INTRODUCTION_INTENT_HASH = packageIntentHash(pkg);
    const github = hosted.github;
    hosted.github = async (endpoint, query) => {
      if (
        endpoint.includes("production-paused-drafts/") ||
        endpoint.includes("/runs/20") ||
        endpoint.includes("/artifacts/30")
      )
        return prep.github(endpoint);
      if (
        endpoint.includes("/production-introductions/reviewed/execution.json?")
      ) {
        const bytes = Buffer.from(JSON.stringify(pkg));
        return {
          type: "file",
          path: "production-introductions/reviewed/execution.json",
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        };
      }
      if (endpoint.includes("/commits/")) return { sha: "c".repeat(40) };
      const value = await github(endpoint, query);
      if (
        process.env.GITHUB_JOB === "prepare-acceptance" &&
        endpoint.includes("/attempts/1/jobs")
      ) {
        const field = Array.isArray(value.jobs) ? "jobs" : "items";
        const jobs = value[field]
          .filter(
            (job) =>
              ![
                "Approve production acceptance",
                "Accept production introduction",
              ].includes(job.name),
          )
          .map((job) =>
            job.name === "Prepare production acceptance"
              ? {
                  ...job,
                  status: "in_progress",
                  conclusion: null,
                  completed_at: null,
                }
              : job,
          );
        return { total_count: jobs.length, [field]: jobs };
      }
      return value;
    };
    return prep;
  } finally {
    process.env = previous;
  }
}

export async function assertPausedOriginalRows(prep, m, read) {
  if (!prep) return;
  expect(m.actions).toHaveLength(200);
  for (const row of prep.parents)
    expect(
      await read(m.resources.tables.personalJob, { uploadId: row.uploadId }),
    ).toEqual(row);
  for (const row of prep.segments)
    expect(
      await read(m.resources.tables.personalSegment, {
        uploadId: row.uploadId,
        segmentKey: row.segmentKey,
      }),
    ).toEqual(row);
  const markers = [];
  for (const id of prep.request.cohort) {
    const marker = await read(m.resources.tables.deploymentControl, {
      pk: `UPLOAD#${id.uploadId}`,
      sk: "PAUSED_DRAFT",
    });
    expect(marker).toMatchObject({
      uploadId: id.uploadId,
      ownerUserId: id.ownerUserId,
      preservedCaptureSha256: prep.state.reference.sha256,
    });
    expect(marker.expiresAt).toBeUndefined();
    markers.push(marker);
  }
  return markers;
}

export async function seedPausedOriginalRows(prep, m, put) {
  if (!prep) return;
  for (const row of prep.parents)
    await put(m.resources.tables.personalJob, row);
  for (const row of prep.segments)
    await put(m.resources.tables.personalSegment, row);
}
export function attachPausedReaders(f, initial, prep, fault) {
  const requests = [];
  if (!prep) return requests;
  const native = createProductionAws(f.binding);
  Object.assign(f.options, {
    pausedDraftMetadata: native.pausedDraftMetadata,
    scan: native.scan,
    evidence: initial.evidence,
    pausedBound: bindOriginalPausedDisposition(
      initial.binding,
      initial.evidence,
      initial.pausedPreparation,
    ),
  });
  const invoke = f.options.invoke;
  f.options.invoke = async (operation, input, ...rest) => {
    const initialization = input.TransactItems?.some(
      (item) => item.Put?.Item?.recordType?.S === "paused_desktop_draft",
    );
    if (initialization) requests.push(structuredClone(input));
    const response = await invoke(operation, input, ...rest);
    if (initialization && fault === "initialize-lost-ack")
      throw Error("synthetic lost init ACK after native commit");
    return response;
  };
  return requests;
}
export async function runFullIntroduction(
  f,
  path,
  fault,
  prep,
  requests,
  read,
) {
  if (path === "repair") {
    f.state.failReady = true;
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    f.state.failReady = false;
  }
  if (fault === "initialize-lost-ack") {
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    await assertPausedOriginalRows(prep, f.m, read);
    await expect(collectOriginalPausedInstallationFromRun()).rejects.toThrow(
      "paused_installation_journal_prerequisite",
    );
    expect(requests).toHaveLength(1);
    return true;
  }
  await introduceProduction(
    f.options,
    path === "repair" ? "continue" : "introduce",
  );
  if (prep) {
    await assertPausedOriginalRows(prep, f.m, read);
    assertPausedInitialization(requests, f.m);
  }
  return false;
}
function assertPausedInitialization(requests, m) {
  expect(requests).toHaveLength(1);
  const items = requests[0].TransactItems;
  const personal = [
    m.resources.tables.personalJob,
    m.resources.tables.personalSegment,
  ];
  expect(
    items.filter((item) => personal.includes(item.ConditionCheck?.TableName)),
  ).toHaveLength(4);
  expect(
    items.filter(
      (item) => item.Put?.Item.recordType?.S === "paused_desktop_draft",
    ),
  ).toHaveLength(2);
  expect(
    items.filter((item) =>
      personal.includes((item.Put ?? item.Update ?? item.Delete)?.TableName),
    ),
  ).toHaveLength(0);
}
export async function prepareFullPausedCollector(prep, env, m, read) {
  if (!prep) return;
  env.GITHUB_JOB = "prepare-acceptance";
  const prepared = await collectAcceptanceFromOriginalRun();
  expect(readAcceptance(prepared).preparation).toBe(true);
  await assertPausedOriginalRows(prep, m, read);
  env.GITHUB_JOB = "accept";
}
export function assertPausedObjectOperations(prep, calls) {
  if (!prep) return;
  const original = calls
    .map(([command]) => command)
    .filter((command) =>
      command.input.Key?.startsWith("personal-media-uploads/"),
    );
  expect(original.length).toBeGreaterThan(0);
  expect(
    original.every(
      (command) => command.constructor.name === "HeadObjectCommand",
    ),
  ).toBe(true);
}
export function pausedAcceptanceResult(prep) {
  if (!prep) return;
  return {
    pausedIds: prep.request.cohort.map((id) => id.uploadId),
    finalPurposes: [
      "persist_acceptance",
      "reopen_admission",
      "release_deployment",
    ],
  };
}

export function assertPausedFinalTransaction(prep, path, m, input) {
  if (!prep || input.TransactItems.length <= 3) return;
  const items = input.TransactItems;
  expect(items).toHaveLength(path === "normal" ? 20 : 21);
  const checks = items.map((item) => item.ConditionCheck).filter(Boolean);
  const markers = checks.filter(
    (item) =>
      item.TableName === m.resources.tables.deploymentControl &&
      item.Key.sk?.S === "PAUSED_DRAFT",
  );
  expect(markers.map((item) => item.Key.pk.S).sort()).toEqual([
    "UPLOAD#one",
    "UPLOAD#two",
  ]);
  const parents = checks.filter(
    (item) => item.TableName === m.resources.tables.personalJob,
  );
  expect(parents).toHaveLength(2);
  for (const parent of parents) {
    expect(parent.ConditionExpression).toContain(
      "attribute_type(#manifest, :listType)",
    );
    expect(parent.ConditionExpression).toContain(
      "size(#manifest) = :sourceCount",
    );
    expect(parent.ConditionExpression).toContain("#manifest[0].#sourceId");
  }
  expect(
    checks.filter(
      (item) => item.TableName === m.resources.tables.personalSegment,
    ),
  ).toHaveLength(2);
}

export function originalRunCallerIdentity(m, binding, job) {
  return {
    Account: m.identity.accountId,
    Arn:
      job === "prepare-acceptance"
        ? `arn:aws:sts::${m.identity.accountId}:assumed-role/acceptance-reader/introduction-read-${m.identity.runId}-1`
        : binding.actor,
  };
}
