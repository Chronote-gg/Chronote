/** @jest-environment node */
import { test, expect } from "@jest/globals";
import assert from "node:assert/strict";
import {
  artifactIamBinding,
  artifactIamTargets,
  validateArtifactIamPlan,
} from "../../scripts/deployment/validate-artifact-iam-plan.cjs";
import { artifactIamFixture } from "../fixtures/deployment/artifactIamPlan.js";
import { excludedChecks } from "../../scripts/deployment/terraform-meeting-model.cjs";
import { copyModelSource } from "../fixtures/deployment/terraformMeetingNative.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

const validate = (f) => validateArtifactIamPlan(f.plan, artifactIamBinding(f));
test("TFVAR string overrides use the existing literal trimmed semantics", () => {
  const f = artifactIamFixture();
  f.variables.TFVAR_TRANSCRIPTS_BUCKET = "  approved-artifact-bucket  ";
  expect(artifactIamBinding(f).transcriptsBucket).toBe(
    "approved-artifact-bucket",
  );
  f.variables.TFVAR_TRANSCRIPTS_BUCKET = '"approved-artifact-bucket"';
  expect(() => artifactIamBinding(f)).toThrow();
});
test("empty string overrides retain the configured value", () => {
  const f = artifactIamFixture();
  f.variables.TFVAR_project_name = "  ";
  expect(artifactIamBinding(f).prefix).toBe("meeting-notes-sandbox");
});
test("the application key selector cannot name another account", () => {
  const f = artifactIamFixture();
  f.variables.ARTIFACT_APP_KMS_KEY_ARN =
    "arn:aws:kms:us-east-1:999999999999:key/22222222-2222-4222-8222-222222222222";
  expect(() => artifactIamBinding(f)).toThrow();
});
test("the transcript key may differ from the private capture key", () => {
  const f = artifactIamFixture();
  const key =
    "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-4222-8222-222222222222";
  f.variables.ARTIFACT_APP_KMS_KEY_ARN = key;
  const state = f.plan.resource_changes.find(
    (r) => r.address === "aws_kms_key.app_general",
  );
  state.change.before.arn = state.change.after.arn = key;
  const encryption = f.plan.resource_changes.find(
    (r) =>
      r.address ===
      "aws_s3_bucket_server_side_encryption_configuration.transcripts",
  );
  for (const value of [encryption.change.before, encryption.change.after])
    value.rule[0].apply_server_side_encryption_by_default[0].kms_master_key_id =
      key;
  expect(validate(f).result).toBe("accepted");
});

