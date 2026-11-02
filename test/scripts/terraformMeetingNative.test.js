/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { verifyMeetingUpdatePlan } from "../../scripts/deployment/terraform-meeting-update.cjs";
import {
  nativeMeetingPlan,
  nativeEvidence,
  installationRecords,
  copyModelSource,
} from "../fixtures/deployment/terraformMeetingNative.js";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifySource } from "../../scripts/deployment/terraform-meeting-model.cjs";
import { identity } from "../fixtures/deployment/terraformMeetingUpdate.js";

test("committed AWS lock and post-init evidence pass the native delivery verifier", () => {
  const lock = execFileSync("git", [
    "show",
    "HEAD:_infra/.terraform.lock.hcl",
  ]).toString();
  const lockedVersion = lock.match(
    /provider "registry\.terraform\.io\/hashicorp\/aws" \{\s+version\s*=\s*"([^"]+)"/,
  )?.[1];
  expect(lockedVersion).toBeDefined();
  const output = installationRecords();
  const installed = JSON.parse(
    Buffer.from(output[1].stdout, "base64").toString(),
  );
  expect(
    installed.provider_selections["registry.terraform.io/hashicorp/aws"],
  ).toBe(lockedVersion);
  const plan = nativeMeetingPlan();
  expect(() =>
    verifyMeetingUpdatePlan(plan, identity, nativeEvidence(plan, { output })),
  ).not.toThrow();
});

test("native scoped shape needs source and installed-provider evidence", () => {
  const plan = nativeMeetingPlan();
  expect(plan.resource_changes).toHaveLength(32);
  expect(plan.checks).toHaveLength(19);
  expect(() => verifyMeetingUpdatePlan(plan, identity)).toThrow();
  expect(() =>
    verifyMeetingUpdatePlan(plan, identity, nativeEvidence(plan)),
  ).not.toThrow();
});

const table = (p) =>
  p.resource_changes.find(
    (r) => r.address === "aws_dynamodb_table.meeting_history_table",
  );
const blocks = (p) =>
  p.configuration.root_module.resources[0].expressions.global_secondary_index;
const check = (name, status = "unknown") => ({
  address: { kind: "var", name, to_display: `var.${name}` },
  status,
});
const verify = (plan) =>
  verifyMeetingUpdatePlan(plan, identity, nativeEvidence(plan));

test.each([
  [
    "reordered sets and static blocks",
    (p) => {
      p.resource_changes.reverse();
      p.checks.reverse();
      blocks(p).reverse();
      table(p).change.after.global_secondary_index.reverse();
    },
  ],
  [
    "known empty",
    (p) => {
      table(p).change.after_unknown = {};
      for (const index of table(p).change.after.global_secondary_index)
        index.warm_throughput = [];
    },
  ],
  [
    "known absent",
    (p) => {
      table(p).change.after_unknown = {};
    },
  ],
  [
    "absent before",
    (p) => {
      delete table(p).change.before.global_secondary_index[0].warm_throughput;
    },
  ],
  [
    "passed aggregates",
    (p) => {
      p.checks.forEach((c) => {
        c.status = "pass";
      });
    },
  ],
  [
    "passed relevant dependency",
    (p) => {
      p.checks.push({
        address: {
          kind: "resource",
          mode: "managed",
          type: "aws_kms_key",
          name: "app_general",
          to_display: "aws_kms_key.app_general",
        },
        status: "pass",
      });
    },
  ],
  [
    "passed resource instance",
    (p) => {
      p.checks[0].status = "pass";
      p.checks[0].instances = [
        {
          address: {
            to_display: p.checks[0].address.to_display + "[0]",
            instance_key: 0,
          },
          status: "pass",
        },
      ];
    },
  ],
  [
    "completed known no-op",
    (p) => {
      for (const r of p.resource_changes) {
        r.change.before = JSON.parse(JSON.stringify(r.change.after));
        r.change.actions = ["no-op"];
        r.change.after_unknown = {};
      }
    },
  ],
  [
    "completed no-op neutral warm representation",
    (p) => {
      for (const r of p.resource_changes) {
        r.change.before = JSON.parse(JSON.stringify(r.change.after));
        r.change.actions = ["no-op"];
        r.change.after_unknown = {};
      }
      table(p).change.before.global_secondary_index[0].warm_throughput = [];
    },
  ],
])("native model accepts %s", (_name, change) => {
  const p = nativeMeetingPlan();
  change(p);
  expect(() => verify(p)).not.toThrow();
});

