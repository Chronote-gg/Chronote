import { jest } from "@jest/globals";
import { parse, stringify } from "yaml";
import { resolve } from "node:path";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";

export const readActualSource = (...args) =>
  jest.requireActual("node:fs").readFileSync(...args);

// Synthetic reviewed workflow for protocol positives, not current deployment compatibility.
export function readOidcOnlySource(path, encoding) {
  const contents = readActualSource(path, encoding);
  const route = String(path).replaceAll("\\", "/");
  if (
    !route.endsWith(".github/workflows/deploy.yml") &&
    !route.endsWith(".github/workflows/terraform-apply.yml")
  )
    return contents;
  const workflow = parse(contents);
  if (route.endsWith("/deploy.yml")) {
    delete workflow.jobs["deploy-frontend"];
    delete workflow.jobs["deploy-docs"];
    workflow.jobs.deploybackend.needs = ["ci"];
  } else {
    workflow.jobs.apply.steps = workflow.jobs.apply.steps.filter(
      (step) => !step.with?.["aws-access-key-id"],
    );
  }
  return stringify(workflow);
}

export const sourceTransport = { read: readOidcOnlySource };

export function reviewedRoutes(m, read = sourceTransport.read) {
  return [
    ["workflow", ".github/workflows/deploy.yml"],
    ["workflow", ".github/workflows/terraform-apply.yml"],
    ["manual", "scripts/force-deployment.ps1"],
  ].map(([kind, id]) => ({
    kind,
    id,
    evidenceHash: canonicalHash({
      sourceCommit: m.identity.sourceCommit,
      path: id,
      contents: read(resolve(id), "utf8").replace(/\r\n/g, "\n"),
    }),
  }));
}
