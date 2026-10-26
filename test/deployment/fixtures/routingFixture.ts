import { fixture, oldIdentity, candidateIdentity } from "./coordinatorFixture";
import { createCoordinator } from "../../../scripts/deployment/coordinator.cjs";
import { action } from "../../../scripts/deployment/routing.cjs";

export function routingFixture() {
  const f = fixture();
  const routing = {
    listenerArn: "listener",
    sourceGroup: "group-a",
    candidateGroup: "group-b",
    containerName: "fixture",
    containerPort: 3001,
    sourceRevision: "revision-old",
    state: "source",
  };
  const binding = (candidate = false) => [
    {
      targetGroupArn: candidate ? "group-b" : "group-a",
      containerName: "fixture",
      containerPort: 3001,
    },
  ];
  Object.assign(f.svc, { loadBalancers: binding() });
  const target = (candidate = false) => ({
    Target: { Id: candidate ? "10.0.0.2" : "10.0.0.1", Port: 3001 },
    TargetHealth: { State: "healthy" },
  });
  const traffic = {
    actions: action(routing, false),
    sourceTargets: [target()],
    candidateTargets: [] as ReturnType<typeof target>[],
    unknown: false,
    failBeforeApply: false,
    extraRules: false,
    revisionMismatch: false,
  };
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, raw) => {
    const input = raw as {
      TargetGroupArn: string;
      DefaultActions: ReturnType<typeof action>;
      serviceDeploymentArns: string[];
      serviceRevisionArns: string[];
      loadBalancers: typeof f.svc.loadBalancers;
    };
    if (service === "elbv2") {
      f.calls.push({ operation, input });
      switch (operation) {
        case "describe-listeners":
          return {
            Listeners: [
              {
                ListenerArn: "listener",
                Protocol: "HTTPS",
                LoadBalancerArn: "alb",
                DefaultActions: traffic.actions,
              },
            ],
          };
        case "describe-rules":
          return {
            Rules: traffic.extraRules
              ? [{ IsDefault: true }, { IsDefault: false }]
              : [{ IsDefault: true }],
          };
        case "describe-target-groups":
          return {
            TargetGroups: ["group-a", "group-b"].map((TargetGroupArn) => ({
              TargetGroupArn,
              TargetType: "ip",
              Protocol: "HTTP",
              Port: 3001,
              HealthCheckPath: "/health",
              LoadBalancerArns: ["alb"],
              VpcId: "vpc",
            })),
          };
        case "describe-target-group-attributes":
          return {
            Attributes: [{ Key: "stickiness.enabled", Value: "false" }],
          };
        case "describe-target-health":
          return {
            TargetHealthDescriptions:
              input.TargetGroupArn === "group-a"
                ? traffic.sourceTargets
                : traffic.candidateTargets,
          };
        case "modify-listener":
          if (!traffic.failBeforeApply) traffic.actions = input.DefaultActions;
          if (traffic.unknown) throw new Error("Provider response unknown");
          return { Listeners: [] };
        default:
          throw new Error(`Unexpected routing operation ${operation}`);
      }
    }
    if (operation === "list-service-deployments")
      return {
        serviceDeployments: [
          { serviceDeploymentArn: "deployment-old" },
          ...(f.state.launched
            ? [{ serviceDeploymentArn: "deployment-new" }]
            : []),
        ],
      };
    if (operation === "describe-service-deployments")
      return {
        serviceDeployments: input.serviceDeploymentArns.map((arn: string) => ({
          targetServiceRevision: {
            arn: arn.endsWith("old") ? "revision-old" : "revision-new",
          },
          sourceServiceRevisions: [],
        })),
      };
    if (operation === "describe-service-revisions")
      return {
        serviceRevisions: input.serviceRevisionArns.map(
          (serviceRevisionArn: string) => ({
            serviceRevisionArn,
            taskDefinition: serviceRevisionArn.endsWith("old")
              ? "definition:old"
              : "definition:new",
            loadBalancers: binding(
              traffic.revisionMismatch
                ? false
                : !serviceRevisionArn.endsWith("old"),
            ),
          }),
        ),
      };
    const result = await original(service, operation, input);
    if (operation === "update-service") {
      Object.assign(f.svc, { loadBalancers: input.loadBalancers });
      traffic.candidateTargets = [target(true)];
    }
    if (operation === "describe-tasks")
      for (const task of (
        result as {
          tasks: {
            taskArn: string;
            containers: {
              name: string;
              networkInterfaces: { privateIpv4Address: string }[];
            }[];
          }[];
        }
      ).tasks) {
        task.containers[0].name = "fixture";
        task.containers[0].networkInterfaces = [
          {
            privateIpv4Address:
              task.taskArn === oldIdentity.taskArn ? "10.0.0.1" : "10.0.0.2",
          },
        ];
      }
    return result;
  });
  const options = {
    ...f.options,
    env: {
      ...f.options.env,
      DEPLOYMENT_LISTENER_ARN: "listener",
      DEPLOYMENT_TARGET_GROUP_A: "group-a",
      DEPLOYMENT_TARGET_GROUP_B: "group-b",
    },
  };
  return {
    ...f,
    traffic,
    routing,
    target,
    options,
    coordinator: createCoordinator(options),
    oldIdentity,
    candidateIdentity,
  };
}
