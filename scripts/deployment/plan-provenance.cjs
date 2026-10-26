"use strict";
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { z } = require("zod");
const text = z.string().min(1);
const provenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: text,
    source: z.string().regex(/^[a-f0-9]{40}$/),
    ref: text,
    workflow: text,
    runId: text,
    runAttempt: text,
    environment: z.enum(["production", "sandbox"]),
    workspace: text,
    scope: text,
    artifact: text,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assertPlanProvenance({ provenance, bytes, expected, producingRun }) {
  const p = provenanceSchema.parse(provenance);
  if (
    p.planHash !== bytesHash(bytes) ||
    Object.entries(expected).some(([k, v]) => p[k] !== v) ||
    String(producingRun.id) !== p.runId ||
    String(producingRun.run_attempt) !== p.runAttempt ||
    producingRun.head_sha !== p.source ||
    producingRun.repository?.full_name !== p.repository ||
    `refs/heads/${producingRun.head_branch}` !== p.ref ||
    producingRun.path !== ".github/workflows/terraform-plan.yml" ||
    p.workflow !==
      `${p.repository}/.github/workflows/terraform-plan.yml@${p.ref}` ||
    producingRun.conclusion !== "success"
  )
    throw new Error("plan_provenance_refused");
  return p;
}
function recordPlan(env) {
  return provenanceSchema.parse({
    schemaVersion: 1,
    repository: env.GITHUB_REPOSITORY,
    source: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    workflow: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    environment: env.PLAN_ENVIRONMENT,
    workspace: env.PLAN_WORKSPACE,
    scope: env.PLAN_SCOPE,
    artifact: env.PLAN_ARTIFACT_NAME,
    planHash: bytesHash(readFileSync("_infra/tfplan")),
  });
}
if (require.main === module) {
  try {
    writeFileSync(
      "_infra/plan-provenance.json",
      JSON.stringify(recordPlan(process.env)),
    );
  } catch {
    process.stderr.write(
      '{"status":"refused","reason":"plan_provenance_refused"}\n',
    );
    process.exitCode = 1;
  }
}
module.exports = { assertPlanProvenance, bytesHash, recordPlan };
