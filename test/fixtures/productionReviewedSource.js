import { jest } from "@jest/globals";
import { parse, stringify } from "yaml";
import { resolve } from "node:path";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";

export const readActualSource = (...args) =>
  jest.requireActual("node:fs").readFileSync(...args);

// Protocol positives now retain both real site publishers and their guards.
export const readOidcOnlySource = readActualSource;

export function readStaticCredentialSource(path, encoding) {
  const contents = readActualSource(path, encoding);
  if (
    !String(path).replaceAll("\\", "/").endsWith(".github/workflows/deploy.yml")
  )
    return contents;
  const workflow = parse(contents);
  workflow.jobs["deploy-docs"].steps.push({
    uses: "aws-actions/configure-aws-credentials@v6",
    with: { "aws-access-key-id": "SYNTHETIC_UNACCOUNTED" },
  });
  return stringify(workflow);
}

export const sourceTransport = { read: readOidcOnlySource };

export function reviewedRoutes(m, read = sourceTransport.read) {
  return [
    ["workflow", ".github/workflows/deploy.yml"],
    ["workflow", ".github/workflows/terraform-apply.yml"],
    ["workflow", ".github/workflows/production-introduction.yml"],
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
