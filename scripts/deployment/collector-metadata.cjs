"use strict";
const { z } = require("zod");
const { runtimeMode } = require("./coordinator.cjs");
const name = z.string().regex(/^[A-Za-z0-9_./-]{1,256}$/);
const arn = z
  .string()
  .regex(/^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9_./:-]+$/);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const status = z.enum([
  "PROVISIONING",
  "PENDING",
  "ACTIVATING",
  "RUNNING",
  "DEACTIVATING",
  "STOPPING",
  "DEPROVISIONING",
  "STOPPED",
]);
const optionalCount = z.number().int().nonnegative().optional();
const agent = z.object({
  name: z.literal("ExecuteCommandAgent"),
  lastStatus: z.enum(["PENDING", "RUNNING", "STOPPED"]),
});
const nativeContainer = z.object({
  name,
  containerArn: arn.optional(),
  runtimeId: z
    .string()
    .regex(/^[a-f0-9-]{32,64}$/)
    .optional(),
  imageDigest: imageDigest.optional(),
  lastStatus: status.optional(),
  managedAgents: z.array(agent).optional(),
});
const secretReference = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  valueFrom: z
    .string()
    .regex(
      /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9_./+=@-]+(?::[A-Za-z0-9_./+=@-]*:[A-Za-z0-9_./+=@-]*:[A-Za-z0-9_./+=@-]*)?$/,
    ),
});
function startup(container) {
  const mode = runtimeMode(container);
  return {
    mode: container.command ? mode : null,
    command: container.command ?? null,
    entryPoint: container.entryPoint ?? null,
    environmentNames: container.environment?.map((entry) =>
      secretReference.shape.name.parse(entry.name),
    ),
    environmentFileCount: container.environmentFiles?.length,
    mountCount: container.mountPoints?.length,
    credentialSpecificationCount: container.credentialSpecifications?.length,
    secrets: container.secrets?.map((entry) => secretReference.parse(entry)),
  };
}
function containerDefinition(container) {
  const identity = z
    .object({
      name,
      image: z
        .string()
        .regex(
          /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9_./-]+(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})$/,
        ),
      stopTimeout: optionalCount,
      essential: z.boolean().optional(),
      readonlyRootFilesystem: z.boolean().optional(),
      privileged: z.boolean().optional(),
    })
    .parse(container);
  return { ...identity, ...startup(container) };
}
function taskProjection(task) {
  const selected = z
    .object({
      taskArn: arn,
      taskDefinitionArn: arn,
      clusterArn: arn.optional(),
      lastStatus: status,
      desiredStatus: status.optional(),
      enableExecuteCommand: z.boolean().optional(),
      startedAt: z.string().datetime({ offset: true }).optional(),
      stoppedAt: z.string().datetime({ offset: true }).optional(),
      containers: z.array(nativeContainer),
    })
    .parse(task);
  if (task.overrides) {
    selected.overrides = z
      .object({
        taskRoleArn: arn.optional(),
        executionRoleArn: arn.optional(),
      })
      .parse(task.overrides);
    selected.overrides.containerOverrides =
      task.overrides.containerOverrides?.map((entry) => ({
        name: name.parse(entry.name),
        ...startup(entry),
      }));
  }
  return selected;
}
function definitionProjection(definition) {
  const selected = z
    .object({
      taskDefinitionArn: arn,
      taskRoleArn: arn,
      executionRoleArn: arn.optional(),
      revision: optionalCount,
      status: z.enum(["ACTIVE", "INACTIVE", "DELETE_IN_PROGRESS"]).optional(),
      networkMode: z.enum(["none", "bridge", "awsvpc", "host"]).optional(),
    })
    .parse(definition);
  return {
    ...selected,
    volumeCount: definition.volumes?.length,
    containerDefinitions:
      definition.containerDefinitions.map(containerDefinition),
  };
}
function serviceProjection(service) {
  return z
    .object({
      serviceArn: arn,
      serviceName: name,
      clusterArn: arn.optional(),
      taskDefinition: arn,
      desiredCount: optionalCount,
      runningCount: optionalCount,
      pendingCount: optionalCount,
      status: z.enum(["ACTIVE", "DRAINING", "INACTIVE"]).optional(),
      deploymentController: z
        .object({ type: z.enum(["ECS", "CODE_DEPLOY", "EXTERNAL"]) })
        .optional(),
      deploymentConfiguration: z
        .object({
          minimumHealthyPercent: optionalCount,
          maximumPercent: optionalCount,
          strategy: z
            .enum(["ROLLING", "BLUE_GREEN", "LINEAR", "CANARY"])
            .optional(),
          deploymentCircuitBreaker: z
            .object({ enable: z.boolean(), rollback: z.boolean() })
            .optional(),
          earlySuccessCriteria: z
            .object({
              enable: z.boolean(),
              healthyPercent: optionalCount,
              sourceServiceRevisionCleanup: z
                .enum(["DEFERRED", "IMMEDIATE"])
                .optional(),
            })
            .optional(),
        })
        .optional(),
      deployments: z
        .array(
          z.object({
            id: name,
            status: z.enum(["PRIMARY", "ACTIVE", "INACTIVE"]),
            taskDefinition: arn,
            desiredCount: optionalCount,
            runningCount: optionalCount,
            pendingCount: optionalCount,
          }),
        )
        .optional(),
    })
    .parse(service);
}
function imageProjection(image) {
  return z
    .object({
      registryId: z
        .string()
        .regex(/^\d{12}$/)
        .optional(),
      repositoryName: name.optional(),
      imageDigest,
      imageTags: z.array(name).optional(),
    })
    .parse(image);
}
module.exports = {
  taskProjection,
  definitionProjection,
  serviceProjection,
  imageProjection,
};
