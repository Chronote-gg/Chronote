#!/usr/bin/env node
"use strict";
const {
  loadProductionPackage,
  verifyOwnershipEvidence,
} = require("./production-private-package.cjs");
const { assertProductionPreflight } = require("./production-preflight.cjs");
const { createProductionAws } = require("./production-aws.cjs");
const { createInventoryReader } = require("./production-inventory-adapter.cjs");
const { createCandidateInspection } = require("./production-candidate.cjs");
const { createProductionBootstrap } = require("./production-bootstrap.cjs");
const { createProductionHandoff } = require("./production-handoff.cjs");
const { verifyDeclaredRoutes } = require("./production-source-routes.cjs");
const { awsCli } = require("./coordinator-aws.cjs");
const { assertTargetGroups } = require("./bootstrap-sandbox.cjs");
function assertServiceTopology(svc, m, warming) {
  if (
    svc.serviceArn !== m.runtime.serviceArn ||
    svc.deploymentController?.type !== "ECS" ||
    (svc.deploymentConfiguration?.strategy &&
      svc.deploymentConfiguration.strategy !== "ROLLING") ||
    svc.loadBalancers?.length !== 1 ||
    svc.loadBalancers[0].targetGroupArn !==
      (warming ? m.resources.targetGroupB : m.resources.targetGroupA) ||
    svc.loadBalancers[0].containerName !== m.runtime.container ||
    svc.loadBalancers[0].containerPort !== 3001
  )
    throw Error("topology_prerequisite");
}
async function preflight(options, mode = "introduce") {
  const { binding, aws, candidate, now, inventory } = options,
    m = assertProductionPreflight(binding, now());
  if (now() + 1800 >= m.validUntil)
    throw Error("finite_execution_window_prerequisite");
  await candidate.definitions();
  const definition = await inventory.definition(m.runtime.candidateDefinition),
    container = definition.containerDefinitions.find(
      (c) => c.name === m.runtime.container,
    );
  if (
    container.portMappings?.length !== 1 ||
    container.portMappings[0].protocol !== "tcp" ||
    container.portMappings[0].containerPort !== 3001
  )
    throw Error("topology_prerequisite");
  assertServiceTopology(await candidate.service(), m, mode === "warming");
  const listener = await aws("elbv2", "describe-listeners", {
      ListenerArns: [m.resources.listenerArn],
    }),
    rules = await aws("elbv2", "describe-rules", {
      ListenerArn: m.resources.listenerArn,
    });
  if (
    listener.Listeners?.length !== 1 ||
    listener.Listeners[0].Protocol !== "HTTPS" ||
    rules.NextMarker ||
    rules.Rules?.length !== 1 ||
    !rules.Rules[0].IsDefault
  )
    throw Error("topology_prerequisite");
  await assertTargetGroups(
    {
      targetGroupA: m.resources.targetGroupA,
      targetGroupB: m.resources.targetGroupB,
      containerPort: container.portMappings[0].containerPort,
    },
    aws,
    listener.Listeners[0],
    mode === "introduce",
  );
}
async function continuationMode(options) {
  const ctl = await options.read({ pk: "ENV", sk: "CONTROL" });
  if (
    ctl?.servingGeneration === 0 &&
    !ctl.deployment &&
    Object.keys(ctl.servingMembers).length === 0
  )
    return "replace";
  else if (
    ctl?.servingGeneration === 1 &&
    ctl.deployment?.phase === "warming" &&
    ctl.deployment.routing?.state === "source"
  )
    return "warming";
  else throw Error("continuation_scope_refused");
}
async function introduceProduction(options, mode) {
  if (!["introduce", "continue"].includes(mode))
    throw Error("introduction_mode_refused");
  const continuation =
    mode === "continue" ? await continuationMode(options) : undefined;
  await preflight(options, continuation === "warming" ? "warming" : mode);
  const bootstrap = createProductionBootstrap(options);
  if (continuation === "warming")
    return createProductionHandoff(options, bootstrap).resume();
  const slot = mode === "introduce" ? "bootstrap" : "replacement";
  if (mode === "introduce") await bootstrap.initialize();
  else await bootstrap.replace();
  await bootstrap.launch(slot);
  await bootstrap.promote(slot);
  return createProductionHandoff(options, bootstrap).run(slot);
}
async function runCli(args = process.argv.slice(2), output = console) {
  try {
    if (args.length !== 1 || !["introduce", "continue"].includes(args[0]))
      throw Error();
    const loaded = await loadProductionPackage(process.env, awsCli, args[0]),
      { binding, evidence } = loaded;
    const provider = createProductionAws(binding),
      now = () => Math.floor(Date.now() / 1000),
      inventory = createInventoryReader(binding.manifest, provider.aws);
    const options = {
      ...provider,
      binding,
      evidence,
      now,
      inventory,
      declaredRoutes: verifyDeclaredRoutes(binding),
      compatibilityBinding: await verifyOwnershipEvidence(
        binding,
        evidence,
        process.env.GH_TOKEN,
      ),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    options.candidate = createCandidateInspection({
      ...options,
      definition: inventory.definition,
    });
    output.log(JSON.stringify(await introduceProduction(options, args[0])));
    return 0;
  } catch {
    output.error(
      JSON.stringify({
        status: "refused",
        reason: "introduction_prerequisite_or_recovery_required",
        admission: "preserve",
        deployment: "preserve",
      }),
    );
    return 1;
  }
}
module.exports = { runCli, introduceProduction, preflight };
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