test.each([
  [
    "unknown no-op dependency",
    (p) => {
      p.checks.push({
        address: {
          kind: "resource",
          mode: "managed",
          type: "aws_kms_key",
          name: "app_general",
          to_display: "aws_kms_key.app_general",
        },
        status: "unknown",
      });
    },
  ],
  ...[
    "project_name",
    "environment",
    "aws_region",
    "ENABLE_PROCESSING_RETRY_INDEX",
    "brand_new",
  ].map((name) => [
    `unknown ${name}`,
    (p) => {
      p.checks.push(check(name));
    },
  ]),
  [
    "new passed check",
    (p) => {
      p.checks.push(check("brand_new", "pass"));
    },
  ],
  [
    "duplicate check",
    (p) => {
      p.checks.push(p.checks[0]);
    },
  ],
  [
    "null checks",
    (p) => {
      p.checks = null;
    },
  ],
  [
    "last variable failed",
    (p) => {
      p.checks.at(-1).status = "fail";
    },
  ],
  [
    "last variable error",
    (p) => {
      p.checks.at(-1).status = "error";
    },
  ],
  [
    "malformed passed instance",
    (p) => {
      p.checks[0].status = "pass";
      p.checks[0].instances = [{ status: "pass" }];
    },
  ],
  [
    "duplicate passed instance",
    (p) => {
      p.checks[0].status = "pass";
      const instance = {
        address: { to_display: p.checks[0].address.to_display },
        status: "pass",
      };
      p.checks[0].instances = [instance, instance];
    },
  ],
  [
    "passed instance problem",
    (p) => {
      p.checks[0].status = "pass";
      p.checks[0].instances = [
        {
          address: { to_display: p.checks[0].address.to_display },
          status: "pass",
          problems: [{ message: "error" }],
        },
      ];
    },
  ],
  [
    "check metadata",
    (p) => {
      p.checks[0].address.name = "wrong";
    },
  ],
  [
    "check kind",
    (p) => {
      p.checks[0].address.kind = "output";
    },
  ],
  [
    "check extra key",
    (p) => {
      p.checks[0].unexpected = true;
    },
  ],
  [
    "unknown instances",
    (p) => {
      p.checks[0].instances = [];
    },
  ],
  ...["fail", "error", "pending", null].map((status) => [
    `check ${status}`,
    (p) => {
      p.checks[0].status = status;
    },
  ]),
  [
    "failed pass instance",
    (p) => {
      p.checks[0].status = "pass";
      p.checks[0].instances = [{ status: "fail" }];
    },
  ],
  ...["", "[0]", '["key"]'].map((suffix) => [
    `excluded resource ${suffix}`,
    (p) => {
      const r = JSON.parse(JSON.stringify(p.resource_changes[2]));
      r.address = p.checks[0].address.to_display + suffix;
      p.resource_changes.push(r);
    },
  ]),
  [
    "wrong provider",
    (p) => {
      p.resource_changes[2].provider_name = "registry.terraform.io/example/aws";
    },
  ],
  [
    "wrong resource name",
    (p) => {
      p.resource_changes[2].name = "wrong";
    },
  ],
  [
    "missing configuration",
    (p) => {
      delete p.configuration;
    },
  ],
  [
    "module",
    (p) => {
      p.configuration.root_module.module_calls = {};
    },
  ],
  [
    "missing table",
    (p) => {
      p.configuration.root_module.resources = [];
    },
  ],
  [
    "duplicate table",
    (p) => {
      p.configuration.root_module.resources.push(
        p.configuration.root_module.resources[0],
      );
    },
  ],
  [
    "duplicate index",
    (p) => {
      blocks(p)[1] = blocks(p)[0];
    },
  ],
  [
    "missing index",
    (p) => {
      blocks(p).pop();
    },
  ],
  [
    "mismatched index",
    (p) => {
      blocks(p)[0].hash_key.constant_value = "wrong";
    },
  ],
  [
    "referenced index",
    (p) => {
      blocks(p)[0].name = { references: ["var.name"] };
    },
  ],
  [
    "dynamic configuration",
    (p) => {
      p.configuration.root_module.resources[0].expressions.dynamic = {};
    },
  ],
  [
    "dynamic index expression",
    (p) => {
      p.configuration.root_module.resources[0].expressions.global_secondary_index =
        { references: ["var.indexes"] };
    },
  ],
  [
    "paid billing mode",
    (p) => {
      p.configuration.root_module.resources[0].expressions.billing_mode.constant_value =
        "PROVISIONED";
    },
  ],
  ...[true, "false", null, undefined].map((value) => [
    `retry flag ${value}`,
    (p) => {
      p.variables.ENABLE_PROCESSING_RETRY_INDEX.value = value;
    },
  ]),
  ...[
    "warm_throughput",
    "on_demand_throughput",
    "read_capacity",
    "write_capacity",
  ].flatMap((field) =>
    [
      null,
      [],
      { constant_value: null },
      { constant_value: [] },
      { references: ["var.capacity"] },
    ].map((value, i) => [
      `configured ${field} ${i}`,
      (p) => {
        blocks(p)[0][field] = value;
      },
    ]),
  ),
  ...["before", "after"].flatMap((phase) =>
    [null, [{ read_units_per_second: 1 }]].map((value, i) => [
      `non-neutral warm ${phase} ${i}`,
      (p) => {
        table(p).change[phase].global_secondary_index[0].warm_throughput =
          value;
      },
    ]),
  ),
  ...[
    "name",
    "hash_key",
    "range_key",
    "projection_type",
    "on_demand_throughput",
  ].map((field) => [
    `unknown index ${field}`,
    (p) => {
      table(p).change.after_unknown.global_secondary_index[0][field] = true;
    },
  ]),
  [
    "malformed warm mask",
    (p) => {
      table(p).change.after_unknown.global_secondary_index[0].warm_throughput =
        { units: true };
    },
  ],
  [
    "malformed resource mask",
    (p) => {
      table(p).change.after_unknown = [];
    },
  ],
  [
    "malformed no-op mask",
    (p) => {
      p.resource_changes[2].change.after_unknown = [];
    },
  ],
  [
    "malformed index mask",
    (p) => {
      table(p).change.after_unknown.global_secondary_index[0] = [];
    },
  ],
  [
    "known index change",
    (p) => {
      table(p).change.after.global_secondary_index[0].projection_type =
        "KEYS_ONLY";
    },
  ],
  [
    "provisioned capacity",
    (p) => {
      table(p).change.after.global_secondary_index[0].read_capacity = 10;
    },
  ],
  [
    "table throughput unknown",
    (p) => {
      table(p).change.after_unknown.warm_throughput = true;
    },
  ],
  [
    "table on-demand write",
    (p) => {
      table(p).change.after.on_demand_throughput = [
        { max_read_request_units: 1 },
      ];
    },
  ],
  [
    "unrelated write",
    (p) => {
      p.resource_changes[2].change.actions = ["update"];
    },
  ],
  [
    "unrelated unknown",
    (p) => {
      p.resource_changes[2].change.after_unknown.id = true;
    },
  ],
  ...["no-op", "read"].map((action) => [
    `data source ${action}`,
    (p) => {
      p.resource_changes[2].mode = "data";
      p.resource_changes[2].change.actions = [action];
    },
  ]),
  [
    "import",
    (p) => {
      table(p).change.importing = { id: "fake" };
    },
  ],
  [
    "move",
    (p) => {
      table(p).previous_address = "aws_dynamodb_table.old";
    },
  ],
  [
    "replacement",
    (p) => {
      table(p).change.replace_paths = [["name"]];
    },
  ],
  [
    "deferred",
    (p) => {
      p.deferred_changes = [{}];
    },
  ],
  [
    "invocation",
    (p) => {
      p.action_invocations = [{}];
    },
  ],
  [
    "incomplete completed state",
    (p) => {
      table(p).change.after.global_secondary_index.pop();
      table(p).change.before = JSON.parse(
        JSON.stringify(table(p).change.after),
      );
      table(p).change.actions = ["no-op"];
      table(p).change.after_unknown = {};
    },
  ],
])("native model refuses %s", (_name, change) => {
  const p = nativeMeetingPlan();
  change(p);
  expect(() => verify(p)).toThrow();
});

