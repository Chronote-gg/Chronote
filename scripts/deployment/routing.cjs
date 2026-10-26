"use strict";
const { isDeepStrictEqual } = require("node:util");

function action(routing, candidate) {
  return [
    {
      Type: "forward",
      ForwardConfig: {
        TargetGroups: [
          { TargetGroupArn: routing.sourceGroup, Weight: candidate ? 0 : 100 },
          {
            TargetGroupArn: routing.candidateGroup,
            Weight: candidate ? 100 : 0,
          },
        ],
        TargetGroupStickinessConfig: { Enabled: false },
      },
    },
  ];
}
function canonical(actions) {
  if (actions?.length !== 1 || actions[0].Type !== "forward") return undefined;
  const value = actions[0];
  if (
    Object.keys(value).some(
      (key) => !["Type", "Order", "ForwardConfig"].includes(key),
    )
  )
    return undefined;
  const forward = value.ForwardConfig;
  if (
    !forward ||
    forward.TargetGroupStickinessConfig?.Enabled !== false ||
    Object.keys(forward).some(
      (key) => !["TargetGroups", "TargetGroupStickinessConfig"].includes(key),
    )
  )
    return undefined;
  return [...forward.TargetGroups].sort((a, b) =>
    a.TargetGroupArn.localeCompare(b.TargetGroupArn),
  );
}
function createRouting({ aws, config, env, failure }) {
  const fail = (message) => {
    throw failure("routing_unconfirmed", message);
  };
  function assertInputs(routing) {
    const listenerArn = env.DEPLOYMENT_LISTENER_ARN?.trim();
    const pair = [
      env.DEPLOYMENT_TARGET_GROUP_A?.trim(),
      env.DEPLOYMENT_TARGET_GROUP_B?.trim(),
    ];
    if (!routing) {
      if (listenerArn || pair.some(Boolean))
        fail("Routing inputs do not match this deployment");
      return;
    }
    if (
      listenerArn !== routing.listenerArn ||
      pair[0] === pair[1] ||
      !pair.includes(routing.sourceGroup) ||
      !pair.includes(routing.candidateGroup)
    )
      fail("Routing inputs changed during the owned deployment");
  }
  async function listener(routing) {
    const result = await aws("elbv2", "describe-listeners", {
      ListenerArns: [routing.listenerArn],
    });
    if (
      result.Listeners?.length !== 1 ||
      result.Listeners[0].ListenerArn !== routing.listenerArn ||
      result.Listeners[0].Protocol !== "HTTPS"
    )
      fail("Exact HTTPS listener unavailable");
    const value = result.Listeners[0];
    const rules = await aws("elbv2", "describe-rules", {
      ListenerArn: routing.listenerArn,
    });
    if (
      rules.NextMarker ||
      rules.Rules?.length !== 1 ||
      !rules.Rules[0].IsDefault
    )
      fail("Listener has unreviewed routing rules");
    return value;
  }
  async function assertAction(routing, candidate) {
    const value = await listener(routing);
    if (
      !isDeepStrictEqual(
        canonical(value.DefaultActions),
        canonical(action(routing, candidate)),
      )
    )
      fail("Listener routing differs from the owned action");
  }
  async function observe(routing) {
    try {
      const observed = canonical((await listener(routing)).DefaultActions);
      if (isDeepStrictEqual(observed, canonical(action(routing, true))))
        return "candidate";
      if (isDeepStrictEqual(observed, canonical(action(routing, false))))
        return "source";
      return "foreign";
    } catch {
      return "unavailable";
    }
  }
  async function groups(routing) {
    const value = await listener(routing);
    const arns = [routing.sourceGroup, routing.candidateGroup];
    const result = await aws("elbv2", "describe-target-groups", {
      TargetGroupArns: arns,
    });
    if (result.TargetGroups?.length !== 2)
      fail("Exact two target groups required");
    let vpc;
    for (const group of result.TargetGroups) {
      if (
        !arns.includes(group.TargetGroupArn) ||
        group.TargetType !== "ip" ||
        group.Protocol !== "HTTP" ||
        group.Port !== routing.containerPort ||
        group.HealthCheckPath !== "/health" ||
        !group.LoadBalancerArns?.includes(value.LoadBalancerArn) ||
        !group.VpcId ||
        (vpc && vpc !== group.VpcId)
      )
        fail("Target group configuration differs from the reviewed topology");
      vpc = group.VpcId;
      const attributes = await aws(
        "elbv2",
        "describe-target-group-attributes",
        { TargetGroupArn: group.TargetGroupArn },
      );
      if (
        attributes.Attributes?.find((item) => item.Key === "stickiness.enabled")
          ?.Value !== "false"
      )
        fail("Target stickiness must be disabled");
    }
  }
  function binding(routing, candidate) {
    return [
      {
        targetGroupArn: candidate
          ? routing.candidateGroup
          : routing.sourceGroup,
        containerName: routing.containerName,
        containerPort: routing.containerPort,
      },
    ];
  }
  function assertBinding(svc, routing, candidate) {
    if (!isDeepStrictEqual(svc.loadBalancers, binding(routing, candidate)))
      fail("Service target binding changed");
  }
  async function targets(group) {
    return (
      (await aws("elbv2", "describe-target-health", { TargetGroupArn: group }))
        .TargetHealthDescriptions ?? []
    );
  }
  async function taskAddress(routing, identity, definition) {
    const result = await aws("ecs", "describe-tasks", {
      cluster: config.cluster,
      tasks: [identity.taskArn],
    });
    const task = result.tasks?.[0];
    const container = task?.containers?.find(
      (item) => item.name === routing.containerName,
    );
    const ips =
      container?.networkInterfaces?.map((item) => item.privateIpv4Address) ??
      [];
    if (
      result.failures?.length ||
      result.tasks?.length !== 1 ||
      task.taskArn !== identity.taskArn ||
      task.taskDefinitionArn !== definition ||
      task.lastStatus !== "RUNNING" ||
      container?.imageDigest !== identity.imageDigest ||
      ips.length !== 1 ||
      !ips[0]
    )
      fail("Exact target task address unavailable");
    return ips[0];
  }
  async function target(
    routing,
    group,
    identity,
    definition,
    requireHealthy = true,
  ) {
    const address = await taskAddress(routing, identity, definition);
    const members = await targets(group);
    if (
      members.length !== 1 ||
      members[0].Target.Id !== address ||
      members[0].Target.Port !== routing.containerPort
    )
      fail("Target group does not contain the exact owner only");
    if (requireHealthy && members[0].TargetHealth.State !== "healthy")
      fail("Routing destination target is not healthy");
  }
  async function revisionArns() {
    const arns = new Set();
    let nextToken;
    do {
      const page = await aws("ecs", "list-service-deployments", {
        cluster: config.cluster,
        service: config.service,
        ...(nextToken ? { nextToken } : {}),
      });
      const deployments = page.serviceDeployments ?? [];
      for (let index = 0; index < deployments.length; index += 20) {
        const details = await aws("ecs", "describe-service-deployments", {
          serviceDeploymentArns: deployments
            .slice(index, index + 20)
            .map((item) => item.serviceDeploymentArn),
        });
        if (details.failures?.length)
          fail("Deployment revision lookup incomplete");
        for (const item of details.serviceDeployments ?? []) {
          arns.add(item.targetServiceRevision?.arn);
          for (const source of item.sourceServiceRevisions ?? [])
            arns.add(source.arn);
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    arns.delete(undefined);
    return arns;
  }
  async function revision(taskDefinition, expectedBinding, expectedArn) {
    const arns = await revisionArns();
    if (expectedArn) arns.add(expectedArn);
    const matches = [];
    const all = [...arns];
    for (let index = 0; index < all.length; index += 20) {
      const result = await aws("ecs", "describe-service-revisions", {
        serviceRevisionArns: all.slice(index, index + 20),
      });
      if (result.failures?.length) fail("Service revision lookup incomplete");
      for (const item of result.serviceRevisions ?? []) {
        if (
          item.taskDefinition === taskDefinition &&
          isDeepStrictEqual(item.loadBalancers, expectedBinding)
        )
          matches.push(item.serviceRevisionArn);
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length !== 1 || (expectedArn && unique[0] !== expectedArn))
      fail("Exact revision binding is ambiguous or unavailable");
    return unique[0];
  }
  async function prepare(svc, outgoing) {
    const listenerArn = env.DEPLOYMENT_LISTENER_ARN?.trim();
    const pair = [
      env.DEPLOYMENT_TARGET_GROUP_A?.trim(),
      env.DEPLOYMENT_TARGET_GROUP_B?.trim(),
    ];
    if (!svc.loadBalancers?.length) {
      if (listenerArn || pair.some(Boolean))
        fail("Routing inputs supplied for a service without a load balancer");
      return undefined;
    }
    if (
      !listenerArn ||
      pair.some((value) => !value) ||
      pair[0] === pair[1] ||
      svc.loadBalancers.length !== 1
    )
      fail("ALB-backed deployment requires explicit distinct routing slots");
    const source = svc.loadBalancers[0];
    if (!pair.includes(source.targetGroupArn) || source.containerPort !== 3001)
      fail("Source binding is outside the reviewed routing slots");
    const routing = {
      listenerArn,
      sourceGroup: source.targetGroupArn,
      candidateGroup: pair.find((group) => group !== source.targetGroupArn),
      containerName: source.containerName,
      containerPort: source.containerPort,
      sourceRevision: await revision(svc.taskDefinition, svc.loadBalancers),
      state: "source",
    };
    await groups(routing);
    await assertAction(routing, false);
    await target(routing, routing.sourceGroup, outgoing, svc.taskDefinition);
    if ((await targets(routing.candidateGroup)).length)
      fail("Spare target group is occupied, draining or unresolved");
    return routing;
  }
  async function validate(ctl, svc, candidate, candidateHealthy = true) {
    const d = ctl.deployment;
    const r = d.routing;
    if (!r) {
      if (svc.loadBalancers?.length) fail("Deployment lacks routing ownership");
      return;
    }
    assertBinding(svc, r, true);
    await groups(r);
    await revision(
      d.previousTaskDefinition,
      binding(r, false),
      r.sourceRevision,
    );
    await target(r, r.sourceGroup, d.outgoing, d.previousTaskDefinition);
    await target(
      r,
      r.candidateGroup,
      candidate,
      d.taskDefinition,
      candidateHealthy,
    );
    return revision(d.taskDefinition, binding(r, true), r.candidateRevision);
  }
  const validateRollback = (ctl, svc) =>
    validate(ctl, svc, ctl.deployment.candidate, false);
  async function switchTraffic(ctl, candidate, persist, assertAuthority) {
    const r = ctl.deployment.routing;
    if (!r) return ctl;
    const submitted = candidate ? "forward_submitted" : "rollback_submitted";
    const acknowledged = candidate ? "candidate" : "rolled_back";
    if (r.state.endsWith("_submitted"))
      fail(
        "Routing request settlement is unknown; separate reconciliation is required",
      );
    if (r.state === acknowledged) {
      await assertAction(r, candidate);
      return ctl;
    }
    if (r.state !== (candidate ? "source" : "candidate"))
      fail("Routing direction lacks authority");
    await assertAction(r, !candidate);
    ctl = await persist(ctl, { ...r, state: submitted });
    // The durable submitted marker survives failure, timeout and process death.
    // A GET showing intended weights must never clear it or permit an opposite write.
    await assertAuthority(ctl);
    await aws("elbv2", "modify-listener", {
      ListenerArn: r.listenerArn,
      DefaultActions: action(r, candidate),
    });
    await assertAction(r, candidate);
    return persist(ctl, { ...r, state: acknowledged });
  }
  async function serving(ctl, svc) {
    const d = ctl.deployment;
    if (!d.routing) {
      if (svc.loadBalancers?.length) fail("Deployment lacks routing ownership");
      return;
    }
    assertBinding(svc, d.routing, true);
    await groups(d.routing);
    await target(
      d.routing,
      d.routing.candidateGroup,
      d.candidate,
      d.taskDefinition,
    );
    await revision(
      d.taskDefinition,
      binding(d.routing, true),
      d.routing.candidateRevision,
    );
  }
  return {
    prepare,
    observe,
    assertInputs,
    validate,
    validateRollback,
    binding,
    assertBinding,
    assertAction,
    switchTraffic,
    targets,
    serving,
  };
}
module.exports = { createRouting, action, canonical };
