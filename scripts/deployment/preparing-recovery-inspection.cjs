"use strict";
const assert = require("node:assert/strict");
const { bindingHash } = require("./binding-hash.cjs");
const { archiveSchema, controlAuthority } = require("./carryforward-state.cjs");
const { receiptSchema } = require("./source-loss-state.cjs");
const {
  taskContainer,
  taskDefinitionInput,
  candidateDefinition,
  assertPreparedTaskDefinition,
} = require("./task-definition.cjs");
const {
  createCarryforwardInspection,
} = require("./carryforward-inspection.cjs");
const { assertSandboxScope } = require("./continue-sandbox.cjs");
function createPreparingInspection(options) {
  const {
    aws,
    coordinator,
    config,
    env,
    types,
    manifest,
    proof,
    now,
    originalExecution,
  } = options;
  const base = createCarryforwardInspection(options);
  async function registration(archive, run) {
    const prepared = candidateDefinition(
      (
        await aws("ecs", "describe-task-definition", {
          taskDefinition: manifest.templateArn,
        })
      ).taskDefinition,
      config,
    );
    const matches = [],
      seen = new Set(),
      pages = new Set();
    let nextToken;
    do {
      const page = await aws("ecs", "list-task-definitions", {
        familyPrefix: config.family,
        status: "ACTIVE",
        sort: "DESC",
        ...(nextToken ? { nextToken } : {}),
      });
      assert.ok(Array.isArray(page.taskDefinitionArns));
      for (const arn of page.taskDefinitionArns) {
        assert.ok(!seen.has(arn));
        seen.add(arn);
        // ECS familyPrefix also returns sibling families; the pinned ARN defines the exact scope.
        const familyPrefix = proof.definitionArn.slice(
          0,
          proof.definitionArn.lastIndexOf(":") + 1,
        );
        if (!arn.startsWith(familyPrefix)) continue;
        const actual = (
          await aws("ecs", "describe-task-definition", { taskDefinition: arn })
        ).taskDefinition;
        assert.equal(actual.family, config.family);
        const container = taskContainer(actual, config.tablePrefix);
        if (
          !container.environment.some(
            (entry) =>
              entry.name === "DEPLOYMENT_CANDIDATE_ID" &&
              entry.value === manifest.operationId,
          )
        )
          continue;
        assert.equal(arn, proof.definitionArn);
        assert.equal(actual.taskDefinitionArn, arn);
        assert.equal(actual.status, "ACTIVE");
        assert.equal(actual.registeredBy, archive.actorArn);
        const registeredAtIso = new Date(actual.registeredAt).toISOString();
        const registeredAt = Date.parse(registeredAtIso) / 1000;
        assert.ok(
          registeredAt >= archive.archivedAt &&
            registeredAt >= Date.parse(run.run_started_at) / 1000 &&
            registeredAt <= Date.parse(run.updated_at) / 1000 &&
            registeredAt <= now(),
        );
        const input = taskDefinitionInput(actual);
        assert.equal(bindingHash(input), proof.definitionSha256);
        assertPreparedTaskDefinition(
          input,
          prepared,
          manifest.preparedDefinitionSha256,
        );
        matches.push({
          arn,
          registeredBy: actual.registeredBy,
          registeredAt: registeredAtIso,
          sha256: bindingHash(input),
        });
      }
      nextToken = page.nextToken;
      if (nextToken) {
        assert.ok(!pages.has(nextToken));
        pages.add(nextToken);
      }
    } while (nextToken);
    assert.equal(matches.length, 1, "Unique existing registration required");
    return matches[0];
  }
  async function inspect() {
    const observed = await coordinator.inspectServing(),
      ctl = observed.control,
      d = ctl.deployment;
    (options.validateScope ?? assertSandboxScope)(env, {
      ...ctl,
      deployment: { ...d, taskDefinition: proof.definitionArn },
    });
    assert.equal(bindingHash(controlAuthority(ctl)), proof.controlSha256);
    assert.equal(ctl.coordinatorToken, proof.logicalRunToken);
    assert.equal(d.runToken, proof.logicalRunToken);
    assert.equal(d.phase, "preparing");
    assert.equal(d.taskDefinition, undefined);
    assert.equal(d.candidate, undefined);
    assert.equal(d.routing.state, "source");
    assert.deepEqual(observed.routing, d.routing);
    assert.equal(ctl.servingGeneration, d.originalGeneration);
    assert.deepEqual(Object.values(ctl.servingMembers), [observed.source]);
    assert.deepEqual(d.originalMembers, [observed.source]);
    assert.deepEqual(d.outgoing, observed.source);
    assert.equal(d.candidateId, manifest.operationId);
    assert.equal(d.image, manifest.image);
    assert.equal(observed.serviceDefinition, d.previousTaskDefinition);
    assert.equal(observed.service.runningCount, 1);
    assert.equal(observed.service.pendingCount, 0);
    assert.ok(ctl.coordinatorExpiresAt <= now(), "Original lease is live");
    assert.equal(
      await base.read(base.archiveKey, "PREPARING_RECOVERY"),
      undefined,
      "Recovery approval already consumed",
    );
    const archive = archiveSchema(types).parse(
      await base.read(base.archiveKey, "ARCHIVE"),
    );
    assert.equal(bindingHash(archive), proof.archiveSha256);
    assert.equal(archive.operationId, manifest.operationId);
    assert.equal(archive.manifestSha256, options.manifestSha256);
    assert.equal(archive.toolSourceCommit, manifest.sourceCommit);
    assert.equal(
      bindingHash(controlAuthority(archive.originalControl)),
      manifest.controlSha256,
    );
    assert.equal(archive.executionRunToken, proof.logicalRunToken);
    assert.equal(
      ctl.coordinatorEpoch,
      archive.originalControl.coordinatorEpoch + 1,
    );
    assert.deepEqual(archive.source, observed.source);
    for (const key of [
      "image",
      "imageSourceCommit",
      "templateArn",
      "preparedDefinitionSha256",
    ])
      assert.equal(archive[key], manifest[key]);
    const recovery = receiptSchema(types).parse(
      await base.read(archive.recoveryPk, "RECOVERY"),
    );
    assert.equal(bindingHash(recovery), manifest.recoverySha256);
    assert.equal(bindingHash(recovery), archive.recoverySha256);
    assert.equal(bindingHash(recovery), proof.recoverySha256);
    assert.equal(recovery.version, 2);
    assert.equal(recovery.stage, "availability_restored");
    assert.equal(recovery.settlement, "lost_owner_settlement_pending");
    assert.deepEqual(recovery.candidate, observed.source);
    assert.deepEqual(
      recovery.source,
      archive.originalControl.deployment.outgoing,
    );
    assert.equal(recovery.runToken, manifest.originalRunToken);
    const run = await originalExecution(proof.logicalRunToken);
    const [id, attempt] = proof.logicalRunToken.split("-").map(Number);
    assert.equal(run.id, id);
    assert.equal(run.run_attempt, attempt);
    assert.equal(run.path, ".github/workflows/sandbox-identity.yml");
    assert.equal(run.head_sha, manifest.sourceCommit);
    assert.equal(run.status, "completed");
    assert.equal(run.conclusion, "failure");
    assert.ok(
      Date.parse(run.run_started_at) <= archive.archivedAt * 1000 &&
        Date.parse(run.updated_at) <= now() * 1000,
    );
    const registered = await registration(archive, run);
    await base.template(d.previousTaskDefinition, observed.runtimeMode);
    assert.deepEqual(
      controlAuthority(await base.control()),
      controlAuthority(ctl),
    );
    const binding = {
      kind: "sandbox_preparing_recovery",
      proofSha256: env.PREPARING_RECOVERY_PROOF_SHA256,
      logicalRunToken: proof.logicalRunToken,
      control: controlAuthority(ctl),
      archiveSha256: proof.archiveSha256,
      recoverySha256: proof.recoverySha256,
      source: observed.source,
      routing: observed.routing,
      definitionArn: registered.arn,
      registration: registered,
      originalExecution: Object.fromEntries(
        [
          "id",
          "run_attempt",
          "path",
          "head_sha",
          "status",
          "conclusion",
          "run_started_at",
          "updated_at",
        ].map((key) => [key, run[key]]),
      ),
    };
    return {
      ...observed,
      archive,
      recovery,
      binding,
      bindingSha256: bindingHash(binding),
    };
  }
  return { ...base, inspect };
}
module.exports = { createPreparingInspection };
