import {
  parseExecution,
  bindExecution,
  canonicalHash,
} from "../../scripts/deployment/production-manifest.cjs";
function fixture() {
  const accountId = "123456789012",
    region = "us-east-1";
  const ecs = `arn:aws:ecs:${region}:${accountId}:`;
  const elb = `arn:aws:elasticloadbalancing:${region}:${accountId}:`;
  const m = {
    kind: "execution",
    schemaVersion: 1,
    environment: "production",
    introductionId: "intro",
    holdId: "hold",
    operationId: "op",
    validFrom: 100,
    validUntil: 200,
    identity: {
      accountId,
      region,
      repository: "example/app",
      githubEnvironment: "production",
      ref: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      workflow:
        "example/app/.github/workflows/introduction.yml@refs/heads/main",
      runId: "10",
      runAttempt: "1",
      roleArn: `arn:aws:iam::${accountId}:role/deploy`,
      sessionName: "intro-10-1",
    },
    runtime: {
      clusterArn: ecs + "cluster/app",
      serviceArn: ecs + "service/app/app",
      family: "app",
      container: "app",
      mode: "all",
      cpu: 512,
      memory: 1024,
      legacyDefinition: ecs + "task-definition/app:1",
      legacyTaskArns: [ecs + "task/app/old"],
      candidateId: "candidate",
      candidateDefinition: ecs + "task-definition/app:2",
      candidateDigest: "sha256:" + "b".repeat(64),
      continuationDefinition: ecs + "task-definition/app:3",
      continuationDigest: "sha256:" + "c".repeat(64),
      configurationHash: "d".repeat(64),
    },
    resources: {
      tables: {
        deploymentControl: "test-control",
        activeMeeting: "test-active",
        meetingHistory: "test-history",
        meetingControl: "test-commands",
        personalJob: "test-jobs",
        personalSegment: "test-segments",
        notion: "test-notion",
        stripeWebhook: "test-stripe",
        guildSubscription: "test-subscriptions",
      },
      bucket: "test-artifacts",
      artifactPrefixes: ["recordings/"],
      listenerArn: elb + "listener/app/app/l/x",
      targetGroupA: elb + "targetgroup/a/x",
      targetGroupB: elb + "targetgroup/b/x",
      taskRoleArn: `arn:aws:iam::${accountId}:role/task`,
      executionRoleArn: `arn:aws:iam::${accountId}:role/execution`,
      configurationReferenceHash: "e".repeat(64),
    },
    handoff: {
      runToken: "fixture-run",
      priorRunToken: "bootstrap-run",
      priorEpoch: 1,
      priorGeneration: 1,
      priorCandidateId: "candidate",
      candidateId: "replacement",
      grants: [
        {
          grantId: "g1",
          commandId: "r1",
          meetingId: "m1",
          guildId: "guild",
          voiceChannelId: "voice",
          textChannelId: "text",
          actorUserId: "actor",
          sessionMode: "meeting",
        },
        {
          grantId: "g2",
          commandId: "r2",
          meetingId: "m2",
          guildId: "guild",
          voiceChannelId: "voice",
          textChannelId: "text",
          actorUserId: "actor",
          sessionMode: "meeting",
        },
      ],
    },
    prerequisites: {
      sourceTests: "f".repeat(64),
      plan: "f".repeat(64),
      launcherHolds: "f".repeat(64),
      retainedDisposition: "f".repeat(64),
      fixtureChecklist: "f".repeat(64),
      executionApproval: "f".repeat(64),
    },
    launcherRoutes: [
      { kind: "workflow", id: "deploy", evidenceHash: "f".repeat(64) },
      { kind: "manual", id: "operator", evidenceHash: "f".repeat(64) },
    ],
    actions: [
      {
        actionId: "stop",
        kind: "stop_legacy",
        taskArn: ecs + "task/app/old",
        predecessor: null,
      },
      {
        actionId: "route",
        kind: "route_maintenance",
        predecessor: "stop",
        targetGroup: "b",
      },
      {
        actionId: "launch",
        kind: "launch_candidate",
        predecessor: "route",
        slot: "bootstrap",
      },
    ],
  };
  return m;
}
function bound(m = fixture()) {
  const parsed = parseExecution(m, canonicalHash(m));
  return bindExecution(
    parsed,
    { ...m.identity, now: 150, endpointOverrides: [] },
    {
      accountId: m.identity.accountId,
      arn: `arn:aws:sts::${m.identity.accountId}:assumed-role/deploy/${m.identity.sessionName}`,
    },
  );
}

export { fixture, bound };
