"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { parse } = require("yaml");
const { canonicalHash } = require("./production-manifest.cjs");
const receipts = new WeakMap();
const paths = [
  ["workflow", ".github/workflows/deploy.yml"],
  ["workflow", ".github/workflows/terraform-apply.yml"],
  ["workflow", ".github/workflows/production-introduction.yml"],
  ["manual", "scripts/force-deployment.ps1"],
];
function assertWorkflowCredentials(contents) {
  const workflow = parse(contents);
  if (
    !workflow?.jobs ||
    typeof workflow.jobs !== "object" ||
    Array.isArray(workflow.jobs)
  )
    throw Error("source_route_prerequisite");
  // Static credential inputs/references are outside the reviewed seven-role identity inventory.
  const source = JSON.stringify(workflow);
  if (
    /"(?:aws-access-key-id|aws-secret-access-key|aws-session-token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)"\s*:/i.test(
      source,
    ) ||
    /\b(?:secrets|vars)\.(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\b/.test(
      source,
    )
  )
    throw Error("unaccounted_static_credential_route");
}
function assertStagedRoute(contents, root) {
  const workflow = parse(contents);
  const expectedActions = [
    "sts:GetCallerIdentity",
    "dynamodb:GetItem",
    "ecs:DescribeServices",
    "ecs:ListTasks",
    "ecs:DescribeTasks",
  ];
  if (
    JSON.stringify(Object.keys(workflow.jobs).sort()) !==
    JSON.stringify(["bind", "execute"])
  )
    throw Error("staged_source_prerequisite");
  for (const job of Object.values(workflow.jobs)) {
    const identities = job.steps.filter((step) =>
      step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
    );
    if (
      job.environment !== "production" ||
      identities.length !== 1 ||
      identities[0].with["role-to-assume"] !==
        "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}"
    )
      throw Error("staged_source_prerequisite");
    const policy = JSON.parse(identities[0].with["inline-session-policy"]);
    const expected = {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: expectedActions, Resource: "*" },
        {
          Effect: "Allow",
          Action: "kms:Decrypt",
          Resource: "*",
          Condition: {
            StringEquals: {
              "kms:ViaService": "dynamodb.${{ vars.AWS_REGION }}.amazonaws.com",
              "kms:CallerAccount": "${{ vars.AWS_ACCOUNT_ID }}",
            },
          },
        },
      ],
    };
    if (canonicalHash(policy) !== canonicalHash(expected))
      throw Error("staged_source_prerequisite");
  }
  const source = readFileSync(
    resolve(root, "scripts/deployment/production-workflow.cjs"),
    "utf8",
  );
  for (const required of [
    "./staged-production-manifest.cjs",
    "./staged-introduce-production.cjs",
    'throw new Error("Post-bind human authority unavailable; preserve state")',
  ])
    if (!source.includes(required)) throw Error("staged_source_prerequisite");
}
function verifyDeclaredRoutes(binding) {
  const root = resolve(__dirname, "../..");
  try {
    if (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() !== binding.manifest.identity.sourceCommit
    )
      throw Error();
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "."], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw Error("source_route_prerequisite");
  }
  const expected = paths.map(([kind, id]) => {
    const contents = readFileSync(resolve(root, id), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    if (kind === "workflow") assertWorkflowCredentials(contents);
    if (id === ".github/workflows/production-introduction.yml")
      assertStagedRoute(contents, root);
    return {
      kind,
      id,
      evidenceHash: canonicalHash({
        sourceCommit: binding.manifest.identity.sourceCommit,
        path: id,
        contents,
      }),
    };
  });
  if (
    canonicalHash(expected) !== canonicalHash(binding.manifest.launcherRoutes)
  )
    throw Error("source_route_prerequisite");
  const receipt = {};
  const path = "src/services/transcriptionPromptService.ts";
  const template = {
    path,
    sourceCommit: binding.manifest.identity.sourceCommit,
    sourceSha256: createHash("sha256")
      .update(readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n"))
      .digest("hex"),
  };
  receipts.set(receipt, { scopeHash: binding.manifestHash, template });
  return receipt;
}
function declaredRoutesVerified(receipt, scopeHash) {
  return receipts.get(receipt)?.scopeHash === scopeHash;
}
function readVerifiedFallbackTemplates(receipt, scopeHash, paths) {
  const verified = receipts.get(receipt);
  if (
    !verified ||
    verified.scopeHash !== scopeHash ||
    paths.some((path) => path !== verified.template.path)
  )
    throw Error("fallback_source_prerequisite");
  return paths.map(() => ({ ...verified.template }));
}
module.exports = {
  verifyDeclaredRoutes,
  declaredRoutesVerified,
  readVerifiedFallbackTemplates,
};
