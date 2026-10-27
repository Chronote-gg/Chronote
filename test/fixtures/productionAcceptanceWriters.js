import { contentFixture } from "./productionFixtureContent.js";
import { counts } from "../deployment/fixtures/coordinatorFixture";
export function writerFixture() {
  const f = contentFixture(),
    m = f.binding.manifest;
  const runtimes = f.fixtures.map(({ runtime }) => runtime);
  const [prior, current] = runtimes;
  for (const r of runtimes) {
    r.workCounts = counts();
    r.protection.expiresAt = 1000;
  }
  prior.retirementRequest = {
    identity: prior.identity,
    authorizedGeneration: 1,
    coordinatorToken: m.handoff.runToken,
    coordinatorEpoch: 2,
  };
  prior.retirementAcknowledgment = {
    request: prior.retirementRequest,
    retiredAt: 310,
  };
  f.control.deployment.candidate = current.identity;
  f.control.deployment.taskDefinition = m.runtime.continuationDefinition;
  f.control.deployment.routing = {
    listenerArn: m.resources.listenerArn,
    sourceGroup: m.resources.targetGroupA,
    candidateGroup: m.resources.targetGroupB,
    containerName: "app",
    containerPort: 3001,
    sourceRevision: "old-revision",
    candidateRevision: "new-revision",
    state: "candidate",
  };
  const tasks = [
    {
      taskArn: m.runtime.legacyTaskArns[0],
      taskDefinitionArn: m.runtime.legacyDefinition,
      group: "service:app",
      lastStatus: "STOPPED",
      desiredStatus: "STOPPED",
      protectionEnabled: false,
    },
    ...runtimes.map((r, index) => ({
      taskArn: r.identity.taskArn,
      taskDefinitionArn: index
        ? m.runtime.continuationDefinition
        : m.runtime.candidateDefinition,
      group: "service:app",
      lastStatus: index ? "RUNNING" : "STOPPED",
      desiredStatus: index ? "RUNNING" : "STOPPED",
      protectionEnabled: Boolean(index),
      protectionExpiresAt: new Date(1000000).toISOString(),
      containers: [
        {
          name: "app",
          imageDigest: r.identity.imageDigest,
          networkInterfaces: [{ privateIpv4Address: `10.0.0.${index + 1}` }],
        },
      ],
    })),
  ];
  return {
    m,
    control: f.control,
    fixtureAuthority: f.authority,
    runtimes,
    now: 320,
    inventory: {
      scopeHash: f.binding.manifestHash,
      blockers: [],
      tasks,
      services: [
        {
          serviceArn: m.runtime.serviceArn,
          desiredCount: 1,
          runningCount: 1,
          pendingCount: 0,
        },
      ],
      targets: [
        {
          targetGroupArn: m.resources.targetGroupB,
          targetId: "10.0.0.2",
          state: "healthy",
        },
      ],
      launchers: [],
    },
  };
}
