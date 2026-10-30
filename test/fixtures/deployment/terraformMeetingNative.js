import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { meetingUpdatePlan } from "./terraformMeetingUpdate.js";
import {
  closure,
  excludedChecks,
  meetingModelEvidence,
} from "../../../scripts/deployment/terraform-meeting-model.cjs";
import { digest } from "../../../scripts/deployment/collector-payload.cjs";

// Constructed from the public mock fixture and source addresses, never a private plan.
export function nativeMeetingPlan() {
  const plan = JSON.parse(JSON.stringify(meetingUpdatePlan()));
  plan.terraform_version = "1.17.1";
  plan.variables = { ENABLE_PROCESSING_RETRY_INDEX: { value: false } };
  plan.checks = excludedChecks.map((address) => ({
    address: { ...address },
    status: "unknown",
  }));
  for (const address of closure) {
    if (plan.resource_changes.some((r) => r.address === address)) continue;
    const [type, name] = address.split(".");
    plan.resource_changes.push({
      address,
      mode: "managed",
      type,
      name,
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: {
        actions: ["no-op"],
        before: { id: `synthetic-${name}` },
        after: { id: `synthetic-${name}` },
        after_unknown: {},
      },
    });
  }
  const table = plan.resource_changes[0];
  const fields = ["name", "hash_key", "range_key", "projection_type"];
  plan.configuration = {
    root_module: {
      resources: [
        {
          address: table.address,
          mode: table.mode,
          type: table.type,
          name: table.name,
          provider_config_key: "aws",
          expressions: {
            billing_mode: { constant_value: "PAY_PER_REQUEST" },
            global_secondary_index:
              table.change.after.global_secondary_index.map((index) =>
                Object.fromEntries(
                  fields.map((key) => [key, { constant_value: index[key] }]),
                ),
              ),
          },
        },
      ],
    },
  };
  table.change.after_unknown = {
    global_secondary_index: table.change.after.global_secondary_index.map(
      () => ({
        warm_throughput: true,
        key_schema: true,
        read_capacity: true,
        write_capacity: true,
      }),
    ),
  };
  for (const index of table.change.after.global_secondary_index)
    delete index.warm_throughput;
  return plan;
}
export function installationRecords() {
  return [
    {
      command: "terraform",
      args: ["-chdir=_infra", "init", "-input=false", "-lockfile=readonly"],
      outcome: "exited",
      exitCode: 0,
    },
    {
      command: "terraform",
      args: ["-chdir=_infra", "version", "-json"],
      outcome: "exited",
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({
          terraform_version: "1.17.1",
          provider_selections: {
            "registry.terraform.io/hashicorp/aws": "6.69.1",
          },
        }),
      ).toString("base64"),
    },
  ];
}
export function nativeEvidence(plan, overrides = {}) {
  const directory = resolve(".");
  return meetingModelEvidence(plan, {
    directory,
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory })
      .toString()
      .trim(),
    lockfileSha256: digest(readFileSync(resolve("_infra/.terraform.lock.hcl"))),
    output: installationRecords(),
    ...overrides,
  });
}

export function copyModelSource(directory) {
  for (const name of readdirSync(resolve("_infra")))
    if (/\.tf(?:\.json)?$/.test(name) || name === ".terraform.lock.hcl")
      copyFileSync(resolve("_infra", name), join(directory, "_infra", name));
  // Read-only Git metadata reference; tests never write this repository's index.
  const gitdir = execFileSync("git", ["rev-parse", "--absolute-git-dir"])
    .toString()
    .trim();
  writeFileSync(join(directory, ".git"), `gitdir: ${gitdir}\n`);
  return execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
}
