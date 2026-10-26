import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { routingFixture } from "./routingFixture";
import { counts } from "./coordinatorFixture";
import {
  candidateDefinition,
  configuration,
} from "../../../scripts/deployment/coordinator.cjs";
import { bindingHash } from "../../../scripts/deployment/continue-sandbox.cjs";
import { controlAuthority } from "../../../scripts/deployment/carryforward-state.cjs";
export function carryforwardFixture() {
  const f = routingFixture();
  let clock = 1000;
  f.svc.serviceName = "service";
  f.svc.deploymentConfiguration.earlySuccessCriteria = {
    enable: true,
    healthyPercent: 100,
    sourceServiceRevisionCleanup: "DEFERRED",
  };
  const operationId = "0e46f154-2ad7-482d-8930-f045fbfd197b";
  const lost = {
    ...f.oldIdentity,
    instanceId: "lost",
    taskArn: f.oldIdentity.taskArn.replace("/old", "/lost"),
    candidateId: "lost",
    imageDigest: "sha256:" + "0".repeat(64),
  };
  const image = "repo@" + f.candidateIdentity.imageDigest;
  f.state.ctl.coordinatorToken = "900-1";
  f.state.ctl.deployment = {
    runToken: "900-1",
    cluster: "cluster",
    service: "service",
    family: "family",
    tablePrefix: "fixture-",
    candidateId: f.oldIdentity.candidateId,
    image: "repo@" + f.oldIdentity.imageDigest,
    runtimeMode: "all",
    phase: "promoted",
    originalGeneration: 0,
    originalMembers: [lost],
    outgoing: lost,
    candidate: f.oldIdentity,
    previousTaskDefinition: "definition:lost",
    taskDefinition: "definition:old",
    updatedAt: 900,
    routing: {
      ...f.routing,
      sourceGroup: "group-b",
      candidateGroup: "group-a",
      sourceRevision: "revision-lost",
      candidateRevision: "revision-old",
      state: "candidate",
    },
  };
  f.definition.containerDefinitions[0].image = f.state.ctl.deployment.image;
  f.definition.containerDefinitions[0].stopTimeout = 120;
  f.definition.containerDefinitions[0].environment.push(
    { name: "STRIPE_MODE", value: "test" },
    { name: "DISCORD_CLIENT_ID", value: "123456789012345678" },
    ...[
      "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
      "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
      "STRIPE_RENEWAL_GRACE_ENABLED",
    ].map((name) => ({ name, value: "false" })),
  );
  f.state.rows.old.workCounts = counts();
  f.state.retirementAcknowledged = true;
  for (const field of ["identity"])
    f.state.rows.new[field] = {
      ...f.state.rows.new[field],
      candidateId: operationId,
    };
  f.state.rows.new.readiness.identity = f.state.rows.new.identity;
  f.state.rows.new.protection.identity = f.state.rows.new.identity;
  const historical = {
    ...structuredClone(f.state.rows.old),
    identity: lost,
    sk: "RUNTIME#lost",
    authorizedGeneration: 0,
  };
  historical.readiness.identity = lost;
  historical.protection.identity = lost;
  const recovery = {
    pk: "SOURCELOSS#900-1",
    sk: "RECOVERY",
    recordType: "source_loss_recovery",
    version: 2,
    bindingSha256: "e".repeat(64),
    runToken: "900-1",
    actorArn: "original-oidc-actor",
    source: lost,
    candidate: f.oldIdentity,
    stoppedAt: new Date(850000).toISOString(),
    admittedAt: 900,
    stage: "availability_restored",
    settlement: "lost_owner_settlement_pending",
    settlementReason: "incomplete_durable_effect_ledger",
    metadataAudit: {
      collectedAt: 899,
      records: {},
      sha256: "e".repeat(64),
      counts: {},
    },
    updatedAt: 950,
    terminalProof: {
      kind: "operator_retained_ecs_stop",
      packetSha256: "f".repeat(64),
      originalSnapshotSha256: "f".repeat(64),
      capturedAt: new Date(860000).toISOString(),
      provenance: "operator_captured_provider_response",
      nativeObservation: "MISSING",
    },
  };
  const template = structuredClone(f.definition);
  template.taskDefinitionArn = "definition:reviewed";
  for (const entry of template.containerDefinitions[0].environment)
    if (
      [
        "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
        "STRIPE_RENEWAL_GRACE_ENABLED",
      ].includes(entry.name)
    )
      entry.value = "true";
  const role = "arn:aws:iam::123456789012:role/fixture-sandbox-github-deploy";
  const env = {
    ...f.options.env,
    AWS_REGION: "us-east-1",
    EXPECTED_ACCOUNT_ID: "123456789012",
    EXPECTED_ROLE_ARN: role,
    EXPECTED_SESSION_NAME: "chronote-sandbox-901-1",
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
    GITHUB_RUN_ID: "901",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
  };
  const manifest = {
    version: 1,
    kind: "sandbox_historical_carryforward",
    operationId,
    policy: "normal_protected_deployments_with_unresolved_history",
    operatorExclusion: "exclusive_approved_writer_window",
    accountId: env.EXPECTED_ACCOUNT_ID,
    region: env.AWS_REGION,
    sourceCommit: env.GITHUB_SHA,
    imageSourceCommit: "b".repeat(40),
    image,
    templateArn: template.taskDefinitionArn,
    preparedDefinitionSha256: bindingHash(
      candidateDefinition(template, {
        ...configuration(env),
        image,
        candidateId: operationId,
      }),
    ),
    controlSha256: bindingHash(controlAuthority(f.state.ctl)),
    recoverySha256: bindingHash(recovery),
    originalRunToken: "900-1",
    approveBefore: 2000,
  };
  const carry = {
    advance: (seconds) => {
      clock += seconds;
    },
    archive: undefined,
    recovery,
    historical,
    template,
    registered: undefined,
    loseAck: false,
    sourceProtectionLost: false,
    sourceProtectionRead: () => undefined,
    beforeClaim: () => undefined,
    afterClaim: () => undefined,
  };
  const original = f.aws.getMockImplementation();
  function operatorRead(input) {
    const key = unmarshall(input.Key);
    if (key.pk.startsWith("SOURCELOSS#"))
      return { Item: marshall(carry.recovery) };
    if (key.pk.startsWith("CARRYFORWARD#"))
      return { Item: carry.archive ? marshall(carry.archive) : undefined };
    if (key.sk === "RUNTIME#lost") return { Item: marshall(carry.historical) };
  }
  function applyClaim(operation, input) {
    f.calls.push({ operation, input });
    carry.beforeClaim();
    if (carry.archive) throw new Error("approval already consumed");
    const values = unmarshall(
      input.TransactItems[0].Update.ExpressionAttributeValues,
    );
    Object.assign(f.state.ctl, {
      coordinatorToken: values[":nextToken"],
      coordinatorEpoch: values[":nextEpoch"],
      coordinatorExpiresAt: values[":nextExpiry"],
      deployment: values[":nextDeployment"],
    });
    carry.archive = unmarshall(input.TransactItems[1].Put.Item);
    carry.afterClaim();
    if (carry.loseAck) throw new Error("lost claim response");
    return {};
  }
  function unprotectedSource(operation, input) {
    if (
      operation === "get-task-protection" &&
      carry.sourceProtectionLost &&
      input.tasks.includes(f.oldIdentity.taskArn)
    ) {
      carry.sourceProtectionRead();
      return {
        protectedTasks: [
          { taskArn: f.oldIdentity.taskArn, protectionEnabled: false },
        ],
      };
    }
  }
  f.aws.mockImplementation(async (service, operation, input) => {
    const protection = unprotectedSource(operation, input);
    if (protection) return protection;
    if (service === "sts")
      return {
        Account: env.EXPECTED_ACCOUNT_ID,
        Arn:
          role.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/") +
          "/" +
          env.EXPECTED_SESSION_NAME,
      };
    if (operation === "describe-task-definition") {
      if (input.taskDefinition === template.taskDefinitionArn)
        return { taskDefinition: carry.template };
      if (input.taskDefinition === "definition:new" && carry.registered)
        return { taskDefinition: carry.registered };
    }
    if (service === "dynamodb" && operation === "get-item") {
      const result = operatorRead(input);
      if (result) return result;
    }
    if (operation === "transact-write-items" && input.TransactItems[1]?.Put)
      return applyClaim(operation, input);
    const result = await original(service, operation, input);
    if (operation === "register-task-definition")
      carry.registered = structuredClone(result.taskDefinition);
    return result;
  });
  const writerInventory = {
    assertExclusive: jest.fn(async () => ({ competing: 0 })),
  };
  const bind = () => {
    env.CARRYFORWARD_MANIFEST_JSON = JSON.stringify(manifest);
    env.CARRYFORWARD_MANIFEST_SHA256 = bindingHash(manifest);
  };
  bind();
  return {
    ...f,
    carry,
    manifest,
    bind,
    options: {
      ...f.options,
      env,
      now: () => clock,
      sleep: async () => {
        clock++;
        for (const row of Object.values(f.state.rows)) {
          row.heartbeatAt = clock;
          row.readiness.provenAt = clock;
          row.readiness.observedEpoch = f.state.ctl.coordinatorEpoch;
          row.readiness.observedGeneration = f.state.ctl.servingGeneration;
          row.readiness.expiresAt = clock + 30;
          row.protection.expiresAt = clock + 600;
        }
        f.state.onSleep();
      },
      writerInventory,
      validateScope: () => undefined,
    },
    before: f.calls.length,
  };
}
