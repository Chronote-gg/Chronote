"use strict";
const serviceFields =
  "serviceArn:serviceArn,taskDefinition:taskDefinition,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,deploymentController:deploymentController,deploymentConfiguration:deploymentConfiguration,loadBalancers:loadBalancers,deployments:deployments[].{taskDefinition:taskDefinition,rolloutState:rolloutState,status:status}";
const taskFields =
  "taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,group:group,lastStatus:lastStatus,desiredStatus:desiredStatus,overrides:overrides.containerOverrides[].{name:name,environmentNames:environment[].name,environmentFiles:environmentFiles,commandLength:length(command || `[]`)},containers:containers[].{name:name,imageDigest:imageDigest,networkInterfaces:networkInterfaces[].{privateIpv4Address:privateIpv4Address}}";
const projections = {
  "ecs.describe-services": `{services:services[].{${serviceFields}},failures:failures[].{arn:arn,reason:reason}}`,
  "ecs.describe-tasks": `{tasks:tasks[].{${taskFields}},failures:failures[].{arn:arn,reason:reason}}`,
  "ecs.update-service": `{service:service.{${serviceFields}}}`,
  "ecs.stop-task": `{task:task.{${taskFields}}}`,
  "elbv2.describe-listeners":
    "{Listeners:Listeners[].{ListenerArn:ListenerArn,LoadBalancerArn:LoadBalancerArn,Protocol:Protocol,DefaultActions:DefaultActions[].{Type:Type,Order:Order,TargetGroupArn:TargetGroupArn,ForwardConfig:ForwardConfig}},NextMarker:NextMarker}",
  "elbv2.modify-listener":
    "{Listeners:Listeners[].{ListenerArn:ListenerArn,DefaultActions:DefaultActions[].{Type:Type,Order:Order,TargetGroupArn:TargetGroupArn,ForwardConfig:ForwardConfig}}}",
  "elbv2.describe-rules":
    "{Rules:Rules[].{IsDefault:IsDefault},NextMarker:NextMarker}",
  "ecr.describe-images":
    "{imageDetails:imageDetails[].{imageDigest:imageDigest,imageTags:imageTags}}",
};
function projection(service, operation) {
  if (service === "ecs" && operation === "describe-task-definition")
    return require("./production-inventory-adapter.cjs").definitionQuery();
  return projections[`${service}.${operation}`];
}
function cleanProjection(value) {
  if (Array.isArray(value)) return value.map(cleanProjection);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, cleanProjection(v)]),
    );
  return value;
}
module.exports = { projection, cleanProjection };
