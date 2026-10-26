/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { collectNativeInventory } from "../../scripts/deployment/collector-inventory.cjs";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";

const secret = "DO_NOT_RETAIN_PROVIDER_SECRET_SENTINEL";
function nativeFixture(change = () => {}) {
  const m = manifestFixture();
  const container = {
    name: m.containerName,
    image: `${m.binding.accountId}.dkr.ecr.${m.binding.region}.amazonaws.com/${m.imageRepository}:${m.binding.legacySha}`,
    imageDigest: "sha256:" + "a".repeat(64),
    containerArn: `${m.legacyTaskArn}/container`,
    runtimeId: "a".repeat(32),
    managedAgents: [
      { name: "ExecuteCommandAgent", lastStatus: "RUNNING", reason: secret },
    ],
    environment: [{ name: "OPENAI_API_KEY", value: secret }],
    secrets: [
      {
        name: "SESSION_SECRET",
        valueFrom:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:chronote/session-abcdef:SESSION_SECRET::version-1",
      },
    ],
    command: ["node", "dist/index.js"],
    credentialSpecifications: [secret],
  };
  const task = {
    taskArn: m.legacyTaskArn,
    taskDefinitionArn: m.legacyTaskDefinition,
    lastStatus: "RUNNING",
    enableExecuteCommand: true,
    containers: [container],
    overrides: {
      containerOverrides: [
        {
          name: m.containerName,
          environment: [{ name: "AWS_SECRET_ACCESS_KEY", value: secret }],
        },
      ],
    },
    stoppedReason: secret,
    tags: [{ key: "private", value: secret }],
  };
  const definition = {
    taskDefinitionArn: m.legacyTaskDefinition,
    taskRoleArn: m.binding.taskRoleArn,
    executionRoleArn: m.executionRoleArn,
    containerDefinitions: [container],
  };
  change({ task, definition, container });
  const responses = {
    "ecs.list-tasks": { taskArns: [m.legacyTaskArn] },
    "ecs.describe-tasks": { tasks: [task] },
    "ecs.describe-task-definition": {
      taskDefinition: definition,
      tags: [{ key: "private", value: secret }],
    },
    "ecs.describe-services": {
      services: [
        {
          serviceArn: `arn:aws:ecs:us-east-1:123456789012:service/${m.cluster}/${m.service}`,
          serviceName: m.service,
          taskDefinition: m.legacyTaskDefinition,
          desiredCount: 1,
          events: [{ message: secret }],
        },
      ],
    },
    "ecr.describe-images": {
      imageDetails: [
        {
          imageDigest: container.imageDigest,
          imageTags: [m.binding.legacySha],
          arbitrary: secret,
        },
      ],
    },
    "iam.get-role": { Role: { Arn: m.binding.taskRoleArn } },
    "iam.list-role-policies": { PolicyNames: [] },
    "iam.list-attached-role-policies": { AttachedPolicies: [] },
    "application-autoscaling.describe-scalable-targets": {
      ScalableTargets: [],
    },
    "application-autoscaling.describe-scaling-policies": {
      ScalingPolicies: [],
    },
    "application-autoscaling.describe-scheduled-actions": {
      ScheduledActions: [],
    },
    "events.list-event-buses": { EventBuses: [] },
    "scheduler.list-schedules": { Schedules: [] },
  };
  return {
    m,
    request: {
      taskArn: m.legacyTaskArn,
      taskDefinition: m.legacyTaskDefinition,
      sourceSha: m.binding.legacySha,
    },
    aws: async (service, operation) => responses[`${service}.${operation}`],
  };
}
test("native capture is an explicit metadata projection without environment or provider values", async () => {
  const captured = await collectNativeInventory(nativeFixture());
  expect(JSON.stringify(captured)).not.toContain(secret);
  expect(captured.tasks.projectionKind).toBe("ecs-metadata-v1");
  expect(
    captured.tasks.definitions[0].taskDefinition.containerDefinitions[0]
      .environmentNames,
  ).toEqual(["OPENAI_API_KEY"]);
  expect(
    captured.tasks.tasks[0].overrides.containerOverrides[0].environmentNames,
  ).toEqual(["AWS_SECRET_ACCESS_KEY"]);
});
test.each(["command", "entryPoint"])(
  "unsupported %s refuses without exposing arguments",
  async (field) => {
    const options = nativeFixture(({ container }) => {
      container[field] = ["node", secret];
    });
    let failure;
    try {
      await collectNativeInventory(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).toContain("UNKNOWN");
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  },
);
test("malformed native identity cannot leak through assertion diagnostics", async () => {
  const options = nativeFixture(({ task }) => {
    task.taskDefinitionArn = secret;
  });
  let failure;
  try {
    await collectNativeInventory(options);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(String(failure)).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
});

test("absent startup command does not claim a source runtime mode", async () => {
  const capture = await collectNativeInventory(
    nativeFixture(({ container }) => {
      delete container.command;
    }),
  );
  expect(
    capture.tasks.definitions[0].taskDefinition.containerDefinitions[0].mode,
  ).toBeNull();
  expect(
    capture.tasks.tasks[0].overrides.containerOverrides[0].mode,
  ).toBeNull();
});
