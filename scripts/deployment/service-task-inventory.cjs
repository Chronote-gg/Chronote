"use strict";

async function listServiceTaskArns(aws, manifest) {
  const arns = new Set();
  for (const desiredStatus of ["RUNNING", "STOPPED"]) {
    let nextToken;
    do {
      const page = await aws("ecs", "list-tasks", {
        cluster: manifest.cluster,
        serviceName: manifest.service,
        desiredStatus,
        ...(nextToken ? { nextToken } : {}),
      });
      for (const arn of page.taskArns) arns.add(arn);
      if (arns.size > 1000)
        throw new Error("Task inventory exceeds bootstrap bound");
      nextToken = page.nextToken;
    } while (nextToken);
  }
  return [...arns];
}

module.exports = { listServiceTaskArns };
