"use strict";
const assert = require("node:assert/strict");
function assertStoppedSource(source, deployment, config, now) {
  assert.equal(source?.lastStatus, "STOPPED");
  assert.equal(source.desiredStatus, "STOPPED");
  assert.equal(source.taskArn, deployment.outgoing.taskArn);
  assert.equal(source.taskDefinitionArn, deployment.previousTaskDefinition);
  assert.equal(source.group, "service:" + config.service);
  assert.ok(
    Number.isFinite(Date.parse(source.stoppedAt)) &&
      Date.parse(source.stoppedAt) <= now() * 1000,
  );
  assert.equal(
    source.containers?.find((c) => c.name === deployment.routing.containerName)
      ?.imageDigest,
    deployment.outgoing.imageDigest,
  );
}
module.exports = { assertStoppedSource };