test.each([
  "missing",
  "pre-init",
  "failed-init",
  "writable-lock",
  "wrong-provider",
  "wrong-terraform",
  "raw-lock",
  "wrong-source",
])("refuses evidence: %s", (fault) => {
  const p = nativeMeetingPlan(),
    output = installationRecords(),
    overrides = { output };
  if (fault === "missing") output.pop();
  if (fault === "pre-init") output.reverse();
  if (fault === "failed-init") output[0].exitCode = 1;
  if (fault === "writable-lock") output[0].args.pop();
  if (fault === "raw-lock") overrides.lockfileSha256 = "0".repeat(64);
  if (fault === "wrong-source") overrides.sourceSha = "0".repeat(40);
  if (fault === "wrong-provider" || fault === "wrong-terraform") {
    const v = JSON.parse(Buffer.from(output[1].stdout, "base64").toString());
    if (fault === "wrong-provider")
      v.provider_selections["registry.terraform.io/hashicorp/aws"] = "6.69.1";
    else v.terraform_version = "1.16.0";
    output[1].stdout = Buffer.from(JSON.stringify(v)).toString("base64");
  }
  expect(() =>
    verifyMeetingUpdatePlan(p, identity, nativeEvidence(p, overrides)),
  ).toThrow();
});

test("proof is neither a caller boolean nor reusable for another rendering", () => {
  const p = nativeMeetingPlan(),
    proof = nativeEvidence(p);
  expect(() => verifyMeetingUpdatePlan(p, identity, true)).toThrow();
  expect(() =>
    verifyMeetingUpdatePlan(p, identity, { sourceModel: true }),
  ).toThrow();
  p.checks[0].status = "pass";
  expect(() => verifyMeetingUpdatePlan(p, identity, proof)).toThrow();
});

