"use strict";
const { canonicalHash } = require("./production-manifest.cjs");
const { runtimeMode } = require("./coordinator.cjs");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const envNames = [
  ...readFileSync(resolve(__dirname, "../../_infra/main.tf"), "utf8").matchAll(
    /name\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  ),
].map((v) => v[1]);
// Explicit non-content prompt selection/configuration, never arbitrary PROMPT values.
const promptConfiguration = new Set([
  "LANGFUSE_PROMPT_LABEL",
  "LANGFUSE_PROMPT_MEETING_SUMMARY",
  "LANGFUSE_PROMPT_CACHE_TTL_MS",
  "LANGFUSE_PROMPT_NOTES",
  "LANGFUSE_PROMPT_NOTES_LONG_STORY",
  "LANGFUSE_PROMPT_NOTES_CONTEXT_TEST",
  "LANGFUSE_PROMPT_TRANSCRIPTION_CLEANUP",
  "LANGFUSE_PROMPT_TRANSCRIPTION_COALESCE",
  "LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS",
  "LANGFUSE_PROMPT_TRANSCRIPTION",
  "LANGFUSE_PROMPT_IMAGE",
  "LANGFUSE_PROMPT_ASK",
  "LANGFUSE_PROMPT_NOTES_CORRECTION",
  "LANGFUSE_PROMPT_DICTIONARY_TEACHING",
  "LANGFUSE_PROMPT_LIVE_VOICE_GATE",
  "LANGFUSE_PROMPT_LIVE_VOICE_CONFIRM",
  "LANGFUSE_PROMPT_LIVE_VOICE_RESPONDER",
]);
const safeEnv = [
  ...new Set([...envNames, ...promptConfiguration, "DEPLOYMENT_CANDIDATE_ID"]),
].filter(
  (name) =>
    promptConfiguration.has(name) ||
    !/(KEY|SECRET|TOKEN|PASSWORD|PROMPT|REDIS_URL)/.test(name),
);
function definitionQuery() {
  return `{taskDefinition:taskDefinition.{taskDefinitionArn:taskDefinitionArn,family:family,status:status,cpu:cpu,memory:memory,networkMode:networkMode,taskRoleArn:taskRoleArn,executionRoleArn:executionRoleArn,requiresCompatibilities:requiresCompatibilities,runtimePlatform:runtimePlatform,volumes:volumes,containerDefinitions:containerDefinitions[].{name:name,image:image,essential:essential,cpu:cpu,memory:memory,memoryReservation:memoryReservation,command:command,entryPoint:entryPoint,stopTimeout:stopTimeout,portMappings:portMappings,healthCheck:healthCheck,logConfiguration:logConfiguration,mountPoints:mountPoints,linuxParameters:linuxParameters,secrets:secrets,environmentFiles:environmentFiles,environment:environment[?contains(\`${JSON.stringify(safeEnv)}\`,name)],environmentNames:environment[].name}}}`;
}
function definitionMetadata(definition) {
  const d = structuredClone(definition);
  delete d.taskDefinitionArn;
  for (const c of d.containerDefinitions) {
    delete c.image;
    delete c.stopTimeout;
    c.environment = c.environment
      .filter((v) => v.name !== "DEPLOYMENT_CANDIDATE_ID")
      .sort((a, b) => a.name.localeCompare(b.name));
    c.environmentNames = c.environmentNames
      .filter((name) => name !== "DEPLOYMENT_CANDIDATE_ID")
      .sort();
  }
  return d;
}
function createInventoryReader(m, aws) {
  const page = (items, token) => ({
    items,
    ...(token ? { nextToken: token } : {}),
  });
  const definition = async (arn) =>
    (
      await aws(
        "ecs",
        "describe-task-definition",
        { taskDefinition: arn },
        definitionQuery(),
      )
    ).taskDefinition;
  const paged = {
    listScalingTargets: [
      "application-autoscaling",
      "describe-scalable-targets",
      "ScalableTargets",
      "ResourceId",
    ],
    listScalingPolicies: [
      "application-autoscaling",
      "describe-scaling-policies",
      "ScalingPolicies",
      "PolicyARN",
    ],
    listScalingScheduledActions: [
      "application-autoscaling",
      "describe-scheduled-actions",
      "ScheduledActions",
      "ScheduledActionARN",
    ],
    listEventBuses: ["events", "list-event-buses", "EventBuses", "Name"],
    listRules: ["events", "list-rules", "Rules", "Name"],
    listRuleTargets: ["events", "list-targets-by-rule", "Targets", "Id"],
    listScheduleGroups: [
      "scheduler",
      "list-schedule-groups",
      "ScheduleGroups",
      "Name",
    ],
    listSchedules: ["scheduler", "list-schedules", "Schedules", "Name"],
  };
  async function read(operation, input) {
    if (
      input.accountId !== m.identity.accountId ||
      input.region !== m.identity.region ||
      input.clusterArn !== m.runtime.clusterArn
    )
      throw Error("inventory_scope_refused");
    if (operation === "listServices" || operation === "listTasks") {
      const service = operation === "listServices",
        key = service ? "serviceArns" : "taskArns";
      const r = await aws("ecs", service ? "list-services" : "list-tasks", {
        cluster: m.runtime.clusterArn,
        ...(!service ? { desiredStatus: input.desiredStatus } : {}),
        ...(input.nextToken ? { nextToken: input.nextToken } : {}),
      });
      return page(r[key], r.nextToken);
    }
    if (operation === "describeServices") {
      const r = await aws(
        "ecs",
        "describe-services",
        { cluster: m.runtime.clusterArn, services: input.arns },
        "{items:services[].{serviceArn:serviceArn,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount},failures:failures[].{arn:arn,reason:reason}}",
      );
      return r;
    }
    if (operation === "describeTasks") return describeTasks(input);
    if (operation === "describeTaskBinding") return describeTaskBinding(input);
    if (operation === "targetHealth") {
      const r = await aws(
        "elbv2",
        "describe-target-health",
        { TargetGroupArn: input.targetGroupArn },
        "TargetHealthDescriptions[].{targetId:Target.Id,state:TargetHealth.State}",
      );
      return { items: r };
    }
    return readLauncherPage(operation, input);
  }
  async function describeTasks(input) {
    const r = await aws(
      "ecs",
      "describe-tasks",
      { cluster: m.runtime.clusterArn, tasks: input.arns },
      "{items:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,group:group,lastStatus:lastStatus,desiredStatus:desiredStatus},failures:failures[].{arn:arn,reason:reason}}",
    );
    const running = r.items.filter((t) => t.lastStatus !== "STOPPED");
    const protection = running.length
      ? await aws("ecs", "get-task-protection", {
          cluster: m.runtime.clusterArn,
          tasks: running.map((t) => t.taskArn),
        })
      : { protectedTasks: [], failures: [] };
    if (
      protection.failures?.length ||
      protection.protectedTasks.length !== running.length
    )
      throw Error("protection_unconfirmed");
    return {
      items: r.items.map((t) => ({
        ...t,
        protectionEnabled:
          t.lastStatus === "STOPPED"
            ? false
            : protection.protectedTasks.find((p) => p.taskArn === t.taskArn)
                .protectionEnabled,
      })),
      failures: r.failures,
    };
  }
  async function describeTaskBinding(input) {
    const d = await definition(input.taskDefinitionArn),
      c = d.containerDefinitions.find((c) => c.name === m.runtime.container);
    if (!c || d.cpu !== "512" || d.memory !== "1024")
      throw Error("configuration_refused");
    const get = (name) => c.environment.find((e) => e.name === name)?.value;
    const prefix = get("DDB_TABLE_PREFIX"),
      suffixes = {
        deploymentControl: "DeploymentControlTable",
        activeMeeting: "ActiveMeetingTable",
        meetingHistory: "MeetingHistoryTable",
        meetingControl: "MeetingControlCommandTable",
        personalJob: "PersonalMediaUploadJobTable",
        personalSegment: "PersonalRecordingSegmentTable",
        notion: "NotionIntegrationTable",
        stripeWebhook: "StripeWebhookEventTable",
        guildSubscription: "GuildSubscriptionTable",
      };
    return {
      taskDefinitionArn: d.taskDefinitionArn,
      family: d.family,
      container: c.name,
      mode: runtimeMode(c),
      configurationHash: canonicalHash(definitionMetadata(d)),
      tables: Object.fromEntries(
        Object.entries(suffixes).map(([key, suffix]) => [key, prefix + suffix]),
      ),
      bucket: get("TRANSCRIPTS_BUCKET"),
      taskRoleArn: d.taskRoleArn,
      executionRoleArn: d.executionRoleArn,
    };
  }
  async function readLauncherPage(operation, input) {
    const spec = paged[operation];
    if (!spec) throw Error("inventory_operation_unsupported");
    const [service, method, list, key] = spec;
    const params = {
      ...(input.nextToken ? { NextToken: input.nextToken } : {}),
      ...(service === "application-autoscaling"
        ? {
            ServiceNamespace: "ecs",
            [operation === "listScalingTargets" ? "ResourceIds" : "ResourceId"]:
              operation === "listScalingTargets"
                ? [
                    `service/${m.runtime.clusterArn.split("/").at(-1)}/${m.runtime.serviceArn.split("/").at(-1)}`,
                  ]
                : `service/${m.runtime.clusterArn.split("/").at(-1)}/${m.runtime.serviceArn.split("/").at(-1)}`,
          }
        : {}),
    };
    if (input.eventBusId) params.EventBusName = input.eventBusId;
    if (input.ruleId) params.Rule = input.ruleId;
    if (input.groupId) params.GroupName = input.groupId;
    const r = await aws(
      service,
      method,
      params,
      `{items:${list}[].{id:${key}},nextToken:NextToken}`,
    );
    return page(r.items, r.nextToken);
  }
  return { read, definition };
}
module.exports = { createInventoryReader, definitionQuery, definitionMetadata };
