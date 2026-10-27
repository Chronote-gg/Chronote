import { executeTerraformDispatch } from "./terraformDispatchVm.js";
import * as fs from "node:fs";
import { runTerraform } from "../../../scripts/deployment/terraform-workflow.cjs";

// Execute the actual dispatcher and workflow. Only native transports are fixtures.
export async function dispatchTerraform(options) {
  const i = options.invocation;
  const event = {
    repository: { full_name: i.repository },
    inputs: {
      github_environment: i.environment,
      terraform_workspace: i.workspace,
      plan_scope: i.scope,
      ...(i.workflowPath === ".github/workflows/terraform-apply.yml"
        ? {
            plan_run_id: options.producerRunId,
            artifact_name: options.artifactName,
            plan_sha256: options.planSha256,
            bundle_sha256: options.bundleSha256,
            confirmation: "apply",
          }
        : {}),
    },
  };
  const fakeProcess = {
    env: {
      ...options.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: i.repository,
      GITHUB_SHA: i.sourceSha,
      GITHUB_WORKFLOW_SHA: i.sourceSha,
      GITHUB_REF: "refs/heads/master",
      GITHUB_WORKFLOW_REF: `${i.repository}/${i.workflowPath}@refs/heads/master`,
      GITHUB_RUN_ID: i.runId,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: "fixture-event",
      RUNNER_TEMP: options.directory,
      TERRAFORM_PRIVATE_STORAGE_JSON: JSON.stringify(options.binding),
      TERRAFORM_PLAN_REFERENCE_JSON: JSON.stringify(options.reference),
    },
    umask: () => {},
    cwd: () => options.directory,
    once: () => {},
    removeListener: () => {},
    exitCode: undefined,
  };
  const modules = {
    "node:fs": {
      ...fs,
      readFileSync: (path, ...args) =>
        path === "fixture-event"
          ? JSON.stringify(event)
          : fs.readFileSync(path, ...args),
    },
    "node:child_process": { execFileSync: () => i.sourceSha },
    "./terraform-native.cjs": { nativeGitHub: () => options.get },
    "./terraform-workflow.cjs": {
      runTerraform: (current) =>
        runTerraform({
          ...current,
          command: options.command,
          client: options.client,
        }),
    },
  };
  const messages = await executeTerraformDispatch(modules, fakeProcess);
  return JSON.parse(messages.at(-1));
}