test.each([
  "changed-tf",
  "changed-lock",
  "removed",
  "override",
  "json-override",
  "module",
])("source contract refuses %s", (fault) => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-model-"));
  mkdirSync(join(directory, "_infra"));
  try {
    const sourceSha = copyModelSource(directory);
    const infra = (name) => join(directory, "_infra", name);
    if (fault === "removed") rmSync(infra("api.tf"));
    else if (fault === "override")
      writeFileSync(infra("override.tf"), "# override\n");
    else if (fault === "json-override")
      writeFileSync(infra("extra_override.tf.json"), "{}");
    else {
      const name = fault === "changed-lock" ? ".terraform.lock.hcl" : "main.tf";
      const added =
        fault === "module"
          ? '\nmodule "unreviewed" { source = "./other" }\n'
          : "\n# changed\n";
      writeFileSync(infra(name), readFileSync(infra(name), "utf8") + added);
    }
    expect(() => verifySource(directory, sourceSha)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source model alone tolerates LF/CRLF; raw lock digest still refuses a byte change", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-model-"));
  mkdirSync(join(directory, "_infra"));
  try {
    const sourceSha = copyModelSource(directory);
    const lock = join(directory, "_infra/.terraform.lock.hcl");
    const bytes = readFileSync(lock, "utf8");
    writeFileSync(
      lock,
      bytes.includes("\r\n")
        ? bytes.replace(/\r\n/g, "\n")
        : bytes.replace(/\n/g, "\r\n"),
    );
    expect(() => verifySource(directory, sourceSha)).not.toThrow();
    expect(() =>
      nativeEvidence(nativeMeetingPlan(), { directory, sourceSha }),
    ).toThrow(/Raw lock changed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source model refuses malformed UTF-8 before text normalization", () => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-model-"));
  mkdirSync(join(directory, "_infra"));
  try {
    const sourceSha = copyModelSource(directory);
    const file = join(directory, "_infra/main.tf");
    writeFileSync(
      file,
      Buffer.concat([readFileSync(file), Buffer.from([0xff])]),
    );
    expect(() => verifySource(directory, sourceSha)).toThrow(
      /Invalid UTF-8 Terraform source/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