test.each(["bound", "source_changed", "relevant_unknown", "catalog_missing"])(
  "targeted check evidence: %s",
  (kind) => {
    const f = artifactIamFixture();
    f.plan.checks = excludedChecks.map((address) => {
      const passed = [
        "aws_iam_role.sandbox_deploy",
        "var.ENABLE_API_ALB",
      ].includes(address.to_display);
      return {
        address: JSON.parse(JSON.stringify(address)),
        status: passed ? "pass" : "unknown",
        ...(passed
          ? {
              instances: [
                {
                  address: {
                    to_display:
                      address.kind === "var"
                        ? address.to_display
                        : `${address.to_display}[0]`,
                    ...(address.kind === "var" ? {} : { instance_key: 0 }),
                  },
                  status: "pass",
                },
              ],
            }
          : {}),
      };
    });
    const directory = mkdtempSync(join(tmpdir(), "artifact-iam-source-"));
    mkdirSync(join(directory, "_infra"));
    try {
      const sourceSha = copyModelSource(directory);
      if (kind === "source_changed") {
        const file = join(directory, "_infra/main.tf");
        writeFileSync(file, readFileSync(file, "utf8") + "\n# changed\n");
      }
      if (kind === "relevant_unknown") {
        const check = f.plan.checks.find(
          (c) => c.address.to_display === "var.ENABLE_API_ALB",
        );
        check.status = "unknown";
        delete check.instances;
      }
      if (kind === "catalog_missing") f.plan.checks.pop();
      const run = () =>
        validateArtifactIamPlan(f.plan, artifactIamBinding(f), {
          directory,
          sourceSha,
        });
      if (kind === "bound") expect(run().result).toBe("accepted");
      else expect(run).toThrow();
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.match(basename(directory), /^artifact-iam-source-/);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test.each(["github_environment", "ENABLE_API_ALB", "terraform_version"])(
  "refuses a mismatched %s",
  (field) => {
    const f = artifactIamFixture();
    if (field === "terraform_version") f.plan.terraform_version = "1.16.0";
    else
      f.plan.variables[field] = {
        value: field === "ENABLE_API_ALB" ? false : "production",
      };
    expect(() => validate(f)).toThrow();
  },
);
test.each(["sandbox", "production"])(
  "only the two bound %s policy additions are accepted",
  (environment) => {
    const f = artifactIamFixture(environment);
    expect(validate(f)).toEqual({
      result: "accepted",
      changes: [
        { address: "aws_iam_policy.transcripts_s3_policy", action: "update" },
        { address: f.deployAddress, action: "update" },
      ],
    });
    expect([...artifactIamTargets(environment).keys()]).toEqual([
      "aws_iam_policy.transcripts_s3_policy",
      f.deployAddress,
    ]);
  },
);
test("installed permissions are verified on a no-op", () => {
  const f = artifactIamFixture();
  for (const r of f.plan.resource_changes.slice(0, 2)) {
    r.change.before = structuredClone(r.change.after);
    r.change.actions = ["no-op"];
  }
  expect(validate(f).changes).toEqual([]);
  const policy = JSON.parse(f.plan.resource_changes[0].change.after.policy);
  policy.Statement[0].Action = policy.Statement[0].Action.filter(
    (a) => a !== "s3:GetObjectVersion",
  );
  f.plan.resource_changes[0].change.before.policy =
    f.plan.resource_changes[0].change.after.policy = JSON.stringify(policy);
  expect(() => validate(f)).toThrow();
});
test.each([
  [
    "history write",
    (f) => {
      const r = f.plan.resource_changes[1];
      const p = JSON.parse(r.change.after.policy);
      p.Statement.at(-1).Action.push("dynamodb:UpdateItem");
      r.change.after.policy = JSON.stringify(p);
    },
  ],
  [
    "foreign bucket",
    (f) => {
      const r = f.plan.resource_changes[0];
      const p = JSON.parse(r.change.after.policy);
      p.Statement[0].Resource.push("arn:aws:s3:::foreign/*");
      r.change.after.policy = JSON.stringify(p);
    },
  ],
  [
    "unrelated permission",
    (f) => {
      const r = f.plan.resource_changes[1];
      const p = JSON.parse(r.change.after.policy);
      p.Statement[0].Action.push("ecs:UpdateService");
      r.change.after.policy = JSON.stringify(p);
    },
  ],
  [
    "unknown policy",
    (f) => {
      f.plan.resource_changes[0].change.after_unknown.policy = true;
    },
  ],
  [
    "replacement",
    (f) => {
      f.plan.resource_changes[0].change.actions = ["delete", "create"];
    },
  ],
  [
    "import",
    (f) => {
      f.plan.resource_changes[0].change.importing = { id: "foreign" };
    },
  ],
  [
    "move",
    (f) => {
      f.plan.resource_changes[0].previous_address = "old.policy";
    },
  ],
  [
    "duplicate",
    (f) => {
      f.plan.resource_changes.push(structuredClone(f.plan.resource_changes[0]));
    },
  ],
  [
    "wrong role",
    (f) => {
      f.plan.resource_changes[1].change.after.role = "foreign";
    },
  ],
  [
    "foreign account",
    (f) => {
      f.variables.AWS_ACCOUNT_ID = "999999999999";
    },
  ],
  [
    "wrong workspace",
    (f) => {
      f.invocation.workspace = "default";
    },
  ],
  [
    "changed attachment",
    (f) => {
      f.plan.resource_changes.find(
        (r) =>
          r.address ===
          "aws_iam_role_policy_attachment.ecs_task_transcripts_policy",
      ).change.after.role = "foreign";
    },
  ],
  [
    "changed encryption",
    (f) => {
      f.plan.resource_changes.find(
        (r) =>
          r.address ===
          "aws_s3_bucket_server_side_encryption_configuration.transcripts",
      ).change.after.rule = [];
    },
  ],
  [
    "foreign site change",
    (f) => {
      f.plan.resource_changes.push(
        f.resource(
          "aws_iam_policy.site_publishing[0]",
          { policy: "{}" },
          "update",
        ),
      );
    },
  ],
  [
    "foreign no-op",
    (f) => {
      f.plan.resource_changes.push(
        f.resource("aws_iam_role.foreign", { arn: "foreign" }),
      );
    },
  ],
  [
    "relevant unknown check",
    (f) => {
      f.plan.checks = [
        {
          address: {
            kind: "resource",
            mode: "managed",
            type: "aws_iam_role",
            name: "sandbox_deploy",
            to_display: "aws_iam_role.sandbox_deploy",
          },
          status: "unknown",
        },
      ];
    },
  ],
])("refuses %s", (_name, mutate) => {
  const f = artifactIamFixture();
  mutate(f);
  expect(() => validate(f)).toThrow();
});
test("policy JSON ordering does not add permission", () => {
  const f = artifactIamFixture();
  for (const r of f.plan.resource_changes.slice(0, 2)) {
    const p = JSON.parse(r.change.after.policy);
    p.Statement.reverse();
    for (const s of p.Statement)
      if (Array.isArray(s.Action)) s.Action.reverse();
    r.change.after.policy = JSON.stringify(p, null, 2);
  }
  expect(validate(f).result).toBe("accepted");
});

test("missing relevant checks cannot bypass the artifact scope", () => {
  const f = artifactIamFixture();
  f.plan.checks = [];
  expect(() => validate(f)).toThrow(/Missing required artifact IAM check/);
});
