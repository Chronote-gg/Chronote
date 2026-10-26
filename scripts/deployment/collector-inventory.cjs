"use strict";
const assert = require("node:assert/strict");
const { metadataDigest } = require("./production-work.cjs");
const { stateDigest } = require("./production-evidence.cjs");
const {
  taskProjection,
  definitionProjection,
  serviceProjection,
  imageProjection,
} = require("./collector-metadata.cjs");
async function collectPages(
  aws,
  m,
  service,
  operation,
  input,
  field,
  outputToken = "NextToken",
  inputToken = "NextToken",
) {
  const rows = [],
    pages = [],
    seen = new Set();
  let cursor;
  do {
    assert.ok(pages.length < m.maxPages, "UNKNOWN: native page limit");
    const response = await aws(service, operation, {
      ...input,
      ...(cursor ? { [inputToken]: cursor } : {}),
    });
    assert.ok(Array.isArray(response[field]), "UNKNOWN: native rows");
    rows.push(...response[field]);
    const next = response[outputToken] ?? null;
    assert.ok(!response.IsTruncated || next, "UNKNOWN: missing native cursor");
    assert.ok(
      next === null ||
        (typeof next === "string" && next.length > 0 && next.length <= 4096),
    );
    assert.ok(!next || !seen.has(next), "UNKNOWN: repeated native cursor");
    pages.push({
      start: cursor ?? null,
      end: next,
      count: response[field].length,
      sha256: metadataDigest(response[field]),
    });
    seen.add(next);
    cursor = next;
    assert.ok(rows.length <= m.maxRows, "UNKNOWN: native row limit");
  } while (cursor);
  return { rows, pages };
}
async function taskInventory(aws, m, request) {
  const listings = [];
  for (const desiredStatus of ["RUNNING", "STOPPED"])
    listings.push(
      await collectPages(
        aws,
        m,
        "ecs",
        "list-tasks",
        { cluster: m.cluster, desiredStatus },
        "taskArns",
        "nextToken",
        "nextToken",
      ),
    );
  const arns = [
      ...new Set([...listings.flatMap((p) => p.rows), request.taskArn]),
    ],
    tasks = [];
  for (let i = 0; i < arns.length; i += 100) {
    const batch = arns.slice(i, i + 100),
      result = await aws("ecs", "describe-tasks", {
        cluster: m.cluster,
        tasks: batch,
        include: ["TAGS"],
      });
    assert.ok(
      (result.failures ?? []).length === 0,
      "UNKNOWN: task metadata failure",
    );
    assert.deepEqual(
      result.tasks.map((t) => t.taskArn).sort(),
      [...batch].sort(),
    );
    tasks.push(...result.tasks.map(taskProjection));
  }
  const definitions = [];
  for (const taskDefinition of new Set(tasks.map((t) => t.taskDefinitionArn))) {
    const result = await aws("ecs", "describe-task-definition", {
      taskDefinition,
      include: ["TAGS"],
    });
    assert.equal(result.taskDefinition.taskDefinitionArn, taskDefinition);
    definitions.push({
      taskDefinition: definitionProjection(result.taskDefinition),
    });
  }
  const service = await aws("ecs", "describe-services", {
    cluster: m.cluster,
    services: [m.service],
    include: ["TAGS"],
  });
  assert.deepEqual(service.failures ?? [], []);
  assert.equal(service.services.length, 1);
  const bound = tasks.find((t) => t.taskArn === request.taskArn);
  assert.equal(bound.taskDefinitionArn, request.taskDefinition);
  const definition = definitions.find(
    (d) => d.taskDefinition.taskDefinitionArn === request.taskDefinition,
  ).taskDefinition;
  assert.equal(definition.taskRoleArn, m.binding.taskRoleArn);
  const matches = bound.containers.filter((c) => c.name === m.containerName);
  assert.equal(matches.length, 1);
  const container = matches[0],
    image = definition.containerDefinitions.find(
      (c) => c.name === m.containerName,
    );
  assert.ok(image, "UNKNOWN: container definition");
  const images = await aws("ecr", "describe-images", {
    registryId: m.binding.accountId,
    repositoryName: m.imageRepository,
    imageIds: [{ imageTag: request.sourceSha }],
  });
  assert.equal(images.imageDetails.length, 1);
  assert.equal(images.imageDetails[0].imageDigest, container.imageDigest);
  const repository = `${m.binding.accountId}.dkr.ecr.${m.binding.region}.amazonaws.com/${m.imageRepository}`;
  assert.ok(
    [
      repository + ":" + request.sourceSha,
      repository + "@" + container.imageDigest,
    ].includes(image.image),
    "UNKNOWN: source image",
  );
  if (bound.lastStatus !== "STOPPED") {
    assert.equal(bound.lastStatus, "RUNNING");
    assert.equal(bound.enableExecuteCommand, true);
    assert.equal(
      container.managedAgents?.filter(
        (a) => a.name === "ExecuteCommandAgent" && a.lastStatus === "RUNNING",
      ).length,
      1,
    );
  }
  return {
    projectionKind: "ecs-metadata-v1",
    listings,
    tasks,
    definitions,
    service: serviceProjection(service.services[0]),
    images: images.imageDetails.map(imageProjection),
    bound: {
      taskArn: bound.taskArn,
      containerArn: container.containerArn,
      runtimeId: container.runtimeId,
      imageDigest: container.imageDigest,
      lastStatus: bound.lastStatus,
    },
  };
}
function policyDocument(document) {
  return typeof document === "string"
    ? JSON.parse(decodeURIComponent(document))
    : document;
}
async function policyInventory(aws, m) {
  const RoleName = m.binding.taskRoleArn.split("/").at(-1),
    input = { RoleName };
  const role = (await aws("iam", "get-role", input)).Role;
  assert.equal(role.Arn, m.binding.taskRoleArn);
  const inline = await collectPages(
    aws,
    m,
    "iam",
    "list-role-policies",
    input,
    "PolicyNames",
    "Marker",
    "Marker",
  );
  const attached = await collectPages(
    aws,
    m,
    "iam",
    "list-attached-role-policies",
    input,
    "AttachedPolicies",
    "Marker",
    "Marker",
  );
  const documents = [];
  for (const PolicyName of inline.rows) {
    const result = await aws("iam", "get-role-policy", {
      ...input,
      PolicyName,
    });
    assert.equal(result.PolicyName, PolicyName);
    assert.equal(result.RoleName, RoleName);
    documents.push({
      kind: "inline",
      name: PolicyName,
      document: policyDocument(result.PolicyDocument),
    });
  }
  const arns = new Set(attached.rows.map((p) => p.PolicyArn));
  if (role.PermissionsBoundary)
    arns.add(role.PermissionsBoundary.PermissionsBoundaryArn);
  for (const PolicyArn of arns) {
    const policy = (await aws("iam", "get-policy", { PolicyArn })).Policy;
    assert.equal(policy.Arn, PolicyArn);
    const version = (
      await aws("iam", "get-policy-version", {
        PolicyArn,
        VersionId: policy.DefaultVersionId,
      })
    ).PolicyVersion;
    assert.equal(version.VersionId, policy.DefaultVersionId);
    documents.push({
      kind: "managed",
      arn: PolicyArn,
      version: version.VersionId,
      document: policyDocument(version.Document),
    });
  }
  const owned = documents.filter(
    (d) => d.kind === "inline" && d.name === m.ownedPolicyName,
  );
  assert.ok(owned.length <= 1);
  return {
    role,
    inline,
    attached,
    documents,
    ownedSha256: owned.length ? metadataDigest(owned[0].document) : null,
    unrelatedSha256: stateDigest({
      role,
      documents: documents.filter((d) => !owned.includes(d)),
    }),
  };
}
async function controllerInventory(aws, m) {
  const scaling = [];
  for (const [operation, field] of [
    ["describe-scalable-targets", "ScalableTargets"],
    ["describe-scaling-policies", "ScalingPolicies"],
    ["describe-scheduled-actions", "ScheduledActions"],
  ])
    scaling.push({
      operation,
      ...(await collectPages(
        aws,
        m,
        "application-autoscaling",
        operation,
        {
          ServiceNamespace: "ecs",
          ...(operation === "describe-scalable-targets"
            ? { ResourceIds: [`service/${m.cluster}/${m.service}`] }
            : { ResourceId: `service/${m.cluster}/${m.service}` }),
        },
        field,
      )),
    });
  const buses = await collectPages(
      aws,
      m,
      "events",
      "list-event-buses",
      {},
      "EventBuses",
    ),
    rules = [];
  for (const bus of buses.rows) {
    const listing = await collectPages(
      aws,
      m,
      "events",
      "list-rules",
      { EventBusName: bus.Name },
      "Rules",
    );
    for (const rule of listing.rows)
      rules.push({
        rule,
        targets: await collectPages(
          aws,
          m,
          "events",
          "list-targets-by-rule",
          { EventBusName: bus.Name, Rule: rule.Name },
          "Targets",
        ),
      });
    rules.push({ bus: bus.Name, pages: listing.pages });
  }
  const schedules = await collectPages(
    aws,
    m,
    "scheduler",
    "list-schedules",
    {},
    "Schedules",
  );
  return { scaling, buses, rules, schedules };
}
async function collectNativeInventory({ m, request, aws }) {
  const failures = new WeakSet();
  const safe = async (service, operation, input) => {
    try {
      return await aws(service, operation, input);
    } catch {
      const failure = new Error(
        `UNKNOWN: native ${service}.${operation} prerequisite unavailable`,
      );
      failures.add(failure);
      throw failure;
    }
  };
  return {
    tasks: await taskInventory(safe, m, request).catch((error) => {
      if (failures.has(error)) throw error;
      throw new Error("UNKNOWN: native ECS metadata unsupported");
    }),
    policies: await policyInventory(safe, m),
    controllers: await controllerInventory(safe, m),
  };
}
module.exports = { collectPages, collectNativeInventory };
